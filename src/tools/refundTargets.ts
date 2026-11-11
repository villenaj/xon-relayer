// Which deposits are owed a refund, and how to pay each back - shared by `npm run refunds` and
// `npm run safe -- propose refund(s)`.

import { ethers } from "ethers";
import { hasOptionalView, makeProvider } from "../chain.js";
import { config } from "../config.js";
import type { LedgerRecord } from "../ledger.js";
import { depositIdAt, externalDepositId } from "../settlement.js";
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
  /// Whether that call keeps the gateway's refund fee: only when the deposit's own minimum wasn't met.
  chargeFee?: boolean;
  /// Gateway deposits: the id Xode's vending contract knows the deposit by, and whether it has been
  /// paid or cancelled there. A refund is only safe once it's cancelled (which can't happen once paid).
  depositId?: string;
  onXode?: { paid: boolean; cancelled: boolean };
  /// The ops Safe's call on Xode that cancels it (cancelExternalDeposit / cancelNativeDeposit).
  cancelCall?: { to: string; data: string };
  /// Gateway deposits: the gateway's deposit nonce, which its `Refunded` event names.
  depositNonce?: bigint;
  /// The gateway records deposits (has `refund`), whether or not this one is still recorded - a
  /// refunded deposit's record is cleared, so this can't be read off `refundCall`.
  recordsDeposits?: boolean;
}

const REFUNDED = new ethers.Interface([
  "event Refunded(uint256 indexed depositNonce, address indexed depositor, address indexed to, uint256 paid, uint256 fee)",
  "event Refunded(uint256 indexed depositNonce, address indexed depositor, uint256 amount)", // gateways before the refund fee
]);

/// Deposit errors that are the depositor's own doing, so a refund of them keeps the refund fee.
export const FEE_BEARING_ERRORS = new Set(["MinimumNotMet"]);
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
        if (!e || e.args.depositNonce !== target.depositNonce || ethers.getAddress(e.args.depositor) !== ethers.getAddress(target.payer)) return false;
        // The whole deposit is accounted for: paid back, less the fee if one was kept.
        return e.args.length === 5 ? e.args.paid + e.args.fee === amount : e.args.amount >= amount;
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

/// Finds a gateway deposit by its nonce: the tx it was made in, and the id Xode's vending contract
/// knows it by - recomputed from the chain the same way the relayer does, not taken from any file.
export async function gatewayDeposit(provider: ethers.JsonRpcProvider, gatewayAddress: string, sourceChain: string, nonce: bigint) {
  const nonceTopic = ethers.zeroPadValue(ethers.toBeHex(nonce), 32);
  const [log] = await provider.getLogs({ address: gatewayAddress, topics: [GATEWAY_DEPOSIT_TOPICS, null, null, nonceTopic], fromBlock: 0, toBlock: "latest" });
  if (!log) throw new Error(`No deposit #${nonce} on the ${sourceChain} gateway ${gatewayAddress}.`);
  const receipt = await provider.getTransactionReceipt(log.transactionHash);
  const index = receipt!.logs
    .filter((l) => l.address.toLowerCase() === gatewayAddress.toLowerCase() && GATEWAY_DEPOSIT_TOPICS.includes(l.topics[0]))
    .sort((a, b) => a.index - b.index)
    .findIndex((l) => l.index === log.index);
  return { txHash: log.transactionHash, index, depositId: depositIdAt(externalDepositId(sourceChain, log.transactionHash), index) };
}

/// Where Xode's vending contract stands on an external deposit.
export async function xodeStatus(depositId: string): Promise<{ paid: boolean; cancelled: boolean; cancelCall: { to: string; data: string } }> {
  const vending = new ethers.Contract(config.vendingAddress, VENDING_ABI, makeProvider(config.xodeEthRpc, config.rpcTimeoutMs));
  const [paid, cancelled]: boolean[] = await Promise.all([vending.externalSettledDeposits(depositId), vending.externalCancelled(depositId)]);
  return { paid, cancelled, cancelCall: { to: await vending.getAddress(), data: vending.interface.encodeFunctionData("cancelExternalDeposit", [depositId]) } };
}

export async function refundTarget(record: LedgerRecord): Promise<RefundTarget> {
  if (record.sourceChain === "xode") {
    const provider = makeProvider(config.xodeEthRpc, config.rpcTimeoutMs);
    const vending = new ethers.Contract(config.vendingAddress, VENDING_ABI, provider);
    const vendingAddress = await vending.getAddress();
    // For a Xode-native deposit the ledger's buyer *is* the USDT sender. Its USDT can only leave the
    // vending contract to the treasury, which then refunds the payer - but first the deposit is
    // cancelled (cancelNativeDeposit), so it can never also be paid and its USDT stops counting as
    // unaccounted. Older vending contracts can't cancel: then onXode/cancelCall are left out.
    const base = { provider, payer: record.buyer, usdtAddress: await vending.usdt(), heldBy: vendingAddress, depositId: record.depositId };
    if (!(await hasOptionalView(() => vending.nativeCancelled(ethers.ZeroHash)))) return base;
    const [paid, cancelled]: boolean[] = await Promise.all([vending.settledDeposits(record.depositId), vending.nativeCancelled(record.depositId)]);
    return {
      ...base,
      onXode: { paid, cancelled },
      cancelCall: { to: vendingAddress, data: vending.interface.encodeFunctionData("cancelNativeDeposit", [record.depositId, BigInt(record.usdtAmount)]) },
    };
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
  const chargeFee = FEE_BEARING_ERRORS.has(record.error ?? "");
  // Only a gateway without `depositRecords` counts as an older one - an RPC error is an error.
  const recordsDeposits = await hasOptionalView(() => gateway.depositRecords(0n));
  if (recordsDeposits) {
    const recorded: string = await gateway.depositRecords(event.args.depositNonce);
    if (recorded !== ethers.ZeroHash) {
      refundCall = { to: gatewayAddress, data: gateway.interface.encodeFunctionData("refund", [event.args.depositNonce, payer, event.args.usdtAmount, chargeFee]) };
    }
  }
  // Recomputed from the deposit itself, and checked against what the relayer recorded.
  const depositId = depositIdAt(externalDepositId(record.sourceChain, record.sourceTxHash), depositIndex);
  if (record.depositId && record.depositId.toLowerCase() !== depositId.toLowerCase()) {
    throw new Error(`The ledger's id for ${record.sourceTxHash} #${depositIndex} (${record.depositId}) isn't the one its deposit gives (${depositId}).`);
  }
  const { paid, cancelled, cancelCall } = await xodeStatus(depositId);
  return {
    provider, payer, usdtAddress: await gateway.usdt(), heldBy: gatewayAddress, refundCall, chargeFee,
    depositNonce: event.args.depositNonce, recordsDeposits, depositId, onXode: { paid, cancelled }, cancelCall,
  };
}
