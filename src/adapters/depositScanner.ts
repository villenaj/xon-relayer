// The loop every adapter runs: resume from the checkpoint, scan the source chain's logs up to the
// safe head in chunks, settle each deposit in order, checkpoint as it goes. Each adapter only
// supplies how to read a deposit out of a log and how to check/settle it (a DepositSource).
//
// Settling is strictly in order: a deposit that fails for a transient reason stalls the scan at
// its block (the checkpoint stops there, and it's retried next poll) so nothing behind it can be
// skipped over; one that can never succeed is recorded and passed over, so it can't block the
// deposits behind it forever.

import type { JsonRpcProvider, Log, TransactionReceipt } from "ethers";
import path from "node:path";
import { describeConfirmations, getSafeHead, scanLogs, type Confirmations } from "../chain.js";
import { makeCheckpoint } from "../checkpoint.js";
import { classifySettleError, describeError } from "../errorClassifier.js";
import type { AdapterContext } from "./types.js";

export interface Deposit {
  buyer: string;
  usdtAmount: bigint;
  sourceChain: string;
  sourceTxHash: string;
  depositId: string;
  sourceBlock: number;
}

/// What to do with a deposit before trying to settle it.
export type Gate =
  | { action: "settle"; release?: () => void } // go ahead; `release` undoes any reservation if it fails
  | { action: "skip" } // pass over it (the gate has recorded why)
  | { action: "stall" }; // stop here and retry from this deposit next poll

export interface DepositSource {
  label: string;
  /// Shown in the startup log line, e.g. "USDT (0x...) transfers into 0x...".
  description: string;
  provider: JsonRpcProvider;
  /// Contract whose logs carry the deposits, and the event topic to fetch.
  logAddress: string;
  topic: string;
  confirmations: Confirmations;
  checkpointFile: string;
  checkpointIdentity: string;
  /// Where to start with no checkpoint, and the env var it came from (for the log).
  startBlock: number | null;
  startBlockName: string;
  /// The deposit in this log, or null if the log isn't one (e.g. a transfer to someone else).
  parse(log: Log): Deposit | null;
  isSettled(deposit: Deposit): Promise<boolean>;
  settle(deposit: Deposit): Promise<TransactionReceipt>;
  gate?(deposit: Deposit): Gate;
}

export interface DepositScanner {
  /// One poll: settles everything up to the safe head it can. Returns how many blocks it's still
  /// behind (0 = caught up).
  tick(): Promise<number>;
}

export async function createDepositScanner(context: AdapterContext, source: DepositSource): Promise<DepositScanner> {
  const { settlement, config, ledger, shutdown } = context;
  const { label, provider } = source;
  const checkpoint = makeCheckpoint<number>(path.join(config.checkpointDir, source.checkpointFile), source.checkpointIdentity);

  console.log(`[${label}] Watching ${source.description}, settling after ${describeConfirmations(source.confirmations)}`);

  // Fail at startup, not on every poll, if this RPC can't serve the confirmation policy (e.g. it
  // doesn't support the "finalized" tag) - otherwise the adapter would just sit there stalled.
  try {
    await getSafeHead(provider, source.confirmations);
  } catch (err) {
    throw new Error(`[${label}] Can't find the safe head with ${describeConfirmations(source.confirmations)}: ${describeError(err)}`);
  }

  const checkpointed = checkpoint.load();
  let fromBlock: number;
  if (checkpointed !== null) {
    fromBlock = checkpointed;
    console.log(`[${label}] Resuming from checkpoint: block ${fromBlock}.`);
  } else if (source.startBlock !== null) {
    fromBlock = source.startBlock;
    console.log(`[${label}] No checkpoint. Starting from ${source.startBlockName}=${fromBlock}.`);
  } else {
    fromBlock = (await provider.getBlockNumber()) + 1;
    console.warn(`[${label}] No checkpoint/start block - starting from current block (${fromBlock}). Pre-existing deposits will be missed.`);
  }

  // Settles each deposit in order; returns the block of the first one that needs retrying (or
  // that shutdown interrupted before), if any.
  async function settleLogs(logs: Log[]): Promise<number | null> {
    for (const log of logs) {
      const deposit = source.parse(log);
      if (!deposit) continue;
      if (shutdown.requested) return log.blockNumber;
      const tx = deposit.sourceTxHash;

      if (await source.isSettled(deposit)) {
        console.log(`[${label}] Skipping ${tx} - already settled.`);
        continue;
      }

      const gate = source.gate?.(deposit) ?? { action: "settle" };
      if (gate.action === "skip") continue;
      if (gate.action === "stall") return log.blockNumber;

      const entry = { adapter: label, ...deposit };
      try {
        const receipt = await source.settle(deposit);
        ledger.record({ ...entry, status: "settled", settleTxHash: receipt.hash, settleBlock: receipt.blockNumber });
      } catch (err) {
        gate.release?.();
        const { kind, name } = classifySettleError(settlement.vending, err);
        if (kind === "already-done") {
          console.log(`[${label}] ${tx} was already settled by another attempt (${name}) - continuing.`);
          ledger.record({ ...entry, status: "already-settled", error: name });
          continue;
        }
        if (kind === "permanent") {
          console.error(`[${label}] Permanently skipping ${tx} - reverted with ${name}, which can never succeed by retrying.`);
          ledger.record({ ...entry, status: "skipped", error: name });
          continue;
        }
        console.error(`[${label}] Failed to settle ${tx} (${name ?? "unknown"}), will retry next tick:`, describeError(err));
        ledger.record({ ...entry, status: "failed", error: name, message: describeError(err) });
        return log.blockNumber;
      }
    }
    return null;
  }

  return {
    async tick() {
      const toBlock = await getSafeHead(provider, source.confirmations);
      const scan = { provider, address: source.logAddress, topic: source.topic, chunkSize: config.logChunkSize };
      const next = await scanLogs(scan, fromBlock, toBlock, settleLogs, (n) => {
        fromBlock = n;
        checkpoint.save(n);
      }, () => shutdown.requested);
      return Math.max(0, toBlock - next + 1);
    },
  };
}

/// Runs the scanner every POLL_INTERVAL_MS until shutdown is requested, reporting each poll to
/// telemetry. Only failures before the loop starts (bad config, unreachable RPC at startup)
/// propagate - a failed poll is logged and retried.
export async function runDepositScanner(context: AdapterContext, source: DepositSource): Promise<void> {
  const { config, telemetry, shutdown } = context;
  const scanner = await createDepositScanner(context, source);
  telemetry.registerAdapter(source.label);
  while (!shutdown.requested) {
    try {
      telemetry.tickSucceeded(source.label, await scanner.tick());
    } catch (err) {
      telemetry.tickFailed(source.label);
      console.error(`[${source.label}] Poll tick failed:`, describeError(err));
    }
    await shutdown.sleep(config.pollIntervalMs);
  }
  console.log(`[${source.label}] Stopped.`);
}
