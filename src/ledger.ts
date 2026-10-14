// Append-only record of every settle attempt the relayer makes, one JSON object per line
// (JSON Lines), so there's a durable audit trail beyond the console output. Unlike the on-chain
// Settled/ExternalSettled events, this also captures permanently skipped and failed attempts, and
// the original source-chain tx hash behind each cross-chain depositId.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LedgerStatus =
  | "settled" // settle tx confirmed on Xode
  | "already-settled" // another attempt got there first (AlreadySettled / AlreadyExternallySettled)
  | "skipped" // reverted with a permanent error - will never be retried
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
  error?: string | null;
  message?: string;
}

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
        appendFileSync(filePath, `${line}\n`);
      } catch (err) {
        console.error(`[ledger] Failed to write to ${filePath}, entry was:`, line, err);
      }
    },
  };
}
