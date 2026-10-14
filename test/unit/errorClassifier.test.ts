import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySettleError, describeError } from "../../src/errorClassifier.js";
import { revertError, vending } from "./helpers.js";

test("reverts that can never succeed are permanent", () => {
  for (const name of ["ZeroAmount", "ZeroAddress", "XonTransferFailed"]) {
    assert.deepEqual(classifySettleError(vending, revertError(name)), { kind: "permanent", name });
  }
});

test("already-settled reverts mean another attempt got there first", () => {
  for (const name of ["AlreadySettled", "AlreadyExternallySettled"]) {
    assert.deepEqual(classifySettleError(vending, revertError(name)), { kind: "already-done", name });
  }
});

test("reverts an operator can fix are transient", () => {
  for (const name of ["IsPaused", "InsufficientReserve", "NotRelayer", "UnverifiedDeposit"]) {
    assert.deepEqual(classifySettleError(vending, revertError(name)), { kind: "transient", name });
  }
});

test("anything undecodable is transient, so a real deposit is never given up on", () => {
  for (const err of [new Error("ECONNRESET"), null, undefined, { data: "0x1234" }, { data: "0xdeadbeef" }, { data: 42 }]) {
    assert.deepEqual(classifySettleError(vending, err), { kind: "transient", name: null });
  }
});

test("finds revert data wherever ethers or the bridge put it", () => {
  const data = revertError("ZeroAmount").data;
  assert.equal(classifySettleError(vending, { info: { error: { data } } }).kind, "permanent");
  assert.equal(classifySettleError(vending, { error: { data } }).kind, "permanent");
});

test("describeError prefers ethers' short message", () => {
  assert.equal(describeError({ shortMessage: "short", message: "long" }), "short");
  assert.equal(describeError(new Error("plain")), "plain");
  assert.equal(describeError("a string"), "a string");
});
