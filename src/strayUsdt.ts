// Watches for USDT that reaches the vending contract without an ERC-20 Transfer log - a Substrate
// `assets.transfer`, or an XCM deposit. The relayer only sees Transfer logs, so that USDT is
// never paid out and never listed for a refund; it shows only as balance nobody can explain.
// `npm run reconcile` finds it by rescanning everything; this notices it within a couple of
// monitor checks, while the relayer runs.
//
// Each check works out, at the adapter's own safe head:
//     excess = USDT balance - accountedUsdt - deposits seen since start that are still waiting
// A deposit being settled or cancelled leaves `excess` unchanged (it moves from "waiting" to
// "accounted"). Deposits from before this process started that were never settled (held, skipped)
// are in `excess` from the first check on, so the first value is the baseline, and the baseline
// only ever moves down (as those old deposits get settled, cancelled or withdrawn). Anything above
// the baseline arrived while running, without a Transfer log.

export interface StrayUsdtChain {
  /// The block to evaluate at - the same one deposits are read up to (finalized, in production).
  safeHead(): Promise<number>;
  /// USDT Transfer logs into the vending contract in [from, to] that are deposits (not USDT the
  /// contract pulled in and accounted for itself), with the id each is settled under.
  deposits(from: number, to: number): Promise<{ depositId: string; amount: bigint }[]>;
  /// Whether the deposit is settled or cancelled as of `block` (either way: accounted).
  resolved(depositId: string, block: number): Promise<boolean>;
  balances(block: number): Promise<{ balance: bigint; accounted: bigint }>;
}

export interface StrayUsdtWatch {
  /// One check. `stray`: unexplained USDT that arrived since start and is still there. `alert`:
  /// set when that amount is new (seen on two checks running) or has cleared.
  check(): Promise<{ stray: bigint; block: number; alert: { kind: "found"; amount: bigint } | { kind: "cleared" } | null }>;
}

export function createStrayUsdtWatch(chain: StrayUsdtChain): StrayUsdtWatch {
  const waiting = new Map<string, bigint>();
  let scannedTo: number | null = null;
  let baseline = 0n;
  let previous = 0n; // last check's stray amount
  let alerted = 0n;

  return {
    async check() {
      const block = await chain.safeHead();
      if (scannedTo !== null && block > scannedTo) {
        for (const d of await chain.deposits(scannedTo + 1, block)) waiting.set(d.depositId, d.amount);
      }
      for (const id of [...waiting.keys()]) {
        if (await chain.resolved(id, block)) waiting.delete(id);
      }
      const { balance, accounted } = await chain.balances(block);
      let pending = 0n;
      for (const amount of waiting.values()) pending += amount;
      const excess = balance - accounted - pending;

      if (scannedTo === null) {
        scannedTo = block;
        baseline = excess;
        return { stray: 0n, block, alert: null };
      }
      scannedTo = Math.max(scannedTo, block);
      if (excess < baseline) baseline = excess;
      const stray = excess - baseline;

      // Alert on what has been there two checks running - one odd reading (a log the RPC serves
      // late, say) isn't enough - and only when it's more than was already reported.
      const confirmed = stray < previous ? stray : previous;
      previous = stray;
      let alert: Awaited<ReturnType<StrayUsdtWatch["check"]>>["alert"] = null;
      if (confirmed > alerted) {
        alerted = confirmed;
        alert = { kind: "found", amount: confirmed };
      } else if (stray === 0n && alerted > 0n) {
        alerted = 0n;
        alert = { kind: "cleared" };
      }
      return { stray, block, alert };
    },
  };
}
