// Operator command: cross-checks the ledger against the chains, read-only. Exits 1 if it finds a
// problem, so it can run from cron and alert on failure.
//
//   1. Payouts: every Settled / ExternalSettled event XonVendingMachine emitted vs the ledger's
//      "settled" entries - a payout the ledger never recorded (another process with the relayer
//      key?), a ledger "settled" with no payout behind it, or the two disagreeing on recipient or
//      amount.
//   2. Deposits: every deposit on each source chain, up to that adapter's checkpoint (what the
//      relayer claims to have processed), must be paid out on-chain or accounted for in the ledger
//      (skipped / held / refunded) - otherwise it was missed.
//
// Usage: npm run reconcile -- [--xode-from <block>] [--assethub-from <block>] [--ethereum-from <block>]
// Each range defaults to the chain's configured start block, else the earliest block the ledger
// mentions for it; a chain with neither is skipped (pass --<chain>-from).

import { ethers } from "ethers";
import type { Log } from "ethers";
import path from "node:path";
import { makeProvider, scanLogs, verifyEndpoint } from "../chain.js";
import { makeCheckpoint } from "../checkpoint.js";
import { config, USDT_DECIMALS } from "../config.js";
import { readLedger, type LedgerRecord, type LedgerStatus } from "../ledger.js";
import { depositIdAt, externalDepositId } from "../settlement.js";
import { blockOption, DEPOSITED_TOPIC, externalChains, runTool, TRANSFER_TOPIC } from "./common.js";
import GATEWAY_ABI from "../abi/EthUsdtGateway.json" with { type: "json" };
import VENDING_ABI from "../abi/XonVendingMachine.json" with { type: "json" };

interface Payout {
  kind: "Settled" | "ExternalSettled";
  buyer: string;
  usdtIn: bigint;
  xonOut: bigint;
  txHash: string;
  block: number;
}

const issues: string[] = [];
const notes: string[] = [];
const usdt = (amount: bigint) => `${ethers.formatUnits(amount, USDT_DECIMALS)} USDT`;
const key = (hash: string) => hash.toLowerCase();

async function collectLogs(provider: ethers.JsonRpcProvider, address: string, topic: string, from: number, to: number): Promise<Log[]> {
  const all: Log[] = [];
  await scanLogs({ provider, address, topic, chunkSize: config.logChunkSize }, from, to, async (logs) => {
    all.push(...logs);
    return null;
  }, () => {});
  return all;
}

/// Pairs each deposit log with its position among its tx's deposits - part of its deposit id (see
/// depositIdAt). `logs` must be every deposit log of each tx they cover, as a whole-block scan gives.
function withDepositIndex(logs: Log[]): { log: Log; index: number }[] {
  const seen = new Map<string, number>();
  return [...logs]
    .sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)
    .map((log) => {
      const index = seen.get(key(log.transactionHash)) ?? 0;
      seen.set(key(log.transactionHash), index + 1);
      return { log, index };
    });
}

/// "0x…" or "0x… #2" - a source tx, plus which of its deposits when it isn't the first.
const describeDeposit = (txHash: string, index: number) => (index === 0 ? txHash : `${txHash} #${index}`);

/// The block after the last one an adapter's checkpoint says it finished, or null if it has none.
function checkpointedUpTo(file: string, identity: string, label: string): number | null {
  try {
    const next = makeCheckpoint<number>(path.join(config.checkpointDir, file), identity).load();
    return next === null ? null : next - 1;
  } catch (err) {
    notes.push(`${label}: couldn't read checkpoint (${err instanceof Error ? err.message : err}) - deposits not checked.`);
    return null;
  }
}

function minBlock(values: (number | undefined)[]): number | null {
  const present = values.filter((v): v is number => typeof v === "number");
  return present.length === 0 ? null : Math.min(...present);
}

runTool(async () => {
  const args = process.argv.slice(2);
  const records = readLedger(config.ledgerFile);
  const byDeposit = new Map<string, LedgerRecord[]>();
  for (const r of records) byDeposit.set(key(r.depositId), [...(byDeposit.get(key(r.depositId)) ?? []), r]);
  const has = (depositId: string, status: LedgerStatus) => (byDeposit.get(key(depositId)) ?? []).some((r) => r.status === status);
  const settledRecord = (depositId: string) => (byDeposit.get(key(depositId)) ?? []).find((r) => r.status === "settled");

  const xode = makeProvider(config.xodeEthRpc, config.rpcTimeoutMs);
  await verifyEndpoint(xode, { label: "xode", expectedChainId: config.xodeChainId, contracts: { XonVendingMachine: config.vendingAddress } });
  const vending = new ethers.Contract(config.vendingAddress, VENDING_ABI, xode);
  const vendingAddress = await vending.getAddress();
  console.log(`Ledger: ${config.ledgerFile} (${records.length} entries). Vending contract: ${vendingAddress}\n`);

  // --- 1. Payouts on Xode vs the ledger -------------------------------------------------------
  const payouts = new Map<string, Payout>();
  const xodeFrom = blockOption(args, "--xode-from") ?? config.xodeStartBlock
    ?? minBlock(records.flatMap((r) => [r.settleBlock, r.sourceChain === "xode" ? r.sourceBlock : undefined]));
  if (xodeFrom === null) {
    notes.push("Payouts: no --xode-from, XODE_START_BLOCK or ledger history to start from - not checked.");
  } else {
    const latest = await xode.getBlockNumber();
    for (const topic of [vending.interface.getEvent("Settled")!.topicHash, vending.interface.getEvent("ExternalSettled")!.topicHash]) {
      for (const log of await collectLogs(xode, vendingAddress, topic, xodeFrom, latest)) {
        const e = vending.interface.parseLog(log)!;
        const depositId: string = e.name === "Settled" ? e.args.depositTxHash : e.args.depositId;
        payouts.set(key(depositId), {
          kind: e.name as Payout["kind"], buyer: e.args.buyer, usdtIn: e.args.usdtIn, xonOut: e.args.xonOut,
          txHash: log.transactionHash, block: log.blockNumber,
        });
      }
    }

    let xonOut = 0n;
    for (const [depositId, p] of payouts) {
      xonOut += p.xonOut;
      const rec = settledRecord(depositId);
      if (!rec) {
        if (has(depositId, "already-settled")) {
          notes.push(`Payout ${p.txHash} (deposit ${depositId}) is only in the ledger as "already-settled" - an earlier attempt landed after being given up on.`);
        } else {
          issues.push(`UNRECORDED PAYOUT: ${p.kind} in tx ${p.txHash} (block ${p.block}) paid ${ethers.formatEther(p.xonOut)} XON to ${p.buyer} for deposit ${depositId}, which the ledger has no record of. Was it made by something other than this relayer?`);
        }
      } else if (ethers.getAddress(rec.buyer) !== ethers.getAddress(p.buyer) || BigInt(rec.usdtAmount) !== p.usdtIn) {
        issues.push(`MISMATCH: deposit ${depositId} - ledger says ${usdt(BigInt(rec.usdtAmount))} to ${rec.buyer}, on-chain payout ${p.txHash} says ${usdt(p.usdtIn)} to ${p.buyer}.`);
      }
    }
    for (const r of records) {
      if (r.status === "settled" && r.settleBlock !== undefined && r.settleBlock >= xodeFrom && r.settleBlock <= latest && !payouts.has(key(r.depositId))) {
        issues.push(`LEDGER-ONLY SETTLEMENT: ledger says deposit ${r.depositId} (${r.sourceChain} ${r.sourceTxHash}) was paid in ${r.settleTxHash}, but there's no payout event for it on-chain (reorg?).`);
      }
    }
    console.log(`Payouts (Xode blocks ${xodeFrom}-${latest}): ${payouts.size} on-chain, ${ethers.formatEther(xonOut)} XON paid out.`);
  }

  // --- 2. Deposits on each source chain -------------------------------------------------------
  async function checkDeposit(label: string, depositId: string, sourceTxHash: string, index: number, amount: bigint, settled: boolean): Promise<void> {
    const deposit = describeDeposit(sourceTxHash, index);
    if (settled) {
      const p = payouts.get(key(depositId));
      if (p && p.usdtIn !== amount) {
        issues.push(`MISMATCH: ${label} deposit ${deposit} was ${usdt(amount)} but its payout ${p.txHash} was for ${usdt(p.usdtIn)}.`);
      }
      return;
    }
    if (has(depositId, "refunded")) return;
    if (has(depositId, "held")) {
      notes.push(`${label} deposit ${deposit} (${usdt(amount)}) is held over the payout cap - npm run settle-held -- ${sourceTxHash}${index > 0 ? ` --index ${index}` : ""}`);
    } else if (has(depositId, "skipped")) {
      if (amount > 0n) notes.push(`${label} deposit ${deposit} (${usdt(amount)}) was skipped and not yet refunded - see npm run refunds.`);
    } else {
      issues.push(`MISSED DEPOSIT: ${label} deposit ${deposit} (${usdt(amount)}) is behind the adapter's checkpoint but was never paid and isn't in the ledger as skipped/held/refunded.`);
    }
  }

  // Xode-native: USDT transfers into the vending contract.
  {
    const to = checkpointedUpTo(config.xodeCheckpointFile, vendingAddress, "xode");
    const from = blockOption(args, "--xode-from") ?? config.xodeStartBlock
      ?? minBlock(records.filter((r) => r.sourceChain === "xode").map((r) => r.sourceBlock));
    if (to === null) {
      notes.push("xode: no checkpoint yet - deposits not checked.");
    } else if (from === null) {
      notes.push("xode: no --xode-from, XODE_START_BLOCK or ledger history to start from - deposits not checked.");
    } else {
      const usdtAddress: string = await vending.usdt();
      const paddedVending = key(ethers.zeroPadValue(vendingAddress, 32));
      const deposits = (await collectLogs(xode, usdtAddress, TRANSFER_TOPIC, from, to)).filter((l) => key(l.topics[2]) === paddedVending);
      for (const { log, index } of withDepositIndex(deposits)) {
        const depositId = depositIdAt(log.transactionHash, index);
        const settled: boolean = await vending.settledDeposits(depositId);
        await checkDeposit("xode", depositId, log.transactionHash, index, ethers.toBigInt(log.data), settled);
      }
      console.log(`Deposits on xode (blocks ${from}-${to}): ${deposits.length}.`);
    }
  }

  // AssetHub / Ethereum: Deposited events on each gateway.
  for (const chain of externalChains(config)) {
    const provider = makeProvider(chain.rpcUrl, config.rpcTimeoutMs);
    await verifyEndpoint(provider, { label: chain.name, expectedChainId: chain.chainId, contracts: { UsdtGateway: chain.gatewayAddress } });
    const gateway = new ethers.Contract(chain.gatewayAddress, GATEWAY_ABI, provider);
    const gatewayAddress = await gateway.getAddress();
    const to = checkpointedUpTo(chain.checkpointFile, gatewayAddress, chain.name);
    const from = blockOption(args, `--${chain.name}-from`) ?? chain.startBlock
      ?? minBlock(records.filter((r) => r.sourceChain === chain.name).map((r) => r.sourceBlock));
    if (to === null) {
      notes.push(`${chain.name}: no checkpoint yet - deposits not checked.`);
      continue;
    }
    if (from === null) {
      notes.push(`${chain.name}: no --${chain.name}-from, start block or ledger history to start from - deposits not checked.`);
      continue;
    }

    const logs = await collectLogs(provider, gatewayAddress, DEPOSITED_TOPIC, from, to);
    for (const { log, index } of withDepositIndex(logs)) {
      const amount: bigint = gateway.interface.parseLog(log)!.args.usdtAmount;
      const depositId = depositIdAt(externalDepositId(chain.name, log.transactionHash), index);
      const settled: boolean = await vending.externalSettledDeposits(depositId);
      await checkDeposit(chain.name, depositId, log.transactionHash, index, amount, settled);
    }
    console.log(`Deposits on ${chain.name} (blocks ${from}-${to}): ${logs.length}.`);
  }

  // --- Report ----------------------------------------------------------------------------------
  if (notes.length > 0) console.log(`\nNotes (${notes.length}):\n${notes.map((n) => `  - ${n}`).join("\n")}`);
  if (issues.length > 0) {
    console.log(`\nPROBLEMS (${issues.length}):\n${issues.map((i) => `  !! ${i}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("\nNo problems found.");
  }
});
