// Operator command: tracks refunds for deposits that can never be settled ("skipped" in the
// ledger - e.g. ZeroAddress, XonTransferFailed, or a dust amount that rounds to 0 XON). Their USDT
// is stuck in the vending contract (Xode deposits) or the gateway (AssetHub/Ethereum deposits),
// and only that contract's *owner* can move it - deliberately not the relayer's key - so this
// doesn't send refunds. It tells you who to refund and from where - for a gateway with `refund`,
// the exact call (target + calldata) to propose from the owner Safe, which can only pay the
// original depositor - and records a refund once you've made it, after checking it on-chain.
//
// Usage:
//   npm run refunds                                     list deposits awaiting a refund
//   npm run refunds -- --all                            ...plus ones already refunded
//   npm run refunds -- mark <source tx> <refund tx>     record a refund, verified on-chain
//   npm run refunds -- mark <source tx> <refund tx> --force
//                                                       record it without checking (e.g. refunded
//                                                       some other way) - say why with --note "..."
//                                                       (and --to <address> if its gateway was retired)
//   ... mark <source tx> <refund tx> --index <n>        pick one deposit when the source tx holds
//                                                       several awaiting a refund

import { ethers } from "ethers";
import { config, USDT_DECIMALS } from "../config.js";
import { makeLedger, readLedger } from "../ledger.js";
import { option, runTool } from "./common.js";
import { awaitingRefund, refundProven, refundTarget } from "./refundTargets.js";


const usdt = (amount: bigint) => `${ethers.formatUnits(amount, USDT_DECIMALS)} USDT`;


async function list(showAll: boolean): Promise<void> {
  const records = readLedger(config.ledgerFile);
  const pending = awaitingRefund(records);

  console.log(pending.length === 0 ? "No deposits awaiting a refund." : `${pending.length} deposit(s) awaiting a refund:\n`);
  let total = 0n;
  for (const r of pending) {
    total += BigInt(r.usdtAmount);
    const index = (r.depositIndex ?? 0) > 0 ? ` #${r.depositIndex}` : "";
    console.log(`${r.sourceChain.padEnd(9)} ${r.sourceTxHash}${index}  ${usdt(BigInt(r.usdtAmount))}  (${r.error ?? "skipped"}, ${r.time})`);
    try {
      const t = await refundTarget(r);
      if (t.onXode?.paid) {
        console.log(`          !! already PAID on Xode (${t.depositId}) - do NOT refund; mark it settled after checking.`);
      } else if (t.refundCall) {
        if (!t.onXode?.cancelled) {
          console.log(`          1. cancel it on Xode first (ops Safe: npm run safe -- propose cancels --chain xode), or call`);
          console.log(`            to:   ${t.cancelCall!.to}\n            data: ${t.cancelCall!.data}`);
        }
        console.log(`          ${t.onXode?.cancelled ? "" : "2. "}refund ${usdt(BigInt(r.usdtAmount))}${t.chargeFee ? " less the refund fee (its minimum wasn't met)" : " in full"} to ${t.payer} on ${r.sourceChain}: have the gateway owner (e.g. its Safe) call`);
        console.log(`            to:   ${t.refundCall.to}\n            data: ${t.refundCall.data}`);
      } else if (r.sourceChain === "xode" && t.cancelCall) {
        if (!t.onXode?.cancelled) {
          console.log(`          1. cancel it on Xode (ops Safe: npm run safe -- propose cancels --chain xode), or call`);
          console.log(`            to:   ${t.cancelCall.to}\n            data: ${t.cancelCall.data}`);
        }
        console.log(`          ${t.onXode?.cancelled ? "" : "2. "}move ${usdt(BigInt(r.usdtAmount))} to the treasury (withdrawUsdt, ops Safe), and refund ${t.payer} on xode from the treasury`);
      } else if (r.sourceChain === "xode") {
        console.log(`          !! this vending contract can't cancel native deposits (no cancelNativeDeposit) - a refund would leave it payable. Redeploy before refunding it.`);
      } else {
        console.log(`          refund ${usdt(BigInt(r.usdtAmount))} (token ${t.usdtAddress}) to ${t.payer} on ${r.sourceChain}, from ${t.heldBy} using its owner key`);
      }
    } catch (err) {
      console.log(`          couldn't work out the refund target: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (pending.length > 0) {
    console.log(`\nTotal: ${usdt(total)}. After refunding, record it with: npm run refunds -- mark <source tx> <refund tx> [--index <n> for a #n deposit]`);
  }

  if (showAll) {
    const refunded = records.filter((r) => r.status === "refunded");
    console.log(`\n${refunded.length} refunded:`);
    for (const r of refunded) {
      console.log(`${r.sourceChain.padEnd(9)} ${r.sourceTxHash}  ${usdt(BigInt(r.usdtAmount))} -> ${r.refundTo ?? "?"} (tx ${r.refundTxHash ?? "?"}, ${r.time})${r.message ? ` - ${r.message}` : ""}`);
    }
  }
}

async function mark(sourceTxHash: string | undefined, refundTxHash: string | undefined, force: boolean, note: string | undefined, indexArg: string | undefined): Promise<void> {
  if (!sourceTxHash || !refundTxHash || !ethers.isHexString(sourceTxHash, 32) || !ethers.isHexString(refundTxHash, 32)) {
    throw new Error("Usage: npm run refunds -- mark <source tx hash> <refund tx hash> [--index <n>] [--force --note \"...\"]");
  }
  if (force && !note) throw new Error("--force needs a --note \"...\" saying how the refund was made.");
  const index = indexArg === undefined ? null : Number(indexArg);
  if (index !== null && (!Number.isInteger(index) || index < 0)) throw new Error(`--index must be a deposit position like 0 or 1 (got "${indexArg}").`);

  const records = readLedger(config.ledgerFile);
  const matches = awaitingRefund(records).filter((r) => r.sourceTxHash.toLowerCase() === sourceTxHash.toLowerCase()
    && (index === null || (r.depositIndex ?? 0) === index));
  if (matches.length > 1) {
    const indexes = matches.map((r) => r.depositIndex ?? 0).sort((a, b) => a - b).join(", ");
    throw new Error(`${sourceTxHash} has several deposits awaiting a refund (indexes ${indexes}) - pick one with --index <n>.`);
  }
  const [record] = matches;
  if (!record) {
    const refunded = records.some((r) => r.status === "refunded" && r.sourceTxHash.toLowerCase() === sourceTxHash.toLowerCase());
    throw new Error(refunded
      ? `${sourceTxHash} is already marked as refunded.`
      : `${sourceTxHash} isn't awaiting a refund (only "skipped" deposits with a non-zero amount are) - see npm run refunds.`);
  }

  const amount = BigInt(record.usdtAmount);
  let target: Awaited<ReturnType<typeof refundTarget>> | { payer: string; provider?: undefined };
  try {
    target = await refundTarget(record);
  } catch (err) {
    // E.g. the deposit sits on a gateway that has since been replaced, so it can't be looked up.
    const to = option(process.argv.slice(2), "--to");
    if (!force || !to || !ethers.isAddress(to)) throw new Error(`${err instanceof Error ? err.message : err}${force ? " - with --force, say who was refunded: --to <address>" : ""}`);
    target = { payer: ethers.getAddress(to) };
  }

  // A refunded deposit that isn't cancelled on Xode can still be paid there as well.
  if (!force && "onXode" in target && target.onXode && !target.onXode.cancelled) {
    throw new Error(`${record.sourceTxHash} isn't cancelled on Xode - cancel it first (npm run safe -- propose cancels --chain xode), so it can't also be paid.`);
  }
  if (!force && target.provider) {
    // The refund must be a successful tx on the deposit's own chain that transfers at least the
    // deposit amount of the same USDT token back to the original payer.
    const receipt = await target.provider.getTransactionReceipt(refundTxHash);
    if (!receipt) throw new Error(`Refund tx ${refundTxHash} not found on ${record.sourceChain} (is it mined, and on the right chain?).`);
    if (receipt.status !== 1) throw new Error(`Refund tx ${refundTxHash} failed on-chain.`);
    const proof = refundProven(receipt.logs, target, amount);
    if (!proof.ok) throw new Error(`Refund tx ${refundTxHash} doesn't refund ${record.sourceTxHash}: ${proof.reason}. Use --force --note "..." if it was refunded another way.`);
  }

  makeLedger(config.ledgerFile).record({
    adapter: "refunds",
    status: "refunded",
    buyer: record.buyer,
    usdtAmount: amount,
    sourceChain: record.sourceChain,
    sourceTxHash: record.sourceTxHash,
    depositIndex: record.depositIndex,
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
    await mark(args[1], args[2], args.includes("--force"), option(args, "--note"), option(args, "--index"));
  } else {
    await list(args.includes("--all"));
  }
});
