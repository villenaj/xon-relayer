import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  bundle, CALL, DELEGATECALL, describeCall, encodeMultiSend, packSignatures, PROPOSAL_FORMAT, safeTx, safeTxHash,
  reviewCalls, serializeTx, signerOf, typedData, verifyProposal, type Call, type Proposal,
} from "../../src/safe/safeTx.js";
import GATEWAY_ABI from "../../src/abi/EthUsdtGateway.json" with { type: "json" };

const SAFE = "0x8c827b1DbF504b1dE7E87166d39163149fdDD558";
const MULTISEND = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
const GATEWAY = "0x00000000000000000000000000000000000000cc";
const gateway = new ethers.Interface(GATEWAY_ABI);
const refund = (n: bigint): Call => ({ to: GATEWAY, value: 0n, data: gateway.encodeFunctionData("refund", [n, "0x1111111111111111111111111111111111111111", 2_000_000n, false]) });
const owners = [0, 1, 2].map(() => ethers.Wallet.createRandom());

test("the EIP-712 hash is exactly Safe 1.4.1's own getTransactionHash", () => {
  // Rebuilt by hand from Safe.sol's constants, independent of ethers' typed-data encoder.
  const DOMAIN_TYPEHASH = "0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218"; // EIP712Domain(uint256 chainId,address verifyingContract)
  const SAFE_TX_TYPEHASH = "0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8";
  assert.equal(ethers.id("EIP712Domain(uint256 chainId,address verifyingContract)"), DOMAIN_TYPEHASH);
  assert.equal(ethers.id("SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)"), SAFE_TX_TYPEHASH);
  const abi = ethers.AbiCoder.defaultAbiCoder();
  for (const [chainId, tx] of [[31337n, safeTx(refund(3n), CALL, 7n)], [3417n, safeTx({ to: MULTISEND, value: 0n, data: encodeMultiSend([refund(1n), refund(2n)]) }, DELEGATECALL, 0n)]] as const) {
    const domainSeparator = ethers.keccak256(abi.encode(["bytes32", "uint256", "address"], [DOMAIN_TYPEHASH, chainId, SAFE]));
    const structHash = ethers.keccak256(abi.encode(
      ["bytes32", "address", "uint256", "bytes32", "uint8", "uint256", "uint256", "uint256", "address", "address", "uint256"],
      [SAFE_TX_TYPEHASH, tx.to, tx.value, ethers.keccak256(tx.data), tx.operation, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, tx.nonce],
    ));
    assert.equal(safeTxHash(chainId, SAFE, tx), ethers.solidityPackedKeccak256(["bytes1", "bytes1", "bytes32", "bytes32"], ["0x19", "0x01", domainSeparator, structHash]));
  }
});

test("MultiSendCallOnly batches pack each call as operation|to|value|length|data", () => {
  const a = refund(1n), b = { to: "0x00000000000000000000000000000000000000dd", value: 5n, data: "0xabcd" };
  const [packed] = new ethers.Interface(["function multiSend(bytes)"]).decodeFunctionData("multiSend", encodeMultiSend([a, b]));
  const one = (c: Call) => "00" + c.to.slice(2).toLowerCase() + c.value.toString(16).padStart(64, "0") + ethers.dataLength(c.data).toString(16).padStart(64, "0") + c.data.slice(2);
  assert.equal(packed, "0x" + one(a) + one(b));

  assert.deepEqual(bundle([a], MULTISEND), { call: a, operation: CALL }, "a single call isn't batched");
  const batched = bundle([a, b], MULTISEND);
  assert.equal(batched.operation, DELEGATECALL);
  assert.equal(batched.call.to, MULTISEND);
  assert.throws(() => bundle([a, b], null), /MultiSendCallOnly/);
  assert.throws(() => bundle([], MULTISEND), /Nothing/);
});

test("signatures are recovered from EIP-712 signing, and packed in ascending owner order", async () => {
  const tx = safeTx(refund(3n), CALL, 0n);
  const hash = safeTxHash(31337n, SAFE, tx);
  const { domain, types, message } = typedData(31337n, SAFE, tx);
  const sigs: Record<string, string> = {};
  for (const o of owners) sigs[o.address] = await o.signTypedData(domain, types, message);
  for (const o of owners) assert.equal(signerOf(hash, sigs[o.address]), o.address);

  const order = [...owners].map((o) => o.address).sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
  const packed = packSignatures(sigs);
  assert.equal(ethers.dataLength(packed), 65 * 3);
  order.forEach((addr, i) => assert.equal(ethers.dataSlice(packed, 65 * i, 65 * (i + 1)), sigs[addr]));

  // eth_sign-style signatures (v + 4, a different scheme in Safe) are refused.
  const ethSign = ethers.Signature.from(sigs[owners[0].address]);
  assert.throws(() => signerOf(hash, ethers.concat([ethSign.r, ethSign.s, ethers.toBeHex(ethSign.v + 4, 1)])), /EIP-712/);
});

async function proposal(calls: Call[]): Promise<Proposal> {
  const { call, operation } = bundle(calls, MULTISEND);
  const tx = safeTx(call, operation, 4n);
  const p: Proposal = {
    format: PROPOSAL_FORMAT, chain: "ethereum", chainId: "31337", safe: SAFE, safeRole: "ops", description: "test",
    calls: calls.map((c) => ({ to: c.to, value: c.value.toString(), data: c.data, decoded: describeCall(c) })),
    tx: serializeTx(tx), safeTxHash: safeTxHash(31337n, SAFE, tx), signatures: {},
  };
  const { domain, types, message } = typedData(31337n, SAFE, tx);
  p.signatures[owners[0].address] = await owners[0].signTypedData(domain, types, message);
  return p;
}

test("a proposal is accepted as written, and refused once anything in it is changed", async () => {
  const good = await proposal([refund(1n), refund(2n)]);
  assert.equal(verifyProposal(good, MULTISEND).operation, DELEGATECALL);
  const edit = (f: (p: Proposal) => void) => { const p = structuredClone(good); f(p); return () => verifyProposal(p, MULTISEND); };

  const flipLastByte = (hex: string) => hex.slice(0, -2) + (hex.endsWith("ff") ? "00" : "ff");
  assert.throws(edit((p) => { p.tx.data = flipLastByte(String(p.tx.data)); }), /edited/, "calldata changed");
  assert.throws(edit((p) => { p.tx.nonce = "5"; }), /edited/, "nonce changed");
  assert.throws(edit((p) => { p.calls[1].data = refund(9n).data; }), /doesn't match the calls/, "reviewed calls differ from what executes");
  assert.throws(edit((p) => { p.calls.pop(); }), /doesn't match the calls/, "a hidden extra call");
  assert.throws(edit((p) => { p.signatures[owners[1].address] = p.signatures[owners[0].address]; }), /isn't that owner's/, "signature misfiled");
  assert.throws(edit((p) => { p.format = "other"; }), /proposal/);
  assert.throws(() => verifyProposal(good, "0x00000000000000000000000000000000000000ee"), /doesn't match|MultiSendCallOnly/, "a delegatecall anywhere else");
});

test("proposals that refund gas out of the Safe are refused", async () => {
  const p = await proposal([refund(1n)]);
  const tx = safeTx(refund(1n), CALL, 4n);
  tx.gasPrice = 1n;
  p.tx = serializeTx(tx);
  p.safeTxHash = safeTxHash(31337n, SAFE, tx);
  p.signatures = {};
  assert.throws(() => verifyProposal(p, MULTISEND), /gas refunds/);
});

test("calls are shown decoded for review", () => {
  assert.equal(describeCall(refund(3n), { [ethers.getAddress(GATEWAY)]: "gateway" }), "gateway.refund(3, 0x1111111111111111111111111111111111111111, 2000000, false)");
  assert.equal(describeCall({ to: GATEWAY, value: 0n, data: gateway.encodeFunctionData("withdraw", [5n]) }), `${GATEWAY}.withdraw(5)`);
  assert.match(describeCall({ to: GATEWAY, value: 0n, data: "0xdeadbeef00" }), /not a known call/);
  const erc20 = new ethers.Interface(["function transfer(address,uint256)"]);
  assert.equal(describeCall({ to: GATEWAY, value: 0n, data: erc20.encodeFunctionData("transfer", [MULTISEND, 8_000_000n]) }), `${GATEWAY}.transfer(${MULTISEND}, 8000000)`);
  assert.match(describeCall({ to: GATEWAY, value: ethers.parseEther("1"), data: "0x" }), /send to .* with 1\.0 native/);
});

test("reviews decode the real calldata and ignore the file's own description of it", async () => {
  // A proposal that passes every integrity check, but whose stored `decoded` text lies about the call.
  const p = await proposal([refund(5n)]);
  p.calls[0].decoded = "gateway.setPaused(true) - harmless";
  assert.doesNotThrow(() => verifyProposal(p, MULTISEND), "the text isn't part of what's signed");
  const [line] = reviewCalls(p, { [ethers.getAddress(GATEWAY)]: "gateway" });
  assert.match(line, /^gateway\.refund\(5, /);
  assert.doesNotMatch(line, /setPaused|harmless/);
});

