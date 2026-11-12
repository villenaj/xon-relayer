// The loop every adapter runs: resume from the checkpoint, scan the source chain's logs up to the
// safe head in chunks, settle each deposit in order, checkpoint as it goes. Each adapter only
// supplies how to read a deposit out of a log and how to check/settle it (a DepositSource).
//
// Each deposit is settled on its own: one that fails for a transient reason waits and is retried
// later while the scan carries on with the ones behind it (the checkpoint stays at the oldest one
// waiting, so a restart finds it again); one that can never succeed is recorded and passed over.

import type { JsonRpcProvider, Log, TransactionReceipt } from "ethers";
import path from "node:path";
import { describeConfirmations, getSafeHead, scanLogs, type Confirmations } from "../chain.js";
import { makeCheckpoint } from "../checkpoint.js";
import { readLedger } from "../ledger.js";
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
  /// Set for a fixed-rate gateway deposit (`Deposited`): the least XON (18-decimal units) the
  /// depositor accepts at the fixed rate. Below it, the deposit is refunded rather than paid.
  fixedMinXonOut?: bigint;
  /// Gateway deposits: the gateway's own deposit nonce (from the event), which `refund` keys on.
  gatewayNonce?: bigint;
  /// Gateway deposits: who made the deposit on the source chain - where a refund goes.
  depositor?: string;
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
  | { action: "stall" }; // not now: retry this deposit later (the ones after it carry on)

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
  /// Whether `isSettled` means paid out (as opposed to, say, refunded on the gateway). Only then
  /// is a deposit this instance didn't settle itself recorded as paid by someone else.
  isPaidOut?(deposit: Deposit): Promise<boolean>;
  /// Told about each deposit given up on for good (recorded "skipped", with the error's name) -
  /// where a gateway adapter starts its refund.
  onSkipped?(deposit: Deposit, error: string | null): void;
  /// Runs after every poll, for work that isn't settling deposits. Its failures are logged only.
  afterTick?(): Promise<void>;
  /// Told about each deposit found paid out by someone else (another attester's instance), once,
  /// so it counts against this instance's payout caps too.
  onPaidElsewhere?(deposit: Deposit): void;
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
  // Deposits the ledger already has an outcome for. With several attesters, each running its own
  // instance, most payouts are executed by another instance: those are recorded here too (once),
  // so this instance's ledger, its 24h payout cap and `npm run reconcile` see every payout - not
  // just the ones it happened to execute itself.
  const recorded = new Set<string>(
    (config.ledgerFile ? readLedger(config.ledgerFile) : [])
      .filter((r) => r.status === "settled" || r.status === "already-settled")
      .map((r) => r.depositId.toLowerCase()),
  );
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

  // Deposits that couldn't be settled yet (a transient failure, waiting on the other attesters, a
  // second RPC that hasn't caught up, a cap that has to refill) wait here and are retried on their
  // own, with a growing delay - the scan carries on past them, so one stuck deposit never holds up
  // the ones behind it. Order doesn't matter for safety: the contract pays each deposit id once.
  //
  // Kept in memory only. The checkpoint never moves past the oldest waiting deposit's block, so a
  // restart rescans from there and finds them all again (the ones settled since are skipped).
  const waiting = new Map<string, { deposit: Deposit; log: Log; attempts: number; nextAt: number; since: number; alerted: boolean }>();
  let scannedTo = fromBlock; // next block to scan
  const MAX_RETRY_DELAY_MS = 5 * 60_000;
  /// A deposit still waiting after this long is alerted on, once.
  const WAITING_ALERT_MS = 30 * 60_000;

  function saveCheckpoint(): void {
    let resume = scannedTo;
    for (const { deposit } of waiting.values()) resume = Math.min(resume, deposit.sourceBlock);
    fromBlock = resume;
    checkpoint.save(resume);
  }

  function defer(deposit: Deposit, log: Log): void {
    const entry = waiting.get(deposit.depositId) ?? { deposit, log, attempts: 0, nextAt: 0, since: Date.now(), alerted: false };
    entry.attempts++;
    if (!entry.alerted && Date.now() - entry.since >= WAITING_ALERT_MS) {
      entry.alerted = true;
      const reason = lastFailure.get(deposit.depositId)?.name;
      alerts.send(`[${label}] Deposit ${deposit.sourceTxHash}${deposit.depositIndex > 0 ? ` #${deposit.depositIndex}` : ""} has been waiting to be paid for ${Math.round((Date.now() - entry.since) / 60_000)} min${reason ? ` (${reason})` : ""}. It's retried automatically and the deposits after it aren't held up - check why it can't settle.`);
    }
    entry.nextAt = Date.now() + Math.min(config.pollIntervalMs * 2 ** Math.min(entry.attempts - 1, 20), MAX_RETRY_DELAY_MS);
    if (!waiting.has(deposit.depositId)) console.log(`[${label}] ${deposit.sourceTxHash} waits for a retry; carrying on with the deposits after it (${waiting.size + 1} waiting).`);
    waiting.set(deposit.depositId, entry);
  }

  // One attempt at one deposit. True: it's resolved (settled, already settled, skipped or held).
  // False: it has to be tried again later.
  async function attempt(deposit: Deposit, log: Log): Promise<boolean> {
    const tx = deposit.sourceTxHash;

    if (await source.isSettled(deposit)) {
      console.log(`[${label}] Skipping ${tx} - already settled.`);
      lastFailure.delete(deposit.depositId);
      if (!recorded.has(deposit.depositId.toLowerCase()) && (await source.isPaidOut?.(deposit))) {
        recorded.add(deposit.depositId.toLowerCase());
        ledger.record({ adapter: label, ...deposit, status: "already-settled", error: "SettledElsewhere" });
        source.onPaidElsewhere?.(deposit);
      }
      return true;
    }

    if (source.verify) {
      const verdict = await source.verify(deposit, log);
      if (!verdict.ok) {
        if (verdict.mismatch && !mismatchAlerted.has(deposit.depositId)) {
          mismatchAlerted.add(deposit.depositId);
          alerts.send(`[${label}] NOT paying ${tx}${deposit.depositIndex > 0 ? ` #${deposit.depositIndex}` : ""}: ${verdict.reason}. It waits until the RPCs agree - check them.`);
        } else {
          console.warn(`[${label}] Waiting on ${tx}: ${verdict.reason}.`);
        }
        return false;
      }
    }

    const gate = source.gate?.(deposit) ?? { action: "settle" };
    if (gate.action === "skip") {
      passedOver.add(deposit.depositId);
      return true;
    }
    if (gate.action === "stall") return false;

    const entry = { adapter: label, ...deposit };
    try {
      const receipt = await source.settle(deposit);
      ledger.record({ ...entry, status: "settled", settleTxHash: receipt.hash, settleBlock: receipt.blockNumber });
      recorded.add(deposit.depositId.toLowerCase());
      lastFailure.delete(deposit.depositId);
      return true;
    } catch (err) {
      // A settle that errored may still have landed: the RPC can lose the receipt (Xode's
      // eth-rpc does for blocks it fails to decode, e.g. after a runtime upgrade until it's
      // restarted). Ask the contract before anything else - a paid deposit recorded as skipped
      // would go on the refund list and be paid twice. Keep its cap reservation: it was paid.
      if (await source.isSettled(deposit).catch(() => false)) {
        console.warn(`[${label}] Settling ${tx} reported an error, but it's settled on-chain - recording it as already settled:`, describeError(err));
        // Waiting for quorum and then finding it paid, or losing the race to execute it: another
        // attester's instance paid it. Anything else: our own settle landed and its receipt was lost.
        const elsewhere = err instanceof AwaitingQuorumError || classifySettleError(settlement.vending, err).kind === "already-done";
        ledger.record({ ...entry, status: "already-settled", error: elsewhere ? "SettledElsewhere" : "SettledDespiteError", message: describeError(err) });
        recorded.add(deposit.depositId.toLowerCase());
        return true;
      }
      gate.release?.();
      if (err instanceof AwaitingQuorumError) {
        // Voted; the other attesters haven't yet. Not a failure - come back to it next tick.
        console.log(`[${label}] ${tx}: ${err.message}`);
        return false;
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
        if (!recorded.has(deposit.depositId.toLowerCase())) source.onPaidElsewhere?.(deposit);
        recorded.add(deposit.depositId.toLowerCase());
        return true;
      }
      if (kind === "permanent") {
        console.error(`[${label}] Permanently skipping ${tx} - reverted with ${name}, which can never succeed by retrying.`);
        ledger.record({ ...entry, status: "skipped", error: name });
        source.onSkipped?.(deposit, name);
        return true;
      }
      if (kind === "held") {
        const release = `npm run settle-held -- ${tx}${deposit.depositIndex > 0 ? ` --index ${deposit.depositIndex}` : ""}`;
        const why = "it's over XonVendingMachine's own limit. Raise the limit (setExternalLimits / setNativeLimits - a queued change), then pay it";
        alerts.send(`[${label}] Held deposit ${tx}: ${name} - ${why}: ${release}`);
        ledger.record({ ...entry, status: "held", error: name });
        return true;
      }
      console.error(`[${label}] Failed to settle ${tx} (${name ?? "unknown"}), will retry:`, describeError(err));
      recordFailure({ ...entry, status: "failed", error: name, message: describeError(err) });
      return false;
    }
  }

  // Works through a chunk of logs; returns the block shutdown interrupted it at, if it did.
  async function settleLogs(logs: Log[]): Promise<number | null> {
    // A deposit's id depends on its position within its tx, so number them in log order. A tx sits
    // in one block, and a scan always covers whole blocks, so every deposit of a tx is numbered
    // within the same call.
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
      if (passedOver.has(deposit.depositId) || waiting.has(deposit.depositId)) continue;
      if (!(await attempt(deposit, log))) defer(deposit, log);
    }
    return null;
  }

  // Retries the waiting deposits that are due, oldest first, each on its own.
  async function retryWaiting(): Promise<void> {
    const due = [...waiting.values()].filter((w) => w.nextAt <= Date.now())
      .sort((a, b) => a.deposit.sourceBlock - b.deposit.sourceBlock || a.deposit.sourceLogIndex - b.deposit.sourceLogIndex);
    for (const { deposit, log } of due) {
      if (shutdown.requested) return;
      if (await attempt(deposit, log)) waiting.delete(deposit.depositId);
      else defer(deposit, log);
    }
  }

  return {
    async tick() {
      await retryWaiting();
      saveCheckpoint();
      const toBlock = await getSafeHead(provider, source.confirmations);
      const scan = { provider, address: source.logAddress, topic: source.topic, chunkSize: config.logChunkSize };
      await scanLogs(scan, scannedTo, toBlock, settleLogs, (n) => {
        scannedTo = n;
        saveCheckpoint();
      }, () => shutdown.requested);
      if (source.afterTick) {
        await source.afterTick().catch((err) => console.error(`[${label}] After-poll work failed, will retry next poll:`, describeError(err)));
      }
      // How far the scan itself is behind. A deposit that's waiting doesn't count: it's alerted on
      // (after WAITING_ALERT_MS) rather than making the whole adapter look stalled.
      return Math.max(0, toBlock - scannedTo + 1);
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
