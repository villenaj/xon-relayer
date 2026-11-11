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
import { classifySettleError, describeError, type SettleErrorClassification } from "../errorClassifier.js";
import { AwaitingQuorumError, depositIdAt } from "../settlement.js";
import type { AdapterContext } from "./types.js";

export interface Deposit {
  buyer: string;
  usdtAmount: bigint;
  sourceChain: string;
  sourceTxHash: string;
  /// Position among this tx's deposits, 0-based - most txs carry exactly one.
  depositIndex: number;
  depositId: string;
  sourceBlock: number;
  /// The deposit log's index within its block.
  sourceLogIndex: number;
  /// Set for a market-price deposit (gateway `SwapDeposited`): the least XON (18-decimal units)
  /// the buyer accepts. Absent for a fixed-rate one.
  minXonOut?: bigint;
  /// Gateway deposits: the gateway's own deposit nonce (from the event), which `refund` keys on.
  gatewayNonce?: bigint;
}

/// A deposit as read from its log, before the scanner works out its position within the tx.
export type ParsedDeposit = Omit<Deposit, "depositIndex" | "depositId" | "sourceLogIndex">;

/// A second opinion on a deposit before paying it (see crossCheck.ts): go ahead, or wait - and if
/// the sources disagree outright rather than one lagging, say so loudly.
export type Verdict = { ok: true } | { ok: false; reason: string; mismatch: boolean };

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
  /// Contract whose logs carry the deposits, and the event topic(s) to fetch (several: any of them).
  logAddress: string;
  topic: string | string[];
  confirmations: Confirmations;
  checkpointFile: string;
  checkpointIdentity: string;
  /// Where to start with no checkpoint, and the env var it came from (for the log).
  startBlock: number | null;
  startBlockName: string;
  /// The deposit in this log, or null if the log isn't one (e.g. a transfer to someone else).
  parse(log: Log): ParsedDeposit | null;
  /// The id the contract tracks a tx's first deposit under; later ones derive from it (depositIdAt).
  baseDepositId(sourceTxHash: string): string;
  isSettled(deposit: Deposit): Promise<boolean>;
  settle(deposit: Deposit): Promise<TransactionReceipt>;
  gate?(deposit: Deposit): Gate;
  /// Checked after isSettled and before gate (so a deposit that's waiting reserves no cap): not
  /// ok stalls the adapter here, as a transient failure would.
  verify?(deposit: Deposit, log: Log): Promise<Verdict>;
  /// A second look at a failed settle the revert data couldn't explain (a market-price swap fails
  /// with the XCM precompile's generic error, whatever the cause). Return null to keep the default.
  diagnose?(deposit: Deposit, failure: SettleErrorClassification): Promise<(SettleErrorClassification & { detail: string }) | null>;
}

export interface DepositScanner {
  /// One poll: settles everything up to the safe head it can. Returns how many blocks it's still
  /// behind (0 = caught up).
  tick(): Promise<number>;
}

/// A deposit that keeps failing the same way gets a fresh "failed" ledger line at most this often -
/// the console still logs every attempt. One line per poll (every 5s) grew the ledger by ~17k lines a
/// day per stuck deposit, and everything that reads the ledger reads all of it.
export const FAILED_RECORD_INTERVAL_MS = 10 * 60_000;

export async function createDepositScanner(context: AdapterContext, source: DepositSource): Promise<DepositScanner> {
  const { settlement, config, ledger, alerts, shutdown, telemetry } = context;
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

  // Deposits this run has already held or skipped (and recorded and alerted on). A stall makes the
  // next poll rescan its whole block, which would otherwise hold/alert/record them all over again.
  const passedOver = new Set<string>();
  const lastFailure = new Map<string, { name: string | null; at: number }>();
  const mismatchAlerted = new Set<string>();
  function recordFailure(entry: Parameters<typeof ledger.record>[0]): void {
    const previous = lastFailure.get(entry.depositId);
    const now = Date.now();
    if (previous && previous.name === (entry.error ?? null) && now - previous.at < FAILED_RECORD_INTERVAL_MS) {
      telemetry.settleAttempt(label, "failed"); // still counted, just not written again
      return;
    }
    lastFailure.set(entry.depositId, { name: entry.error ?? null, at: now });
    ledger.record(entry);
  }

  // Settles each deposit in order; returns the block of the first one that needs retrying (or
  // that shutdown interrupted before), if any.
  async function settleLogs(logs: Log[]): Promise<number | null> {
    // A deposit's id depends on its position within its tx, so number them in log order. A tx sits
    // in one block, and a scan (or a retry after a stall) always covers whole blocks, so every
    // deposit of a tx is numbered within the same call.
    const ordered = [...logs].sort((a, b) => a.blockNumber - b.blockNumber || (a.index ?? 0) - (b.index ?? 0));
    const depositsSeen = new Map<string, number>();
    for (const log of ordered) {
      const parsed = source.parse(log);
      if (!parsed) continue;
      const depositIndex = depositsSeen.get(parsed.sourceTxHash) ?? 0;
      depositsSeen.set(parsed.sourceTxHash, depositIndex + 1);
      const deposit: Deposit = {
        ...parsed, depositIndex, sourceLogIndex: log.index,
        depositId: depositIdAt(source.baseDepositId(parsed.sourceTxHash), depositIndex),
      };
      if (shutdown.requested) return log.blockNumber;
      const tx = deposit.sourceTxHash;
      if (passedOver.has(deposit.depositId)) continue;

      if (await source.isSettled(deposit)) {
        console.log(`[${label}] Skipping ${tx} - already settled.`);
        lastFailure.delete(deposit.depositId);
        continue;
      }

      if (source.verify) {
        const verdict = await source.verify(deposit, log);
        if (!verdict.ok) {
          if (verdict.mismatch && !mismatchAlerted.has(deposit.depositId)) {
            mismatchAlerted.add(deposit.depositId);
            alerts.send(`[${label}] NOT paying ${tx}${deposit.depositIndex > 0 ? ` #${deposit.depositIndex}` : ""}: ${verdict.reason}. The adapter waits here until the RPCs agree - check them.`);
          } else {
            console.warn(`[${label}] Waiting on ${tx}: ${verdict.reason}.`);
          }
          return log.blockNumber;
        }
      }

      const gate = source.gate?.(deposit) ?? { action: "settle" };
      if (gate.action === "skip") {
        passedOver.add(deposit.depositId);
        continue;
      }
      if (gate.action === "stall") return log.blockNumber;

      const entry = { adapter: label, ...deposit };
      try {
        const receipt = await source.settle(deposit);
        ledger.record({ ...entry, status: "settled", settleTxHash: receipt.hash, settleBlock: receipt.blockNumber });
        lastFailure.delete(deposit.depositId);
      } catch (err) {
        // A settle that errored may still have landed: the RPC can lose the receipt (Xode's
        // eth-rpc does for blocks it fails to decode, e.g. after a runtime upgrade until it's
        // restarted). Ask the contract before anything else - a paid deposit recorded as skipped
        // would go on the refund list and be paid twice. Keep its cap reservation: it was paid.
        if (await source.isSettled(deposit).catch(() => false)) {
          console.warn(`[${label}] Settling ${tx} reported an error, but it's settled on-chain - recording it as already settled:`, describeError(err));
          ledger.record({ ...entry, status: "already-settled", error: "SettledDespiteError", message: describeError(err) });
          continue;
        }
        gate.release?.();
        if (err instanceof AwaitingQuorumError) {
          // Voted; the other attesters haven't yet. Not a failure - come back to it next tick.
          console.log(`[${label}] ${tx}: ${err.message}`);
          return log.blockNumber;
        }
        let { kind, name } = classifySettleError(settlement.vending, err);
        if (kind === "transient" && source.diagnose) {
          try {
            const diagnosis = await source.diagnose(deposit, { kind, name });
            if (diagnosis) {
              console.warn(`[${label}] ${tx}: ${diagnosis.detail}.`);
              ({ kind, name } = diagnosis);
            }
          } catch (diagnoseErr) {
            // Can't tell why - keep retrying rather than give up on the deposit.
            console.error(`[${label}] Couldn't diagnose the failed settle of ${tx}:`, describeError(diagnoseErr));
          }
        }
        if (kind !== "transient") passedOver.add(deposit.depositId);
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
        if (kind === "held") {
          const release = `npm run settle-held -- ${tx}${deposit.depositIndex > 0 ? ` --index ${deposit.depositIndex}` : ""}`;
          const why = name === "FixedRatePaused"
            ? "the fixed-rate paths are paused (the fixed rate is off the DEX price). Pay it once they're resumed"
            : name === "OverAddressDailyLimit"
              ? "it's over this buyer's per-address daily limit. Pay it once that has refilled (or the limit is raised - a queued change)"
              : "it's over XonVendingMachine's own limit. Raise the limit (setExternalLimits / setNativeLimits - a queued change), then pay it";
          alerts.send(`[${label}] Held deposit ${tx}: ${name} - ${why}: ${release}`);
          ledger.record({ ...entry, status: "held", error: name });
          continue;
        }
        console.error(`[${label}] Failed to settle ${tx} (${name ?? "unknown"}), will retry next tick:`, describeError(err));
        recordFailure({ ...entry, status: "failed", error: name, message: describeError(err) });
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
