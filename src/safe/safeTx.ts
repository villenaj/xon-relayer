// Safe (v1.4.1) transactions for the contracts' owner / guardian Safes, without Safe's hosted transaction
// service (it doesn't cover Asset Hub or Xode): a proposal is a JSON file that signers pass around. Each
// signer checks it against the chain, adds an EIP-712 signature (from a key here, or pasted from a
// wallet / hardware wallet), and anyone with gas executes it once enough owners have signed.
//
// Everything here is pure - no network - so it can be tested on its own; tools/safe.ts does the I/O.

import { ethers } from "ethers";
import GATEWAY_ABI from "../abi/EthUsdtGateway.json" with { type: "json" };
import VENDING_ABI from "../abi/XonVendingMachine.json" with { type: "json" };

export const PROPOSAL_FORMAT = "xon-safe-proposal/1";

/// Safe's operation: a plain call, or a delegatecall (only ever to MultiSendCallOnly here).
export const CALL = 0;
export const DELEGATECALL = 1;

export interface Call {
  to: string;
  value: bigint;
  data: string;
}

/// The fields Safe signs (its `SafeTx` EIP-712 struct). Gas refunds are never used: the executor pays.
export interface SafeTx {
  to: string;
  value: bigint;
  data: string;
  operation: number;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: string;
  refundReceiver: string;
  nonce: bigint;
}

export interface Proposal {
  format: string;
  chain: string;
  chainId: string;
  safe: string;
  /// Which of the chain's Safes this is for ("ops", "guardian", ...), for people.
  safeRole: string;
  description: string;
  /// The individual calls, decoded for review (one, or a MultiSendCallOnly batch).
  calls: { to: string; value: string; data: string; decoded: string }[];
  tx: Record<keyof SafeTx, string | number>;
  safeTxHash: string;
  /// Owner address (checksummed) -> 65-byte signature.
  signatures: Record<string, string>;
  executed?: { txHash: string; block: number };
}

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
};

export function safeTx(call: Call, operation: number, nonce: bigint): SafeTx {
  return {
    to: ethers.getAddress(call.to), value: call.value, data: call.data, operation,
    safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress, nonce,
  };
}

/// One call goes as-is; several become a single delegatecall to MultiSendCallOnly (all-or-nothing).
export function bundle(calls: Call[], multiSendCallOnly: string | null): { call: Call; operation: number } {
  if (calls.length === 0) throw new Error("Nothing to propose.");
  if (calls.length === 1) return { call: calls[0], operation: CALL };
  if (!multiSendCallOnly) throw new Error("Batching several calls needs this chain's MultiSendCallOnly address in the Safe config.");
  return { call: { to: multiSendCallOnly, value: 0n, data: encodeMultiSend(calls) }, operation: DELEGATECALL };
}

/// MultiSendCallOnly's `multiSend(bytes)`: each call packed as operation (uint8, always 0 - the
/// CallOnly variant refuses delegatecalls), to (20 bytes), value (uint256), data length (uint256), data.
export function encodeMultiSend(calls: Call[]): string {
  const packed = ethers.concat(calls.map((c) => ethers.solidityPacked(
    ["uint8", "address", "uint256", "uint256", "bytes"],
    [CALL, ethers.getAddress(c.to), c.value, ethers.dataLength(c.data), c.data],
  )));
  return new ethers.Interface(["function multiSend(bytes transactions)"]).encodeFunctionData("multiSend", [packed]);
}

export function typedData(chainId: bigint, safe: string, tx: SafeTx) {
  return { domain: { chainId, verifyingContract: ethers.getAddress(safe) }, types: SAFE_TX_TYPES, primaryType: "SafeTx" as const, message: tx };
}

export function safeTxHash(chainId: bigint, safe: string, tx: SafeTx): string {
  const { domain, types, message } = typedData(chainId, safe, tx);
  return ethers.TypedDataEncoder.hash(domain, types, message);
}

/// The owner who produced `signature` over `hash` - an EIP-712 signature (v 27/28), as a key or a
/// wallet's eth_signTypedData_v4 makes it.
export function signerOf(hash: string, signature: string): string {
  // Check v from the raw bytes first: other Safe signature types (eth_sign's v + 4, contract
  // signatures' v = 0, pre-approved hashes' v = 1) mean something else to Safe and aren't produced here.
  if (!ethers.isHexString(signature, 65)) throw new Error("A signature is 65 bytes of hex.");
  const v = ethers.getBytes(signature)[64];
  if (v !== 27 && v !== 28) throw new Error("Only EIP-712 signatures (v = 27 / 28) are accepted.");
  return ethers.recoverAddress(hash, ethers.Signature.from(signature));
}

/// Safe wants signatures concatenated in ascending owner order.
export function packSignatures(signatures: Record<string, string>): string {
  return ethers.concat(Object.entries(signatures)
    .sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1))
    .map(([, sig]) => ethers.Signature.from(sig).serialized));
}

export function serializeTx(tx: SafeTx): Proposal["tx"] {
  return { ...tx, value: tx.value.toString(), safeTxGas: tx.safeTxGas.toString(), baseGas: tx.baseGas.toString(), gasPrice: tx.gasPrice.toString(), nonce: tx.nonce.toString() };
}

export function parseTx(tx: Proposal["tx"]): SafeTx {
  return {
    to: ethers.getAddress(String(tx.to)), value: BigInt(tx.value), data: String(tx.data), operation: Number(tx.operation),
    safeTxGas: BigInt(tx.safeTxGas), baseGas: BigInt(tx.baseGas), gasPrice: BigInt(tx.gasPrice),
    gasToken: ethers.getAddress(String(tx.gasToken)), refundReceiver: ethers.getAddress(String(tx.refundReceiver)), nonce: BigInt(tx.nonce),
  };
}

/// Checks a proposal file is self-consistent: its hash is the hash of its own transaction, the reviewed
/// calls are exactly what the transaction executes, no gas refunds, and every signature is by the owner
/// it's filed under. Throws on anything off - a tampered file is never signed or executed.
export function verifyProposal(p: Proposal, multiSendCallOnly: string | null): SafeTx {
  if (p.format !== PROPOSAL_FORMAT) throw new Error(`Not a ${PROPOSAL_FORMAT} proposal.`);
  const tx = parseTx(p.tx);
  const hash = safeTxHash(BigInt(p.chainId), p.safe, tx);
  if (hash !== p.safeTxHash) throw new Error(`The proposal's safeTxHash ${p.safeTxHash} isn't the hash of its transaction (${hash}) - it was edited.`);
  if (tx.safeTxGas !== 0n || tx.baseGas !== 0n || tx.gasPrice !== 0n || tx.gasToken !== ethers.ZeroAddress || tx.refundReceiver !== ethers.ZeroAddress) {
    throw new Error("The proposal pays gas refunds out of the Safe - not something this tool proposes.");
  }
  const calls: Call[] = p.calls.map((c) => ({ to: c.to, value: BigInt(c.value), data: c.data }));
  const expected = bundle(calls, multiSendCallOnly);
  if (ethers.getAddress(expected.call.to) !== tx.to || expected.call.data !== tx.data || expected.call.value !== tx.value || expected.operation !== tx.operation) {
    throw new Error("The proposal's transaction doesn't match the calls listed for review.");
  }
  if (tx.operation === DELEGATECALL && (!multiSendCallOnly || tx.to !== ethers.getAddress(multiSendCallOnly))) {
    throw new Error("A delegatecall is only ever allowed to this chain's MultiSendCallOnly.");
  }
  for (const [owner, sig] of Object.entries(p.signatures)) {
    if (signerOf(hash, sig) !== ethers.getAddress(owner)) throw new Error(`The signature filed under ${owner} isn't that owner's.`);
  }
  return tx;
}

const KNOWN = [
  new ethers.Interface(VENDING_ABI),
  new ethers.Interface(GATEWAY_ABI),
  // Treasury Safes mostly move tokens: show those plainly too.
  new ethers.Interface(["function transfer(address to, uint256 amount)", "function approve(address spender, uint256 amount)", "function transferFrom(address from, address to, uint256 amount)"]),
];

/// What each call in a proposal does, decoded from its calldata - never from the file's own
/// `decoded` text, which nothing verifies and a tampered file could word however it likes.
export function reviewCalls(p: Pick<Proposal, "calls">, names: Record<string, string> = {}): string[] {
  return p.calls.map((c) => describeCall({ to: c.to, value: BigInt(c.value), data: c.data }, names));
}

/// A call as people read it: `refund(3, 0xabc…, 2000000)`, or the raw selector if it isn't ours.
export function describeCall(call: Call, names: Record<string, string> = {}): string {
  const target = names[ethers.getAddress(call.to)] ?? call.to;
  const value = call.value > 0n ? ` with ${ethers.formatEther(call.value)} native` : "";
  if (call.data === "0x") return `send to ${target}${value}`;
  for (const iface of KNOWN) {
    try {
      const parsed = iface.parseTransaction({ data: call.data, value: call.value });
      if (parsed) return `${target}.${parsed.name}(${parsed.args.map((a) => (typeof a === "bigint" ? a.toString() : String(a))).join(", ")})${value}`;
    } catch {
      // not this interface
    }
  }
  return `${target}: ${call.data.slice(0, 10)}… (${ethers.dataLength(call.data)} bytes, not a known call)${value}`;
}
