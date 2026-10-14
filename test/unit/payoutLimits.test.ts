import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerRecord } from "../../src/ledger.js";
import { makePayoutLimiter } from "../../src/payoutLimits.js";

const U = 1_000_000n; // 1 USDT
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const record = (time: string, status: LedgerRecord["status"], sourceChain: string, usdt: bigint): LedgerRecord => ({
  time, status, sourceChain, usdtAmount: String(usdt * U),
  adapter: "x", buyer: "0x01", sourceTxHash: "0x02", depositId: "0x03", sourceBlock: 1,
});

test("the 24h window is seeded from external payouts in the ledger only", () => {
  const limiter = makePayoutLimiter({ maxPerDeposit: null, maxPer24h: 100n * U }, [
    record(hoursAgo(1), "settled", "ethereum", 30n),
    record(hoursAgo(2), "settled", "assethub", 20n),
    record(hoursAgo(25), "settled", "ethereum", 500n), // aged out
    record(hoursAgo(1), "settled", "xode", 999n), // native - not capped
    record(hoursAgo(1), "failed", "ethereum", 999n), // never paid
    record("not a date", "settled", "ethereum", 999n),
  ]);
  assert.equal(limiter.usedInWindow(), 50n * U);
});

test("reserve enforces the 24h cap, and releasing undoes a reservation", () => {
  const limiter = makePayoutLimiter({ maxPerDeposit: null, maxPer24h: 100n * U }, []);
  const release = limiter.reserve(60n * U);
  assert.ok(release);
  assert.equal(limiter.reserve(41n * U), null);
  release();
  assert.equal(limiter.usedInWindow(), 0n);
  assert.ok(limiter.reserve(100n * U), "exactly the cap is allowed");
  assert.equal(limiter.reserve(1n), null);
});

test("per-deposit cap, and a deposit bigger than the whole daily cap is held rather than stalling forever", () => {
  const limiter = makePayoutLimiter({ maxPerDeposit: 60n * U, maxPer24h: 100n * U }, []);
  assert.equal(limiter.exceedsDepositCap(60n * U), false);
  assert.equal(limiter.exceedsDepositCap(61n * U), true);

  const dailyOnly = makePayoutLimiter({ maxPerDeposit: null, maxPer24h: 100n * U }, []);
  assert.equal(dailyOnly.exceedsDepositCap(101n * U), true);
});

test("no caps means nothing is held or refused", () => {
  const limiter = makePayoutLimiter({ maxPerDeposit: null, maxPer24h: null }, []);
  assert.equal(limiter.exceedsDepositCap(10n ** 30n), false);
  assert.ok(limiter.reserve(10n ** 30n));
});
