import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeLedger, readLedger, type LedgerEntry } from "../../src/ledger.js";
import { quiet, tmpDir } from "./helpers.js";

quiet();

const entry: LedgerEntry = {
  adapter: "ethereum", status: "settled", buyer: "0x01", usdtAmount: 20_000_000n, sourceChain: "ethereum",
  sourceTxHash: "0xaa", depositId: "0xbb", sourceBlock: 5, settleTxHash: "0xcc", settleBlock: 9,
};

test("records round-trip, with amounts as strings and a timestamp", () => {
  const file = path.join(tmpDir(), "sub", "ledger.jsonl");
  const ledger = makeLedger(file);
  ledger.record(entry);
  ledger.record({ ...entry, status: "failed", error: "IsPaused" });

  const records = readLedger(file);
  assert.equal(records.length, 2);
  assert.equal(records[0].usdtAmount, "20000000");
  assert.equal(records[0].settleTxHash, "0xcc");
  assert.equal(records[1].status, "failed");
  assert.ok(!Number.isNaN(Date.parse(records[0].time)));
});

test("reading skips a malformed line (e.g. cut short by a crash) instead of failing", () => {
  const file = path.join(tmpDir(), "ledger.jsonl");
  makeLedger(file).record(entry);
  appendFileSync(file, '{"truncated":\n\n');
  makeLedger(file).record(entry);
  assert.equal(readLedger(file).length, 2);
});

test("a missing ledger reads as empty", () => {
  assert.deepEqual(readLedger(path.join(tmpDir(), "none.jsonl")), []);
});

test("a write failure never throws (it must not look like a settle failure)", () => {
  const blocker = path.join(tmpDir(), "a-file");
  writeFileSync(blocker, "");
  assert.doesNotThrow(() => makeLedger(path.join(blocker, "ledger.jsonl")).record(entry));
});
