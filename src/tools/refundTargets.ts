// Which deposits are owed a refund, and how to pay each back - shared by `npm run refunds` and
// `npm run safe -- propose refund(s)`.

import { ethers } from "ethers";
import { makeProvider } from "../chain.js";
import { config } from "../config.js";
import type { LedgerRecord } from "../ledger.js";
import { externalChain, GATEWAY_DEPOSIT_TOPICS } from "./common.js";
import GATEWAY_ABI from "../abi/EthUsdtGateway.json" with { type: "json" };
import VENDING_ABI from "../abi/XonVendingMachine.json" with { type: "json" };

export interface RefundTarget {
  provider: ethers.JsonRpcProvider;
  /// Who paid the USDT - the refund goes back to them (not the Xode beneficiary).
  payer: string;
  usdtAddress: string;
  /// The contract the USDT is sitting in; its owner has to send the refund.
  heldBy: string;
  /// Gateways with `refund`: the owner's call that pays this deposit back to its depositor.
  refundCall?: { to: string; data: string };
  /// Gateway deposits: the gateway's deposit nonce, which its `Refunded` event names.
  depositNonce?: bigint;
  /// The gateway records deposits (has `refund`), whether or not this one is still recorded - a
  /// refunded deposit's record is cleared, so this can't be read off `refundCall`.
  recordsDeposits?: boolean;
}

const REFUNDED = new ethers.Interface(["event Refunded(uint256 indexed depositNonce, address indexed depositor, uint256 amount)"]);
const TRANSFER = ethers.id("Transfer(address,address,uint256)");

/// Whether a refund tx's logs prove this deposit was refunded. On a gateway that records deposits,
/// only its own `Refunded` event for this exact deposit counts - so a batch refunding several deposits
/// of the same payer can't be credited to one it didn't include. Otherwise (older gateways, Xode),
/// enough of the right USDT must reach the payer.
export function refundProven(logs: readonly { address: string; topics: readonly string[]; data: string }[], target: Pick<RefundTarget, "payer" | "usdtAddress" | "heldBy" | "depositNonce" | "recordsDeposits">, amount: bigint): { ok: boolean; reason: string } {
  if (target.recordsDeposits && target.depositNonce !== undefined) {
    const named = logs.some((l) => {
      if (l.address.toLowerCase() !== target.heldBy.toLowerCase()) return false;
      try {
        const e = REFUNDED.parseLog({ topics: [...l.topics], data: l.data });
        return !!e && e.args.depositNonce === target.depositNonce && ethers.getAddress(e.args.depositor) === ethers.getAddress(target.payer) && e.args.amount >= amount;
      } catch {
        return false;
      }
    });
    return named ? { ok: true, reason: "" } : { ok: false, reason: `it has no Refunded event from the gateway for deposit #${target.depositNonce} - it refunded something else` };
  }
  const refunded = logs
    .filter((l) => l.address.toLowerCase() === target.usdtAddress.toLowerCase() && l.topics[0] === TRANSFER)
    .filter((l) => ethers.getAddress(ethers.dataSlice(l.topics[2], 12)) === ethers.getAddress(target.payer))
    .reduce((sum, l) => sum + ethers.toBigInt(l.data), 0n);
  return refunded >= amount ? { ok: true, reason: "" } : { ok: false, reason: `it sends ${ethers.formatUnits(refunded, 6)} USDT to ${target.payer}, less than the ${ethers.formatUnits(amount, 6)} deposited` };
}

/// Skipped deposits with something to refund, not yet refunded or settled, one per deposit.
export function awaitingRefund(records: LedgerRecord[]): LedgerRecord[] {
  const done = new Set(records
    .filter((r) => r.status === "refunded" || r.status === "settled" || r.status === "already-settled")
    .map((r) => r.depositId));
  const pending = new Map<string, LedgerRecord>();
  for (const r of records) {
    if (r.status === "skipped" && BigInt(r.usdtAmount) > 0n && !done.has(r.depositId)) pending.set(r.depositId, r);
  }
  return [...pending.values()];
}

export async function refundTarget(record: LedgerRecord): Promise<RefundTarget> {
  if (record.sourceChain === "xode") {
    const provider = makeProvider(config.xodeEthRpc, config.rpcTimeoutMs);
    const vending = new ethers.Contract(config.vendingAddress, VENDING_ABI, provider);
    // For a Xode-native deposit the ledger's buyer *is* the USDT sender.
    return { provider, payer: record.buyer, usdtAddress: await vending.usdt(), heldBy: await vending.getAddress() };
  }

  const chain = externalChain(config, record.sourceChain);
  if (!chain) throw new Error(`No RPC/gateway configured for source chain "${record.sourceChain}".`);
  const provider = makeProvider(chain.rpcUrl, config.rpcTimeoutMs);
  const gateway = new ethers.Contract(chain.gatewayAddress, GATEWAY_ABI, provider);
  const gatewayAddress = await gateway.getAddress();
  // The ledger records the Xode beneficiary; the refund goes to whoever actually paid on the
  // source chain, which only the deposit tx itself says.
  const receipt = await provider.getTransactionReceipt(record.sourceTxHash);
  const depositIndex = record.depositIndex ?? 0;
  const log = receipt?.logs
    .filter((l) => l.address.toLowerCase() === gatewayAddress.toLowerCase() && GATEWAY_DEPOSIT_TOPICS.includes(l.topics[0]))
    .sort((a, b) => a.index - b.index)[depositIndex];
  if (!log) throw new Error(`Couldn't find deposit event #${depositIndex} for ${record.sourceTxHash} on ${record.sourceChain}.`);
  const event = gateway.interface.parseLog(log)!;
  const payer: string = event.args.depositor;
  // Gateways with recorded deposits refund through `refund(nonce, depositor, amount)`, which can only
  // pay the original depositor; older ones need the owner's free-form withdraw.
  let refundCall: RefundTarget["refundCall"];
  let recordsDeposits = false;
  try {
    const recorded: string = await gateway.depositRecords(event.args.depositNonce);
    recordsDeposits = true;
    if (recorded !== ethers.ZeroHash) {
      refundCall = { to: gatewayAddress, data: gateway.interface.encodeFunctionData("refund", [event.args.depositNonce, payer, event.args.usdtAmount]) };
    }
  } catch {
    // An older gateway without deposit records.
  }
  return { provider, payer, usdtAddress: await gateway.usdt(), heldBy: gatewayAddress, refundCall, depositNonce: event.args.depositNonce, recordsDeposits };
}
