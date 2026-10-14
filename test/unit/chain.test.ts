import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonRpcProvider, Log } from "ethers";
import { getSafeHead, parseConfirmations, scanLogs } from "../../src/chain.js";

function fakeProvider() {
  const calls: [number, number][] = [];
  const provider = {
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) => {
      calls.push([fromBlock, toBlock]);
      return [{ blockNumber: fromBlock }];
    },
    getBlockNumber: async () => 100,
    getBlock: async (tag: string) => (tag === "finalized" ? { number: 64 } : null),
  };
  return { provider: provider as unknown as JsonRpcProvider, calls };
}

test("scans a range in chunks, reporting progress after each", async () => {
  const { provider, calls } = fakeProvider();
  const progress: number[] = [];
  const next = await scanLogs({ provider, address: "0x", topic: "0x", chunkSize: 10 }, 10, 34, async () => null, (n) => progress.push(n));
  assert.deepEqual(calls, [[10, 19], [20, 29], [30, 34]]);
  assert.deepEqual(progress, [20, 30, 35]);
  assert.equal(next, 35);
});

test("stops at a stalled block and resumes from it", async () => {
  const { provider, calls } = fakeProvider();
  const progress: number[] = [];
  const handle = async (logs: Log[]) => (logs[0].blockNumber === 20 ? 25 : null);
  const next = await scanLogs({ provider, address: "0x", topic: "0x", chunkSize: 10 }, 10, 34, handle, (n) => progress.push(n));
  assert.deepEqual(calls, [[10, 19], [20, 29]]);
  assert.deepEqual(progress, [20, 25]);
  assert.equal(next, 25);
});

test("does nothing when already at the head, and stops between chunks on request", async () => {
  const { provider, calls } = fakeProvider();
  assert.equal(await scanLogs({ provider, address: "0x", topic: "0x", chunkSize: 10 }, 50, 49, async () => null, () => {}), 50);
  assert.equal(calls.length, 0);

  let stop = false;
  const next = await scanLogs({ provider, address: "0x", topic: "0x", chunkSize: 10 }, 10, 34, async () => {
    stop = true;
    return null;
  }, () => {}, () => stop);
  assert.deepEqual(calls, [[10, 19]]);
  assert.equal(next, 20);
});

test("parses confirmation settings", () => {
  assert.equal(parseConfirmations("X", undefined, "finalized"), "finalized");
  assert.equal(parseConfirmations("X", "", 1), 1);
  assert.equal(parseConfirmations("X", "0", 1), 0);
  assert.equal(parseConfirmations("X", "12", 1), 12);
  assert.equal(parseConfirmations("X", "safe", 1), "safe");
  for (const bad of ["-1", "1.5", "latest", "abc"]) assert.throws(() => parseConfirmations("X", bad, 1), /X must be/);
});

test("safe head is a block count behind the head, or the tagged block", async () => {
  const { provider } = fakeProvider();
  assert.equal(await getSafeHead(provider, 3), 97);
  assert.equal(await getSafeHead(provider, 0), 100);
  assert.equal(await getSafeHead(provider, "finalized"), 64);
  await assert.rejects(getSafeHead(provider, "safe"), /no "safe" block/);
});
