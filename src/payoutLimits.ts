// Caps on what the relayer will pay out for AssetHub/Ethereum deposits. Those payouts rest purely
// on the relayer's attestation (see settleExternalPurchase), so a bug here - or a deposit the
// gateway shouldn't have accepted - could otherwise drain the XON reserve. The caps bound that:
//   - per deposit: anything bigger is held for an operator to release by hand (npm run settle-held)
//     instead of being paid automatically. It doesn't block later deposits.
//   - per rolling 24h, across both external chains: once reached, those adapters pause (stall and
//     retry) until older payouts age out of the window.
// With several attesters each instance keeps its own window, but counts every payout it sees -
// its own and the ones another instance executed - so the cap is on the total, not on its share.
// These run inside the relayer, so they don't protect against a stolen relayer key - that's what
// XonVendingMachine's own on-chain limits (setExternalLimits) are for. Keep these at or below those.

import type { LedgerRecord } from "./ledger.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface PayoutLimitsConfig {
  maxPerDeposit: bigint | null; // raw USDT units
  maxPer24h: bigint | null; // raw USDT units
}

export interface PayoutLimiter {
  /// True if this deposit is too big to ever be paid automatically.
  exceedsDepositCap(usdtAmount: bigint): boolean;
  /// Counts the amount against the 24h window. Returns a function that un-counts it (call it if
  /// the settle doesn't go through), or null if it would exceed the 24h cap right now.
  reserve(usdtAmount: bigint): (() => void) | null;
  /// Counts a payout someone else made (another attester's instance) against the 24h window.
  note(usdtAmount: bigint): void;
  /// USDT counted in the current window, for logging.
  usedInWindow(): bigint;
}

/// `history` seeds the 24h window with what was already paid out (from the ledger), so a restart
/// doesn't hand out a fresh day's allowance.
export function makePayoutLimiter(limits: PayoutLimitsConfig, history: LedgerRecord[]): PayoutLimiter {
  // One payout per deposit: an "already-settled" line can follow this instance's own "settled".
  const counted = new Set<string>();
  let window: { at: number; amount: bigint }[] = history
    // "already-settled": paid out all the same - by a settle that reported an error but landed, or
    // by another attester's instance (counted from when this one noticed).
    .filter((r) => (r.status === "settled" || r.status === "already-settled") && r.sourceChain !== "xode")
    .filter((r) => {
      const id = r.depositId?.toLowerCase();
      if (id === undefined) return true;
      if (r.status === "already-settled" && counted.has(id)) return false;
      counted.add(id);
      return true;
    })
    .map((r) => ({ at: Date.parse(r.time), amount: BigInt(r.usdtAmount) }))
    .filter((e) => Number.isFinite(e.at));

  function usedInWindow(): bigint {
    const cutoff = Date.now() - WINDOW_MS;
    window = window.filter((e) => e.at > cutoff);
    return window.reduce((sum, e) => sum + e.amount, 0n);
  }

  return {
    exceedsDepositCap(usdtAmount) {
      // A deposit bigger than the whole 24h allowance could never fit either - hold it too,
      // rather than stalling the adapter on it forever.
      return (limits.maxPerDeposit !== null && usdtAmount > limits.maxPerDeposit)
        || (limits.maxPer24h !== null && usdtAmount > limits.maxPer24h);
    },
    reserve(usdtAmount) {
      if (limits.maxPer24h !== null && usedInWindow() + usdtAmount > limits.maxPer24h) return null;
      const entry = { at: Date.now(), amount: usdtAmount };
      window.push(entry);
      return () => {
        window = window.filter((e) => e !== entry);
      };
    },
    note(usdtAmount) {
      window.push({ at: Date.now(), amount: usdtAmount });
    },
    usedInWindow,
  };
}
