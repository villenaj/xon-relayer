// Fixes from the relayer review: second-opinion RPCs, the rate keeper's median price, the API's
// incremental ledger reads, the payout window's history, and keeping the rate keeper key loadable
// only where it's needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeCrossChecker } from "../../src/adapters/crossCheck.js";
import { makePayoutLimiter } from "../../src/payoutLimits.js";
import { makePriceWindow, median } from "../../src/rateKeeper.js";
import type { LedgerRecord } from "../../src/ledger.js";
import { quiet, tmpDir } from "./helpers.js";

quiet();
process.env.VENDING_ADDRESS ??= "0x00000000000000000000000000000000000000aa";
const { loadRateKeeperKey } = await import("../../src/config.js");
const { makeLedgerView } = await import("../../src/api/service.js");

// --- second-opinion RPCs ------------------------------------------------------------------------

const LOG = {
  transactionHash: "0xt", blockNumber: 100, blockHash: "0xB100", index: 3,
  address: "0xGateway", topics: ["0xDeposited", "0xdepositor"], data: "0xamount",
};

function verifier({ head = 200, receipt = "same" as "same" | "none" | "failed" | "otherBlock" | "otherData" } = {}) {
  const logs = receipt === "otherData" ? [{ ...LOG, data: "0xMORE" }] : [{ ...LOG }];
  return {
    getBlockNumber: async () => head,
    getBlock: async () => ({ number: head }),
    getTransactionReceipt: async () => receipt === "none" ? null : {
      status: receipt === "failed" ? 0 : 1,
      blockHash: receipt === "otherBlock" ? "0xB100-fork" : "0xb100", // case doesn't matter
      logs,
    },
  };
}

test("a deposit passes only when every verify RPC has the same log, in the same block, past the policy", async () => {
  assert.deepEqual(await makeCrossChecker([], 0).check(LOG), { ok: true }, "none configured: nothing to check");
  assert.deepEqual(await makeCrossChecker([verifier(), verifier()] as never, 0).check(LOG), { ok: true });

  const lagging = await makeCrossChecker([verifier(), verifier({ head: 99 })] as never, 0).check(LOG);
  assert.equal(lagging.ok, false);
  assert.equal(!lagging.ok && lagging.mismatch, false, "behind is a wait, not a disagreement");
  assert.match(!lagging.ok ? lagging.reason : "", /verify RPC #2 hasn't seen block 100/);

  for (const receipt of ["none", "failed", "otherBlock", "otherData"] as const) {
    const verdict = await makeCrossChecker([verifier({ receipt })] as never, 0).check(LOG);
    assert.equal(verdict.ok, false, receipt);
    assert.equal(!verdict.ok && verdict.mismatch, true, `${receipt} is a disagreement`);
  }
});

test("an RPC that's down fails the check rather than passing it", async () => {
  const down = { ...verifier(), getBlockNumber: async () => { throw new Error("ECONNREFUSED"); } };
  await assert.rejects(makeCrossChecker([verifier(), down] as never, 0).check(LOG), /ECONNREFUSED/);
});

test("verify messages never include RPC URLs (they often carry API keys)", async () => {
  const verdict = await makeCrossChecker([verifier({ receipt: "otherData" })] as never, 0).check(LOG);
  assert.doesNotMatch(!verdict.ok ? verdict.reason : "", /https?:/);
});

// --- rate keeper: median of spaced samples ---------------------------------------------------------

test("median picks the middle reading (the lower middle for an even count)", () => {
  assert.equal(median([]), null);
  assert.equal(median([5n]), 5n);
  assert.equal(median([9n, 1n, 5n]), 5n);
  assert.equal(median([4n, 1n, 3n, 2n]), 2n);
});

test("a block or two of a manipulated pool can't move the keeper's target", () => {
  const window = makePriceWindow(5);
  const fair = 200n;
  window.add(1, fair);
  window.add(2, fair);
  assert.equal(window.target(), null, "doesn't act on a partial window");
  window.add(3, fair);
  window.add(4, 1_000n); // pool pushed 5x for a block...
  window.add(5, 1_000n); // ...and the next
  assert.equal(window.target(), fair, "two of five readings off-market don't move the median");
  window.add(6, 1_000n);
  assert.equal(window.target(), 1_000n, "held off-market for most of the window, it's the market");
});

test("readings from the same block count once, and a vanished pool starts the window over", () => {
  const window = makePriceWindow(3);
  window.add(1, 100n);
  window.add(1, 900n);
  window.add(1, 900n);
  assert.equal(window.size, 1, "one block, one reading");
  window.add(2, 100n);
  window.add(3, 100n);
  assert.equal(window.target(), 100n);
  window.reset();
  assert.equal(window.target(), null);
});

// --- the API's ledger view ------------------------------------------------------------------------

const record = (depositId: string, status: string) =>
  `${JSON.stringify({ time: "2026-11-11T00:00:00Z", adapter: "ethereum", buyer: "0xAbc", usdtAmount: "1", sourceChain: "ethereum", sourceTxHash: depositId, depositId, sourceBlock: 1, status })}\n`;

test("the API reads only what was appended, including a line completed across two writes", () => {
  const dir = tmpDir();
  const file = path.join(dir, "ledger.jsonl");
  const view = makeLedgerView(file);
  assert.equal(view.get("0x1"), undefined, "missing file: no detail");

  writeFileSync(file, record("0x1", "failed"));
  assert.equal(view.get("0x1")?.status, "failed");
  appendFileSync(file, record("0x1", "held"));
  assert.equal(view.get("0x1")?.status, "held");
  appendFileSync(file, record("0x1", "failed"));
  assert.equal(view.get("0x1")?.status, "held", "a later failed retry doesn't un-hold it");

  const line = record("0x2", "settled");
  appendFileSync(file, line.slice(0, 20)); // half-written
  assert.equal(view.get("0x2"), undefined);
  appendFileSync(file, line.slice(20));
  assert.equal(view.get("0x2")?.status, "settled");
  assert.equal(view.forBeneficiary("0xabc").length, 2);
});

test("the API starts over when the ledger is rotated or replaced", () => {
  const dir = tmpDir();
  const file = path.join(dir, "ledger.jsonl");
  const view = makeLedgerView(file);
  writeFileSync(file, record("0x1", "settled") + record("0x2", "settled"));
  assert.equal(view.get("0x2")?.status, "settled");

  writeFileSync(file, record("0x3", "held")); // copytruncate: same file, smaller
  assert.equal(view.get("0x2"), undefined);
  assert.equal(view.get("0x3")?.status, "held");

  const replacement = path.join(dir, "new.jsonl");
  writeFileSync(replacement, record("0x3", "held") + record("0x3", "settled"));
  renameSync(replacement, file); // a new file at the same path
  assert.equal(view.get("0x3")?.status, "settled");
});

// --- payout window history ------------------------------------------------------------------------

test("the 24h window counts payouts that landed despite an error, after a restart too", () => {
  const now = new Date().toISOString();
  const history = [
    { time: now, status: "settled", sourceChain: "ethereum", usdtAmount: "10" },
    { time: now, status: "already-settled", error: "SettledDespiteError", sourceChain: "assethub", usdtAmount: "5" },
    { time: now, status: "already-settled", error: "AlreadyExternallySettled", sourceChain: "ethereum", usdtAmount: "100" }, // someone else's payout
    { time: now, status: "settled", sourceChain: "xode", usdtAmount: "1000" }, // not an external payout
  ] as LedgerRecord[];
  const limiter = makePayoutLimiter({ maxPerDeposit: null, maxPer24h: 20n }, history);
  assert.equal(limiter.usedInWindow(), 15n);
  assert.equal(limiter.reserve(6n), null);
});

// --- the rate keeper key ---------------------------------------------------------------------------

const KEY = `0x${"cd".repeat(32)}`;

test("the rate keeper key loads from a credential or a file, never from two places, and leaves no env var behind", () => {
  const saved = { ...process.env };
  try {
    delete process.env.RATE_KEEPER_PRIVATE_KEY;
    delete process.env.RATE_KEEPER_PRIVATE_KEY_FILE;
    delete process.env.CREDENTIALS_DIRECTORY;
    assert.equal(loadRateKeeperKey(), null, "none set: no keeper");

    const dir = tmpDir();
    mkdirSync(path.join(dir, "creds"));
    writeFileSync(path.join(dir, "creds", "rate-keeper-key"), `${KEY}\n`);
    process.env.CREDENTIALS_DIRECTORY = path.join(dir, "creds");
    assert.deepEqual(loadRateKeeperKey(), { key: KEY, source: 'systemd credential "rate-keeper-key"' });

    process.env.RATE_KEEPER_PRIVATE_KEY = KEY;
    assert.throws(() => loadRateKeeperKey(), /more than one place/);
    assert.equal(process.env.RATE_KEEPER_PRIVATE_KEY, undefined, "scrubbed even when refused");

    delete process.env.CREDENTIALS_DIRECTORY;
    writeFileSync(path.join(dir, "key"), "not a key");
    process.env.RATE_KEEPER_PRIVATE_KEY_FILE = path.join(dir, "key");
    assert.throws(() => loadRateKeeperKey(), (err: Error) => /isn't a 32-byte hex private key/.test(err.message) && !err.message.includes("not a key"));
  } finally {
    process.env = saved;
  }
});
