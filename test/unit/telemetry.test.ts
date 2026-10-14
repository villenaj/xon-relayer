import { test } from "node:test";
import assert from "node:assert/strict";
import { Telemetry } from "../../src/telemetry.js";

const MINUTE = 60_000;

test("an adapter is stalled once it hasn't caught up within the threshold", () => {
  const telemetry = new Telemetry(10 * MINUTE);
  telemetry.registerAdapter("xode");
  const now = Date.now();
  assert.deepEqual(telemetry.stalledAdapters(now), [], "fresh adapter gets the full threshold");
  assert.deepEqual(telemetry.stalledAdapters(now + 11 * MINUTE), ["xode"]);

  telemetry.tickSucceeded("xode", 0);
  assert.deepEqual(telemetry.stalledAdapters(Date.now() + 9 * MINUTE), []);
});

test("polling without catching up (e.g. stuck on one deposit) doesn't count as healthy", () => {
  const telemetry = new Telemetry(10 * MINUTE);
  telemetry.registerAdapter("ethereum");
  telemetry.tickSucceeded("ethereum", 5);
  telemetry.tickSucceeded("ethereum", 5);
  assert.deepEqual(telemetry.stalledAdapters(Date.now() + 11 * MINUTE), ["ethereum"]);
});

test("health is 200 when caught up, 503 when stalled or shutting down", async () => {
  const telemetry = new Telemetry(10 * MINUTE);
  telemetry.registerAdapter("xode");
  telemetry.tickSucceeded("xode", 0);
  telemetry.setWarnings(["low balance"]);
  const ok = telemetry.health(false);
  assert.equal(ok.healthy, true);
  assert.deepEqual((ok.body as { warnings: string[] }).warnings, ["low balance"]);
  assert.equal(telemetry.health(true).healthy, false);

  const strict = new Telemetry(1);
  strict.registerAdapter("xode");
  await new Promise((r) => setTimeout(r, 5));
  const stalled = strict.health(false);
  assert.equal(stalled.healthy, false);
  assert.equal((stalled.body as { status: string }).status, "stalled");
});

test("metrics render in Prometheus format, with counters accumulating and labels escaped", () => {
  const telemetry = new Telemetry(MINUTE);
  telemetry.settleAttempt("xode", "settled");
  telemetry.settleAttempt("xode", "settled");
  telemetry.settleAttempt("xode", "failed");
  telemetry.tickFailed('we"ird');
  telemetry.setBalances(1.5, 250);
  const text = telemetry.renderMetrics();
  assert.match(text, /# TYPE xon_relayer_settle_attempts_total counter/);
  assert.match(text, /xon_relayer_settle_attempts_total\{adapter="xode",status="settled"\} 2/);
  assert.match(text, /xon_relayer_settle_attempts_total\{adapter="xode",status="failed"\} 1/);
  assert.match(text, /xon_relayer_adapter_tick_failures_total\{adapter="we\\"ird"\} 1/);
  assert.match(text, /xon_relayer_relayer_balance_xon 1\.5/);
  assert.match(text, /xon_relayer_vending_reserve_xon 250/);
});
