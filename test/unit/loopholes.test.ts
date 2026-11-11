import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { classifySettleError } from "../../src/errorClassifier.js";
import { wantFixedRatePause } from "../../src/rateKeeper.js";
import { AwaitingQuorumError } from "../../src/settlement.js";
import { FEE_BEARING_ERRORS, refundProven } from "../../src/tools/refundTargets.js";
import VENDING_ABI from "../../src/abi/XonVendingMachine.json" with { type: "json" };

const vending = new ethers.Contract("0x00000000000000000000000000000000000000aa", VENDING_ABI);
const revert = (name: string) => ({ data: vending.interface.encodeErrorResult(name, []) });

test("new contract errors are classified so one deposit can't stall the rest", () => {
  assert.equal(classifySettleError(vending, revert("DepositIsCancelled")).kind, "permanent", "cancelled for a refund: skipped, so it's listed for one");
  // Both pass on their own, so the deposit waits and is retried - nobody has to release it.
  assert.equal(classifySettleError(vending, revert("OverAddressDailyLimit")).kind, "transient");
  assert.equal(classifySettleError(vending, revert("FixedRatePaused")).kind, "transient");
  assert.equal(classifySettleError(vending, revert("AlreadyExternallySettled")).kind, "already-done", "another attester executed it");
  // Waiting for other attesters is retried like anything transient.
  assert.equal(classifySettleError(vending, new AwaitingQuorumError(ethers.ZeroHash, 1n, 2n)).kind, "transient");
});

test("the keeper pauses fixed-rate paths past the threshold and resumes within half of it", () => {
  const want = (offBps: bigint, pausedNow: boolean) => wantFixedRatePause({ offBps, pausedNow, pauseBps: 300n });
  assert.equal(want(301n, false), true);
  assert.equal(want(300n, false), false);
  assert.equal(want(200n, true), true, "no flapping just under the threshold");
  assert.equal(want(150n, true), false);
  assert.equal(wantFixedRatePause({ offBps: 9_999n, pausedNow: false, pauseBps: 0n }), false, "0 turns it off");
});

test("a refund is proven by the gateway's event, with the fee accounting for the whole deposit", () => {
  const gw = "0x00000000000000000000000000000000000000cc";
  const payer = "0x1111111111111111111111111111111111111111";
  const fresh = "0x2222222222222222222222222222222222222222";
  const iface = new ethers.Interface(["event Refunded(uint256 indexed depositNonce, address indexed depositor, address indexed to, uint256 paid, uint256 fee)"]);
  const log = (nonce: bigint, paid: bigint, fee: bigint, to = payer) => ({ address: gw, ...iface.encodeEventLog("Refunded", [nonce, payer, to, paid, fee]) });
  const target = { payer, usdtAddress: gw, heldBy: gw, depositNonce: 4n, recordsDeposits: true };

  assert.equal(refundProven([log(4n, 9_500_000n, 500_000n)], target, 10_000_000n).ok, true, "less the fee");
  assert.equal(refundProven([log(4n, 10_000_000n, 0n, fresh)], target, 10_000_000n).ok, true, "to the address the depositor named");
  assert.equal(refundProven([log(4n, 5_000_000n, 0n)], target, 10_000_000n).ok, false, "short-paid");
  assert.equal(refundProven([log(5n, 10_000_000n, 0n)], target, 10_000_000n).ok, false, "another deposit");
  assert.ok(FEE_BEARING_ERRORS.has("MinimumNotMet") && !FEE_BEARING_ERRORS.has("InsufficientUsdtInventory"), "fees only for the depositor's own minimum");
});
