import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { makeCheckpoint } from "../../src/checkpoint.js";
import { tmpDir } from "./helpers.js";

test("load returns null when there's no checkpoint yet", () => {
  assert.equal(makeCheckpoint<number>(path.join(tmpDir(), "x.json"), "id").load(), null);
});

test("save then load round-trips, creating the directory and leaving no temp file", () => {
  const dir = path.join(tmpDir(), "nested", "dir");
  const checkpoint = makeCheckpoint<number>(path.join(dir, "x.json"), "id");
  checkpoint.save(1234);
  checkpoint.save(1235);
  assert.equal(checkpoint.load(), 1235);
  assert.deepEqual(readdirSync(dir), ["x.json"]);
});

test("refuses a checkpoint written for a different contract", () => {
  const file = path.join(tmpDir(), "x.json");
  makeCheckpoint<number>(file, "0xOld").save(10);
  assert.throws(() => makeCheckpoint<number>(file, "0xNew").load(), /written for identity "0xOld"/);
  assert.ok(existsSync(file), "the stale file is left alone for the operator");
});
