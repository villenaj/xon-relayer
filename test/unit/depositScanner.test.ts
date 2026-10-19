import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { JsonRpcProvider, Log, TransactionReceipt } from "ethers";
import { createDepositScanner, type DepositSource, type Gate } from "../../src/adapters/depositScanner.js";
import { makeCheckpoint } from "../../src/checkpoint.js";
import { depositIdAt } from "../../src/settlement.js";
import { fakeContext, quiet, revertError, tmpDir } from "./helpers.js";

quiet();

interface FakeLog {
  blockNumber: number;
  transactionHash: string;
  index?: number;
  amount?: bigint;
  notADeposit?: boolean;
}

interface Setup {
  logs: FakeLog[];
  head?: number;
  startBlock?: number | null;
  /// Per tx, what each successive settle attempt does: "ok" or an error to throw.
  outcomes?: Record<string, ("ok" | Error)[]>;
  alreadySettled?: string[];
  gate?: DepositSource["gate"];
  dir?: string;
}

async function setup({ logs, head = 200, startBlock = 100, outcomes = {}, alreadySettled = [], gate, dir = tmpDir() }: Setup) {
  const context = fakeContext(dir);
  const settled = new Set(alreadySettled);
  const attempts: string[] = [];
  const provider = {
    getBlockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) =>
      logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
  };
  const source: DepositSource = {
    label: "test",
    description: "test deposits",
    provider: provider as unknown as JsonRpcProvider,
    logAddress: "0x",
    topic: "0x",
    confirmations: 0,
    checkpointFile: "test.json",
    checkpointIdentity: "id",
    startBlock,
    startBlockName: "TEST_START_BLOCK",
    parse(log: Log) {
      const fake = log as unknown as FakeLog;
      if (fake.notADeposit) return null;
      return { buyer: "0x01", usdtAmount: fake.amount ?? 5n, sourceChain: "test", sourceTxHash: fake.transactionHash, sourceBlock: fake.blockNumber };
    },
    baseDepositId: (txHash) => txHash,
    isSettled: async (d) => settled.has(d.depositId),
    async settle(d) {
      attempts.push(d.sourceTxHash);
      const outcome = outcomes[d.sourceTxHash]?.shift() ?? "ok";
      if (outcome !== "ok") throw outcome;
      settled.add(d.depositId);
      return { hash: `settle-${d.sourceTxHash}`, blockNumber: 999 } as unknown as TransactionReceipt;
    },
    gate,
  };
  const scanner = await createDepositScanner(context, source);
  const checkpoint = () => makeCheckpoint<number>(path.join(dir, "test.json"), "id").load();
  const statuses = () => context.entries.map((e) => `${e.sourceTxHash}:${e.status}`);
  return { scanner, context, attempts, checkpoint, statuses };
}

test("settles every deposit in order, ignores non-deposits, and checkpoints past the head", async () => {
  const { scanner, attempts, checkpoint, statuses } = await setup({
    logs: [{ blockNumber: 110, transactionHash: "a" }, { blockNumber: 115, transactionHash: "x", notADeposit: true }, { blockNumber: 120, transactionHash: "b" }],
  });
  assert.equal(await scanner.tick(), 0);
  assert.deepEqual(attempts, ["a", "b"]);
  assert.deepEqual(statuses(), ["a:settled", "b:settled"]);
  assert.equal(checkpoint(), 201);
});

test("a permanently failing deposit is skipped, not allowed to block the ones behind it", async () => {
  const { scanner, statuses, checkpoint } = await setup({
    logs: [{ blockNumber: 110, transactionHash: "dust" }, { blockNumber: 120, transactionHash: "b" }],
    outcomes: { dust: [revertError("ZeroAmount")] },
  });
  assert.equal(await scanner.tick(), 0);
  assert.deepEqual(statuses(), ["dust:skipped", "b:settled"]);
  assert.equal(checkpoint(), 201);
});

test("a deposit someone else already settled mid-attempt is recorded and passed", async () => {
  const { scanner, statuses } = await setup({
    logs: [{ blockNumber: 110, transactionHash: "a" }, { blockNumber: 120, transactionHash: "b" }],
    outcomes: { a: [revertError("AlreadySettled")] },
  });
  await scanner.tick();
  assert.deepEqual(statuses(), ["a:already-settled", "b:settled"]);
});

test("a transient failure stalls at that deposit and retries it next poll, never skipping past it", async () => {
  const { scanner, attempts, statuses, checkpoint } = await setup({
    logs: [{ blockNumber: 110, transactionHash: "a" }, { blockNumber: 120, transactionHash: "b" }, { blockNumber: 130, transactionHash: "c" }],
    outcomes: { b: [new Error("ECONNRESET")] },
  });
  assert.equal(await scanner.tick(), 81, "blocks 120-200 still to go");
  assert.deepEqual(attempts, ["a", "b"]);
  assert.equal(checkpoint(), 120);

  assert.equal(await scanner.tick(), 0);
  assert.deepEqual(attempts, ["a", "b", "b", "c"], "a is already settled, so it isn't sent again");
  assert.deepEqual(statuses(), ["a:settled", "b:failed", "b:settled", "c:settled"]);
  assert.equal(checkpoint(), 201);
});

test("a deposit over the contract's own per-deposit limit is held, alerted, and passed over", async () => {
  const { scanner, context, statuses, checkpoint } = await setup({
    logs: [{ blockNumber: 110, transactionHash: "big" }, { blockNumber: 120, transactionHash: "b" }],
    outcomes: { big: [revertError("OverExternalDepositLimit")] },
  });
  assert.equal(await scanner.tick(), 0);
  assert.deepEqual(statuses(), ["big:held", "b:settled"]);
  assert.equal(checkpoint(), 201);
  assert.equal(context.alertsSent.length, 1);
  assert.match(context.alertsSent[0], /setExternalLimits.*settle-held -- big/);
});

test("deposits already settled on-chain aren't sent again", async () => {
  const { scanner, attempts, context } = await setup({ logs: [{ blockNumber: 110, transactionHash: "a" }], alreadySettled: ["a"] });
  await scanner.tick();
  assert.deepEqual(attempts, []);
  assert.deepEqual(context.entries, []);
});

test("the gate can skip, stall, and is told to release when a settle fails", async () => {
  let released = 0;
  const decisions: Record<string, Gate> = {
    held: { action: "skip" },
    capped: { action: "stall" },
  };
  const { scanner, attempts, checkpoint } = await setup({
    logs: [{ blockNumber: 110, transactionHash: "held" }, { blockNumber: 115, transactionHash: "a" }, { blockNumber: 120, transactionHash: "capped" }, { blockNumber: 130, transactionHash: "c" }],
    outcomes: { a: [revertError("ZeroAddress")] },
    gate: (d) => decisions[d.sourceTxHash] ?? { action: "settle", release: () => released++ },
  });
  await scanner.tick();
  assert.deepEqual(attempts, ["a"]);
  assert.equal(released, 1);
  assert.equal(checkpoint(), 120);
});

test("on shutdown it stops before starting new work", async () => {
  const { scanner, context, attempts } = await setup({ logs: [{ blockNumber: 110, transactionHash: "a" }] });
  context.shutdown.request();
  await scanner.tick();
  assert.deepEqual(attempts, []);
});

test("resumes from the checkpoint; with none and no start block, starts after the current head", async () => {
  const dir = tmpDir();
  makeCheckpoint<number>(path.join(dir, "test.json"), "id").save(125);
  const resumed = await setup({ dir, logs: [{ blockNumber: 120, transactionHash: "old" }, { blockNumber: 130, transactionHash: "new" }] });
  await resumed.scanner.tick();
  assert.deepEqual(resumed.attempts, ["new"]);

  const fresh = await setup({ startBlock: null, head: 200, logs: [{ blockNumber: 150, transactionHash: "pre-existing" }] });
  await fresh.scanner.tick();
  assert.deepEqual(fresh.attempts, []);
  assert.equal(fresh.checkpoint(), null, "nothing to scan yet");
});

// Several deposits in one tx (a multisig or smart-wallet batch). Hashes are real 32-byte values
// because depositIdAt ABI-encodes them.
const BATCH = `0x${"ab".repeat(32)}`;

test("every deposit in a multi-deposit tx is paid, each under its own id - the first keeps the tx's id", async () => {
  const { scanner, context } = await setup({
    // Out of log order on purpose: numbering follows the log index, not the order the RPC returned.
    logs: [
      { blockNumber: 110, transactionHash: BATCH, index: 7, amount: 2n },
      { blockNumber: 110, transactionHash: BATCH, index: 3, amount: 1n },
      { blockNumber: 110, transactionHash: BATCH, index: 5, notADeposit: true },
    ],
  });
  await scanner.tick();
  assert.deepEqual(context.entries.map((e) => [e.status, e.depositIndex, e.usdtAmount, e.depositId]), [
    ["settled", 0, 1n, BATCH],
    ["settled", 1, 2n, depositIdAt(BATCH, 1)],
  ]);
  assert.notEqual(depositIdAt(BATCH, 1), BATCH);
});

test("a batch whose first deposit was settled under the old tx-hash-only id pays only the rest", async () => {
  const { scanner, context } = await setup({
    logs: [{ blockNumber: 110, transactionHash: BATCH, index: 0 }, { blockNumber: 110, transactionHash: BATCH, index: 1 }],
    alreadySettled: [BATCH],
  });
  await scanner.tick();
  assert.deepEqual(context.entries.map((e) => [e.status, e.depositIndex]), [["settled", 1]]);
});

test("retrying a batch after a stall numbers its deposits the same way", async () => {
  const { scanner, context, checkpoint } = await setup({
    logs: [{ blockNumber: 110, transactionHash: BATCH, index: 0 }, { blockNumber: 110, transactionHash: BATCH, index: 1 }],
    outcomes: { [BATCH]: ["ok", new Error("ECONNRESET")] },
  });
  await scanner.tick();
  assert.equal(checkpoint(), 110);
  await scanner.tick();
  assert.deepEqual(context.entries.map((e) => [e.status, e.depositIndex, e.depositId]), [
    ["settled", 0, BATCH],
    ["failed", 1, depositIdAt(BATCH, 1)],
    ["settled", 1, depositIdAt(BATCH, 1)],
  ]);
});
