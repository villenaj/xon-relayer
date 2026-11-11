import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { collectRefundSignatures, createRefundAttester, refundChargesFee } from "../../src/adapters/attestedRefund.js";
import { classifySettleError } from "../../src/errorClassifier.js";
import VENDING_ABI from "../../src/abi/XonVendingMachine.json" with { type: "json" };

const vendingInterface = new ethers.Interface(VENDING_ABI);
const vending = { interface: vendingInterface } as unknown as ethers.Contract;
const ID = ethers.id("deposit");
const DIGEST = ethers.id("refund digest");
const DEPOSIT = { depositId: ID, sourceTxHash: "0xaa", usdtAmount: 5_000_000n, gatewayNonce: 7n, depositor: "0x1111111111111111111111111111111111111111" };

/// A fake Xode + gateway: `votesNeeded` cancel votes cancel the deposit; this attester casts one.
function world(opts: { votesNeeded?: number; paid?: boolean; cancelled?: boolean; refunded?: boolean; gatewayThreshold?: bigint; voteError?: string } = {}) {
  const state = { paid: opts.paid ?? false, cancelled: opts.cancelled ?? false, chargeFee: false, voted: false, votes: 0 };
  const calls: string[] = [];
  const alerts: string[] = [];
  const settlement = {
    vending,
    async cancelState() { return { paid: state.paid, cancelled: state.cancelled, chargeFee: state.chargeFee, voted: state.voted }; },
    async voteCancel(_id: string, chargeFee: boolean) {
      calls.push(`vote:${chargeFee}`);
      if (opts.voteError) throw Object.assign(new Error("reverted"), { data: vendingInterface.encodeErrorResult(opts.voteError, []) });
      state.voted = true;
      if (++state.votes >= (opts.votesNeeded ?? 1)) { state.cancelled = true; state.chargeFee = chargeFee; }
    },
    async publishRefundSignature(_id: string, digest: string) { calls.push(`sign:${digest}`); },
  };
  const gateway = {
    async depositRecords() { return opts.refunded ? ethers.ZeroHash : ethers.id("record"); },
    async attestationThreshold() { return opts.gatewayThreshold ?? 2n; },
    async refundDigest(nonce: bigint, depositor: string, amount: bigint, chargeFee: boolean) { return `${nonce}/${depositor}/${amount}/${chargeFee}`; },
  };
  const refunds = createRefundAttester({ label: "test", settlement, gateway, alert: (m) => alerts.push(m) });
  return { state, calls, alerts, refunds };
}

test("the refund fee is kept only when the depositor's own minimum wasn't met", () => {
  assert.ok(refundChargesFee("MinimumNotMet") && refundChargesFee("BelowMinimum"));
  for (const e of ["XonTransferFailed", "ZeroAmount", "DepositIsCancelled", null, undefined]) assert.ok(!refundChargesFee(e), String(e));
});

test("a fixed-rate deposit whose minimum the rate no longer meets is given up on, not retried", () => {
  const err = { data: vendingInterface.encodeErrorResult("BelowMinimum", []) };
  assert.deepEqual(classifySettleError(vending, err), { kind: "permanent", name: "BelowMinimum" });
});

test("an attester votes to cancel, and signs the refund only once the deposit is cancelled", async () => {
  const w = world({ votesNeeded: 2 });
  w.refunds.add(DEPOSIT, "BelowMinimum");
  await w.refunds.tick();
  assert.deepEqual(w.calls, ["vote:true"], "voted, with the fee its error calls for - and no signature yet");
  assert.equal(w.refunds.pending(), 1);

  await w.refunds.tick();
  assert.deepEqual(w.calls, ["vote:true"], "doesn't vote twice, still doesn't sign");

  // Another attester's vote completes the quorum.
  w.state.cancelled = true;
  w.state.chargeFee = true;
  await w.refunds.tick();
  assert.deepEqual(w.calls, ["vote:true", `sign:7/${DEPOSIT.depositor}/5000000/true`], "signs exactly this deposit, with the fee the vote fixed");
  assert.equal(w.refunds.pending(), 0);
});

test("the fee signed for is the one the quorum fixed, not this attester's own view", async () => {
  const w = world({ cancelled: true }); // cancelled by others (or the owner) with no fee
  w.refunds.add(DEPOSIT, "BelowMinimum");
  await w.refunds.tick();
  assert.deepEqual(w.calls, [`sign:7/${DEPOSIT.depositor}/5000000/false`]);
});

test("a deposit that was paid, or already refunded, is never signed for", async () => {
  for (const opts of [{ paid: true }, { refunded: true }, { voteError: "AlreadyExternallySettled" }]) {
    const w = world(opts);
    w.refunds.add(DEPOSIT, "XonTransferFailed");
    await w.refunds.tick();
    assert.ok(!w.calls.some((c) => c.startsWith("sign")), JSON.stringify(opts));
    assert.equal(w.refunds.pending(), 0, JSON.stringify(opts));
  }
});

test("a gateway without attested refunds is left to its owner; a failed vote is retried", async () => {
  const off = world({ gatewayThreshold: 0n });
  off.refunds.add(DEPOSIT, "XonTransferFailed");
  await off.refunds.tick();
  assert.deepEqual(off.calls, ["vote:false"], "still cancelled on Xode by vote, but nothing signed");

  const failing = world({ voteError: "IsPaused" });
  failing.refunds.add(DEPOSIT, "XonTransferFailed");
  await failing.refunds.tick();
  assert.equal(failing.refunds.pending(), 1);
});

test("refund signatures are collected per attester, verified, and ordered for the gateway", async () => {
  const keys = [1, 2, 3].map((n) => new ethers.Wallet(ethers.zeroPadValue(ethers.toBeHex(n), 32)));
  const outsider = new ethers.Wallet(ethers.zeroPadValue("0x09", 32));
  const event = async (signer: ethers.Wallet, digest = DIGEST, claimedBy = signer.address) =>
    vendingInterface.encodeEventLog("RefundSigned", [ID, claimedBy, await signer.signMessage(ethers.getBytes(digest))]);
  const logs = [
    await event(keys[2]), await event(keys[0]), await event(keys[0]), // a repeat
    await event(outsider),                                           // not a gateway attester
    await event(keys[1], ethers.id("another refund")),               // signed something else
    await event(outsider, DIGEST, keys[1].address),                   // published under another attester's name
  ];
  const attesters = new Set(keys.map((k) => k.address));
  const found = await collectRefundSignatures(logs, vendingInterface, DIGEST, async (a) => attesters.has(a));
  assert.deepEqual(found.map((f) => f.signer).sort(), [keys[0].address, keys[2].address].sort());
  assert.ok(BigInt(found[0].signer) < BigInt(found[1].signer), "ascending by signer address");
  for (const f of found) assert.equal(ethers.verifyMessage(ethers.getBytes(DIGEST), f.signature), f.signer);
});
