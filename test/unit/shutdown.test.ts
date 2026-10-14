import { test } from "node:test";
import assert from "node:assert/strict";
import { makeShutdown } from "../../src/shutdown.js";

test("sleep waits out its time when nothing happens", async () => {
  const shutdown = makeShutdown();
  const start = Date.now();
  await shutdown.sleep(30);
  assert.ok(Date.now() - start >= 25);
  assert.equal(shutdown.requested, false);
});

test("a shutdown request wakes every sleeper immediately", async () => {
  const shutdown = makeShutdown();
  const start = Date.now();
  const sleepers = [shutdown.sleep(60_000), shutdown.sleep(60_000)];
  setTimeout(() => shutdown.request(), 10);
  await Promise.all(sleepers);
  assert.ok(Date.now() - start < 5_000);
  assert.equal(shutdown.requested, true);
});

test("sleeping after shutdown returns at once, and requesting twice is harmless", async () => {
  const shutdown = makeShutdown();
  shutdown.request();
  shutdown.request();
  const start = Date.now();
  await shutdown.sleep(60_000);
  assert.ok(Date.now() - start < 1_000);
});
