// Operator command: tracks refunds for deposits that can never be settled ("skipped" in the
// ledger - e.g. ZeroAddress, XonTransferFailed, or a dust amount that rounds to 0 XON). Their USDT
// is stuck in the vending contract (Xode deposits) or the gateway (AssetHub/Ethereum deposits),
// and only that contract's *owner* can move it - deliberately not the relayer's key - so this
// doesn't send refunds. It tells you who to refund and from where, and records a refund once
// you've made it, after checking it on-chain.
//
// Usage:
//   npm run refunds                                     list deposits awaiting a refund
//   npm run refunds -- --all                            ...plus ones already refunded
//   npm run refunds -- mark <source tx> <refund tx>     record a refund, verified on-chain
//   npm run refunds -- mark <source tx> <refund tx> --force
//                                                       record it without checking (e.g. refunded
//                                                       some other way) - say why with --note "..."

import { ethers } from "ethers";
import { config, USDT_DECIMALS } from "../config.js";
import { makeLedger, readLedger, type LedgerRecord } from "../ledger.js";
import { DEPOSITED_TOPIC, externalChain, option, runTool, TRANSFER_TOPIC } from "./common.js";
import GATEWAY_ABI from "../abi/EthUsdtGateway.json" with { type: "json" };
import VENDING_ABI from "../abi/XonVendingMachine.json" with { type: "json" };

interface RefundTarget {
  provider: ethers.JsonRpcProvider;
  /// Who paid the USDT - the refund goes back to them (not the Xode beneficiary).
  payer: string;
  usdtAddress: string;
  /// The contract the USDT is sitting in; its owner has to send the refund.
  heldBy: string;
}

const usdt = (amount: bigint) => `${ethers.formatUnits(amount, USDT_DECIMALS)} USDT`;

/// Skipped deposits with something to refund, not yet refunded or settled, one per deposit.
function awaitingRefund(records: LedgerRecord[]): LedgerRecord[] {
  const done = new Set(records
    .filter((r) => r.status === "refunded" || r.status === "settled" || r.status === "already-settled")
    .map((r) => r.depositId));
  const pending = new Map<string, LedgerRecord>();
  for (const r of records) {
    if (r.status === "skipped" && BigInt(r.usdtAmount) > 0n && !done.has(r.depositId)) pending.set(r.depositId, r);
  }
  return [...pending.values()];
}

async function refundTarget(record: LedgerRecord): Promise<RefundTarget> {
  if (record.sourceChain === "xode") {
    const provider = new ethers.JsonRpcProvider(config.xodeEthRpc);
    const vending = new ethers.Contract(config.vendingAddress, VENDING_ABI, provider);
    // For a Xode-native deposit the ledger's buyer *is* the USDT sender.
    return { provider, payer: record.buyer, usdtAddress: await vending.usdt(), heldBy: await vending.getAddress() };
  }

  const chain = externalChain(config, record.sourceChain);
  if (!chain) throw new Error(`No RPC/gateway configured for source chain "${record.sourceChain}".`);
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
  const gateway = new ethers.Contract(chain.gatewayAddress, GATEWAY_ABI, provider);
  const gatewayAddress = await gateway.getAddress();
  // The ledger records the Xode beneficiary; the refund goes to whoever actually paid on the
  // source chain, which only the deposit tx itself says.
  const receipt = await provider.getTransactionReceipt(record.sourceTxHash);
  const log = receipt?.logs.find((l) => l.address.toLowerCase() === gatewayAddress.toLowerCase() && l.topics[0] === DEPOSITED_TOPIC);
  if (!log) throw new Error(`Couldn't find the Deposited event for ${record.sourceTxHash} on ${record.sourceChain}.`);
  const payer: string = gateway.interface.parseLog(log)!.args.depositor;
  return { provider, payer, usdtAddress: await gateway.usdt(), heldBy: gatewayAddress };
}

async function list(showAll: boolean): Promise<void> {
  const records = readLedger(config.ledgerFile);
  const pending = awaitingRefund(records);

  console.log(pending.length === 0 ? "No deposits awaiting a refund." : `${pending.length} deposit(s) awaiting a refund:\n`);
  let total = 0n;
  for (const r of pending) {
    total += BigInt(r.usdtAmount);
    console.log(`${r.sourceChain.padEnd(9)} ${r.sourceTxHash}  ${usdt(BigInt(r.usdtAmount))}  (${r.error ?? "skipped"}, ${r.time})`);
    try {
      const t = await refundTarget(r);
      console.log(`          refund ${usdt(BigInt(r.usdtAmount))} (token ${t.usdtAddress}) to ${t.payer} on ${r.sourceChain}, from ${t.heldBy} using its owner key`);
    } catch (err) {
      console.log(`          couldn't work out the refund target: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (pending.length > 0) {
    console.log(`\nTotal: ${usdt(total)}. After refunding, record it with: npm run refunds -- mark <source tx> <refund tx>`);
  }

  if (showAll) {
    const refunded = records.filter((r) => r.status === "refunded");
    console.log(`\n${refunded.length} refunded:`);
    for (const r of refunded) {
      console.log(`${r.sourceChain.padEnd(9)} ${r.sourceTxHash}  ${usdt(BigInt(r.usdtAmount))} -> ${r.refundTo ?? "?"} (tx ${r.refundTxHash ?? "?"}, ${r.time})${r.message ? ` - ${r.message}` : ""}`);
    }
  }
}

async function mark(sourceTxHash: string | undefined, refundTxHash: string | undefined, force: boolean, note: string | undefined): Promise<void> {
  if (!sourceTxHash || !refundTxHash || !ethers.isHexString(sourceTxHash, 32) || !ethers.isHexString(refundTxHash, 32)) {
    throw new Error("Usage: npm run refunds -- mark <source tx hash> <refund tx hash> [--force --note \"...\"]");
  }
  if (force && !note) throw new Error("--force needs a --note \"...\" saying how the refund was made.");

  const records = readLedger(config.ledgerFile);
  const record = awaitingRefund(records).find((r) => r.sourceTxHash.toLowerCase() === sourceTxHash.toLowerCase());
  if (!record) {
    const refunded = records.some((r) => r.status === "refunded" && r.sourceTxHash.toLowerCase() === sourceTxHash.toLowerCase());
    throw new Error(refunded
      ? `${sourceTxHash} is already marked as refunded.`
      : `${sourceTxHash} isn't awaiting a refund (only "skipped" deposits with a non-zero amount are) - see npm run refunds.`);
  }

  const amount = BigInt(record.usdtAmount);
  const target = await refundTarget(record);

  if (!force) {
    // The refund must be a successful tx on the deposit's own chain that transfers at least the
    // deposit amount of the same USDT token back to the original payer.
    const receipt = await target.provider.getTransactionReceipt(refundTxHash);
    if (!receipt) throw new Error(`Refund tx ${refundTxHash} not found on ${record.sourceChain} (is it mined, and on the right chain?).`);
    if (receipt.status !== 1) throw new Error(`Refund tx ${refundTxHash} failed on-chain.`);
    const refunded = receipt.logs
      .filter((l) => l.address.toLowerCase() === target.usdtAddress.toLowerCase() && l.topics[0] === TRANSFER_TOPIC)
      .filter((l) => ethers.getAddress(ethers.dataSlice(l.topics[2], 12)) === ethers.getAddress(target.payer))
      .reduce((sum, l) => sum + ethers.toBigInt(l.data), 0n);
    if (refunded < amount) {
      throw new Error(
        `Refund tx ${refundTxHash} sends ${usdt(refunded)} of USDT ${target.usdtAddress} to ${target.payer}, ` +
        `less than the ${usdt(amount)} deposited. Use --force --note "..." if it was refunded another way.`,
      );
    }
  }

  makeLedger(config.ledgerFile).record({
    adapter: "refunds",
    status: "refunded",
    buyer: record.buyer,
    usdtAmount: amount,
    sourceChain: record.sourceChain,
    sourceTxHash: record.sourceTxHash,
    depositId: record.depositId,
    sourceBlock: record.sourceBlock,
    refundTxHash,
    refundTo: target.payer,
    message: force ? `not verified on-chain: ${note}` : undefined,
  });
  console.log(`Recorded refund of ${usdt(amount)} to ${target.payer} for ${record.sourceTxHash}${force ? " (unverified)" : " (verified on-chain)"}.`);
}

runTool(async () => {
  const args = process.argv.slice(2);
  if (args[0] === "mark") {
    await mark(args[1], args[2], args.includes("--force"), option(args, "--note"));
  } else {
    await list(args.includes("--all"));
  }
});
