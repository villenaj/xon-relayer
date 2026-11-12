import assert from "node:assert/strict";
import { test } from "node:test";
import { createStrayUsdtWatch } from "../../src/strayUsdt.js";

/// A fake vending contract's USDT: transfers (deposits) with a log, and arrivals without one.
function world(start: { balance: bigint; accounted: bigint }) {
  const w = {
    head: 100, balance: start.balance, accounted: start.accounted,
    logs: [] as { block: number; depositId: string; amount: bigint }[],
    resolvedIds: new Set<string>(),
    scans: [] as [number, number][],
    /// A buyer's USDT transfer: balance up, and a log the relayer sees.
    deposit(id: string, amount: bigint) { w.head++; w.balance += amount; w.logs.push({ block: w.head, depositId: id, amount }); },
    /// Settled or cancelled: the contract accounts for it.
    resolve(id: string, amount: bigint) { w.head++; w.accounted += amount; w.resolvedIds.add(id); },
    /// A Substrate assets.transfer / XCM deposit: balance up, no log.
    silent(amount: bigint) { w.head++; w.balance += amount; },
    withdraw(amount: bigint) { w.head++; w.balance -= amount; const fromAccounted = amount < w.accounted ? amount : w.accounted; w.accounted -= fromAccounted; },
  };
  const watch = createStrayUsdtWatch({
    safeHead: async () => w.head,
    deposits: async (from, to) => { w.scans.push([from, to]); return w.logs.filter((l) => l.block >= from && l.block <= to); },
    resolved: async (id) => w.resolvedIds.has(id),
    balances: async () => ({ balance: w.balance, accounted: w.accounted }),
  });
  return { w, watch };
}

test("ordinary deposits, settled or still waiting, are never reported", async () => {
  const { w, watch } = world({ balance: 1000n, accounted: 1000n });
  assert.deepEqual(await watch.check(), { stray: 0n, block: 100, alert: null });
  w.deposit("a", 50n);
  w.deposit("b", 70n);
  assert.equal((await watch.check()).stray, 0n, "waiting deposits explain their own USDT");
  w.resolve("a", 50n);
  assert.equal((await watch.check()).stray, 0n, "settling one moves it from waiting to accounted");
  w.resolve("b", 70n);
  w.withdraw(500n);
  const last = await watch.check();
  assert.equal(last.stray, 0n);
  assert.equal(last.alert, null);
  assert.deepEqual(w.scans.map(([from]) => from), [101, 103, 104], "each block's logs are scanned once");
});

test("USDT that arrives without a Transfer log is alerted on once it's been there two checks", async () => {
  const { w, watch } = world({ balance: 1000n, accounted: 1000n });
  await watch.check();
  w.silent(25n);
  const first = await watch.check();
  assert.equal(first.stray, 25n);
  assert.equal(first.alert, null, "one reading isn't enough");
  const second = await watch.check();
  assert.deepEqual(second.alert, { kind: "found", amount: 25n });
  assert.equal((await watch.check()).alert, null, "not repeated while nothing changes");

  w.silent(10n);
  await watch.check();
  assert.deepEqual((await watch.check()).alert, { kind: "found", amount: 35n }, "reported again when more arrives");

  // The owner withdraws it to the treasury to refund the sender (accountedUsdt is drawn down
  // first, then the rest comes out of the unexplained balance).
  w.withdraw(w.accounted + 35n);
  assert.deepEqual(await watch.check(), { stray: 0n, block: w.head, alert: { kind: "cleared" } });
});

test("a reading that doesn't persist never alerts", async () => {
  const { w, watch } = world({ balance: 1000n, accounted: 1000n });
  await watch.check();
  // A deposit whose log the RPC hasn't served yet looks like a silent arrival for one check.
  w.silent(40n);
  assert.equal((await watch.check()).alert, null);
  w.logs.push({ block: w.head + 1, depositId: "late", amount: 40n });
  w.head++;
  const next = await watch.check();
  assert.equal(next.stray, 0n);
  assert.equal(next.alert, null);
});

test("deposits left unsettled from before the relayer started are the baseline, not an alert", async () => {
  // 30 USDT of old held/skipped deposits: in the balance, not accounted, no log this process saw.
  const { w, watch } = world({ balance: 1030n, accounted: 1000n });
  await watch.check();
  await watch.check();
  assert.equal((await watch.check()).stray, 0n);

  // One of them (20) is released and settled: accounted rises, the baseline follows it down.
  w.accounted += 20n;
  w.head++;
  assert.equal((await watch.check()).stray, 0n);

  // New unexplained USDT is still measured against the lower baseline.
  w.silent(5n);
  await watch.check();
  assert.deepEqual((await watch.check()).alert, { kind: "found", amount: 5n });
});
