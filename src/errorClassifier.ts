// Distinguishes deposits that will NEVER settle (a permanently-reverting custom error) from ones
// that failed for a transient reason (RPC hiccup, contract temporarily paused, reserve temporarily
// empty, etc). Without this, every adapter's retry loop treats all failures alike and retries
// forever - which means one permanently-doomed deposit (e.g. a dust transfer that reverts with
// ZeroAmount) blocks every later deposit behind it indefinitely. That's a real denial-of-service,
// not just a hypothetical: anyone can trigger it with a single malformed/zero-value transfer.

import type { Contract, ErrorDescription } from "ethers";

// Genuinely unfixable by waiting - this specific deposit can never settle, no matter how long the
// adapter retries. Safe to skip and move on.
const PERMANENT_ERRORS = new Set([
  "ZeroAmount", // amount was 0, or rounds down to 0 XON - will never be anything else
  "ZeroAddress", // buyer/beneficiary decoded as the zero address - not a real payable recipient
  "XonTransferFailed", // the recipient's low-level value transfer itself reverted (e.g. a
  // contract with no working receive/fallback) - retrying won't change how that address behaves
]);

// Over XonVendingMachine's own per-deposit limit on external payouts: can't succeed until the
// owner raises it (setExternalLimits), which stalling would block every later deposit on. Held for
// an operator instead, like a deposit over the relayer's own per-deposit cap.
const HELD_ERRORS = new Set(["OverExternalDepositLimit"]);

// Not really a failure - some other attempt (a previous retry that we lost track of, or a race
// between adapters) already got this exact deposit settled. Nothing left to do.
const ALREADY_DONE_ERRORS = new Set(["AlreadySettled", "AlreadyExternallySettled"]);

// Anything else (IsPaused, InsufficientReserve, UnverifiedDeposit, NotRelayer, Reentrant,
// OverExternalDailyLimit - which refills over time - or any error we can't decode at all - a plain
// RPC/network failure, say) is treated as transient by default: an operator can fix all of these
// by acting (unpausing, topping up the reserve, fixing a misconfigured relayer key), and wrongly
// giving up on a legitimate deposit is worse than retrying one a little too long.

export type SettleErrorKind = "transient" | "already-done" | "permanent" | "held";

export interface SettleErrorClassification {
  kind: SettleErrorKind;
  name: string | null;
}

// The places ethers / the eth-rpc bridge may stash revert data, depending on which call failed.
interface RpcErrorLike {
  data?: unknown;
  info?: { error?: { data?: unknown } };
  error?: { data?: unknown };
  shortMessage?: string;
  message?: string;
}

export function classifySettleError(vending: Contract, err: unknown): SettleErrorClassification {
  const e = err as RpcErrorLike | null | undefined;
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  let parsed: ErrorDescription | null = null;
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    try {
      parsed = vending.interface.parseError(data);
    } catch {
      parsed = null;
    }
  }

  if (!parsed) {
    return { kind: "transient", name: null };
  }
  if (ALREADY_DONE_ERRORS.has(parsed.name)) {
    return { kind: "already-done", name: parsed.name };
  }
  if (PERMANENT_ERRORS.has(parsed.name)) {
    return { kind: "permanent", name: parsed.name };
  }
  if (HELD_ERRORS.has(parsed.name)) {
    return { kind: "held", name: parsed.name };
  }
  return { kind: "transient", name: parsed.name };
}

/// Short human-readable message for logging - prefers ethers' `shortMessage` over the full one.
export function describeError(err: unknown): string {
  const e = err as RpcErrorLike | null | undefined;
  return e?.shortMessage ?? e?.message ?? String(err);
}
