// Append-only record of every settle attempt the relayer makes, one JSON object per line
// (JSON Lines), so there's a durable audit trail beyond the console output. Unlike the on-chain
// Settled/ExternalSettled events, this also captures permanently skipped and failed attempts, and
// the original source-chain tx hash behind each cross-chain depositId.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export type LedgerStatus =
  | "settled" // settle tx confirmed on Xode
  | "already-settled" // another attempt got there first (AlreadySettled / AlreadyExternallySettled)
  | "skipped" // reverted with a permanent error - will never be retried
  | "held" // over the per-deposit payout cap - waits for an operator (npm run settle-held)
  | "refunded" // a skipped deposit's USDT was returned to the payer (npm run refunds -- mark)
  | "failed"; // transient failure - will be retried next tick

export interface LedgerEntry {
  adapter: string;
  status: LedgerStatus;
  buyer: string;
  usdtAmount: bigint;
  sourceChain: string;
  sourceTxHash: string;
  depositId: string;
  sourceBlock: number;
  settleTxHash?: string;
  settleBlock?: number;
  refundTxHash?: string;
  refundTo?: string;
  error?: string | null;
  message?: string;
}

/// An entry as stored on disk: amounts as decimal strings, plus the time it was written.
export type LedgerRecord = Omit<LedgerEntry, "usdtAmount"> & { time: string; usdtAmount: string };

export interface Ledger {
  record(entry: LedgerEntry): void;
}

export function makeLedger(filePath: string): Ledger {
  return {
    record(entry) {
      const line = JSON.stringify({ time: new Date().toISOString(), ...entry, usdtAmount: entry.usdtAmount.toString() });
      // Never throws: a ledger write failure must not be mistaken for a settle failure by the
      // adapter's error handling (which would stall that adapter's checkpoint on a deposit that
      // actually did settle).
      try {
        const dir = dirname(filePath);
        if (dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
        // fsync each entry: a "settled" record lost to a power cut would later show up in
        // reconcile as an unrecorded payout. Settles are seconds apart, so the cost is nothing.
        const fd = openSync(filePath, "a");
        try {
          writeSync(fd, `${line}\n`);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch (err) {
        console.error(`[ledger] Failed to write to ${filePath}, entry was:`, line, err);
      }
    },
  };
}

/// Every record in the ledger, oldest first. Malformed lines (e.g. one cut short by a crash
/// mid-write) are skipped with a warning rather than failing the whole read.
export function readLedger(filePath: string): LedgerRecord[] {
  if (!existsSync(filePath)) return [];
  const records: LedgerRecord[] = [];
  readFileSync(filePath, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line) as LedgerRecord);
    } catch {
      console.warn(`[ledger] Ignoring malformed line ${i + 1} of ${filePath}.`);
    }
  });
  return records;
}
