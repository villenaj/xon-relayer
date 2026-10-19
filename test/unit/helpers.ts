import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { ethers } from "ethers";
import type { AdapterContext } from "../../src/adapters/types.js";
import type { LedgerEntry } from "../../src/ledger.js";
import { makeShutdown } from "../../src/shutdown.js";
import VENDING_ABI from "../../src/abi/XonVendingMachine.json" with { type: "json" };

export const vending = new ethers.Contract(ethers.ZeroAddress, VENDING_ABI);

export function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "xon-relayer-test-"));
}

/// An error shaped like the one ethers throws for a contract revert with a custom error.
export function revertError(name: string): Error & { data: string } {
  return Object.assign(new Error(`execution reverted: ${name}`), { data: vending.interface.encodeErrorResult(name, []) });
}

/// Silences the relayer's console output for the rest of the current test file.
export function quiet(): void {
  for (const method of ["log", "warn", "error"] as const) mock.method(console, method, () => {});
}

/// A minimal AdapterContext: real shutdown, a ledger and alerts that collect into memory, and only
/// the config fields the adapter loop reads.
export function fakeContext(checkpointDir: string): AdapterContext & { entries: LedgerEntry[]; alertsSent: string[] } {
  const entries: LedgerEntry[] = [];
  const alertsSent: string[] = [];
  const context = {
    settlement: { vending },
    config: { checkpointDir, logChunkSize: 100, pollIntervalMs: 1 },
    ledger: { record: (e: LedgerEntry) => entries.push(e) },
    alerts: { send: (message: string) => alertsSent.push(message) },
    shutdown: makeShutdown(),
    entries,
    alertsSent,
  };
  return context as unknown as AdapterContext & { entries: LedgerEntry[]; alertsSent: string[] };
}
