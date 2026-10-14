// Caps on what the relayer will pay out for AssetHub/Ethereum deposits. Those payouts rest purely
// on the relayer's attestation (see settleExternalPurchase), so a bug here - or a deposit the
// gateway shouldn't have accepted - could otherwise drain the XON reserve. The caps bound that:
//   - per deposit: anything bigger is held for an operator to release by hand (npm run settle-held)
//     instead of being paid automatically. It doesn't block later deposits.
//   - per rolling 24h, across both external chains: once reached, those adapters pause (stall and
//     retry) until older payouts age out of the window.
// These run inside the relayer, so they don't protect against a stolen relayer key - that needs
// equivalent caps in XonVendingMachine itself.

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
  /// USDT counted in the current window, for logging.
  usedInWindow(): bigint;
}

/// `history` seeds the 24h window with what was already paid out (from the ledger), so a restart
/// doesn't hand out a fresh day's allowance.
export function makePayoutLimiter(limits: PayoutLimitsConfig, history: LedgerRecord[]): PayoutLimiter {
  let window: { at: number; amount: bigint }[] = history
    .filter((r) => r.status === "settled" && r.sourceChain !== "xode")
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
    usedInWindow,
  };
}
