// Distinguishes deposits that will NEVER settle (a permanently-reverting custom error) from ones
// that failed for a transient reason (RPC hiccup, contract temporarily paused, reserve temporarily
// empty, etc). Without this, every adapter's retry loop treats all failures alike and retries
// forever - which means one permanently-doomed deposit (e.g. a dust transfer that reverts with
// ZeroAmount) blocks every later deposit behind it indefinitely. That's a real denial-of-service,
// not just a hypothetical: anyone can trigger it with a single malformed/zero-value transfer.

// Genuinely unfixable by waiting - this specific deposit can never settle, no matter how long the
// adapter retries. Safe to skip and move on.
const PERMANENT_ERRORS = new Set([
  "ZeroAmount", // amount was 0, or rounds down to 0 XON - will never be anything else
  "ZeroAddress", // buyer/beneficiary decoded as the zero address - not a real payable recipient
  "XonTransferFailed", // the recipient's low-level value transfer itself reverted (e.g. a
  // contract with no working receive/fallback) - retrying won't change how that address behaves
]);

// Not really a failure - some other attempt (a previous retry that we lost track of, or a race
// between adapters) already got this exact deposit settled. Nothing left to do.
const ALREADY_DONE_ERRORS = new Set(["AlreadySettled", "AlreadyExternallySettled"]);

// Anything else (IsPaused, InsufficientReserve, UnverifiedDeposit, NotRelayer, Reentrant, or any
// error we can't decode at all - a plain RPC/network failure, say) is treated as transient by
// default: an operator can fix all of these by acting (unpausing, topping up the reserve, fixing
// a misconfigured relayer key), and wrongly giving up on a legitimate deposit is worse than
// retrying one a little too long.

export function classifySettleError(vending, err) {
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  let parsed = null;
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
  return { kind: "transient", name: parsed.name };
}
