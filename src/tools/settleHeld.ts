// Operator command: pays out a deposit the relayer held (status "held" in the ledger) instead of
// paying it automatically:
//   - AssetHub/Ethereum: over a per-deposit cap - the relayer's own, or XonVendingMachine's on-chain
//     limit - or the fixed-rate paths were paused. A market-price deposit (SwapDeposited) is paid the
//     way the relayer would have: swapped at the DEX's price, with the buyer's own minimum. Bypasses
//     the relayer's caps - that's the point - though not the contract's.
//   - Xode (a plain USDT transfer into the vending contract): over the per-purchase limit, the
//     buyer's per-address daily limit, or the fixed-rate paths were paused. Paid with settlePurchase
//     once whatever held it has cleared.
// Either way it only takes the ledger's word for *which deposit*: the beneficiary and amount are
// re-read from the chain, which must also be past that chain's confirmation threshold (and, for an
// external deposit, confirmed by the verify RPCs if any are set).
//
// Usage: npm run settle-held -- <source tx hash> [--index <n>]
// --index picks one deposit when the tx holds several held ones (the alert says which).

import { ethers } from "ethers";
import { getSafeHead, makeProvider, verifyEndpoint } from "../chain.js";
import { config, loadRelayerKey, USDT_DECIMALS } from "../config.js";
import { classifySettleError, describeError } from "../errorClassifier.js";
import { makeLedger, readLedger, type LedgerRecord } from "../ledger.js";
import { createSettlementClient, depositIdAt, externalDepositId } from "../settlement.js";
import { makeAccountedTransfers } from "../adapters/accountedTransfers.js";
import { connectCrossChecker } from "../adapters/crossCheck.js";
import { gatewayRecordsDeposits, isRefundedOnGateway, parseGatewayDeposit } from "../adapters/evmGatewayAdapter.js";
import { externalChain, GATEWAY_DEPOSIT_TOPICS, option, runTool, TRANSFER_TOPIC } from "./common.js";
import GATEWAY_ABI from "../abi/EthUsdtGateway.json" with { type: "json" };
import VENDING_ABI from "../abi/XonVendingMachine.json" with { type: "json" };

const LABEL = "settle-held";
const USAGE = "Usage: npm run settle-held -- <source tx hash> [--index <n>]";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sourceTxHash = args[0]?.toLowerCase();
  if (!sourceTxHash || !ethers.isHexString(sourceTxHash, 32)) throw new Error(USAGE);
  const indexArg = option(args, "--index");
  const index = indexArg === undefined ? null : Number(indexArg);
  if (index !== null && (!Number.isInteger(index) || index < 0)) throw new Error(`--index must be a deposit position like 0 or 1 (got "${indexArg}"). ${USAGE}`);

  // One per deposit - a deposit can be held more than once if its block was scanned again.
  const heldById = new Map(readLedger(config.ledgerFile)
    .filter((r) => r.sourceTxHash.toLowerCase() === sourceTxHash && r.status === "held")
    .filter((r) => index === null || (r.depositIndex ?? 0) === index)
    .map((r) => [r.depositId.toLowerCase(), r]));
  if (heldById.size === 0) {
    throw new Error(`No "held" ledger entry for ${sourceTxHash}${index === null ? "" : ` at index ${index}`} in ${config.ledgerFile} - only held deposits can be released here.`);
  }
  if (heldById.size > 1) {
    const indexes = [...heldById.values()].map((r) => r.depositIndex ?? 0).sort((a, b) => a - b).join(", ");
    throw new Error(`${sourceTxHash} has several held deposits (indexes ${indexes}) - pick one with --index <n>.`);
  }
  const [held] = heldById.values();
  await (held.sourceChain === "xode" ? releaseNative(held) : releaseExternal(held));
}

/// A held Xode-native deposit: the USDT transfer is re-read from Xode's logs (not the ledger, and
/// not a receipt - Xode's eth-rpc can lose those) and paid with settlePurchase.
async function releaseNative(held: LedgerRecord): Promise<void> {
  const depositIndex = held.depositIndex ?? 0;
  const provider = makeProvider(config.xodeEthRpc, config.rpcTimeoutMs);
  await verifyEndpoint(provider, { label: "xode", expectedChainId: config.xodeChainId, contracts: { XonVendingMachine: config.vendingAddress } });
  const vending = new ethers.Contract(config.vendingAddress, VENDING_ABI, provider);
  const vendingAddress = await vending.getAddress();
  const usdtAddress: string = await vending.usdt();

  if (held.sourceBlock > await getSafeHead(provider, config.xodeConfirmations)) {
    throw new Error(`${held.sourceTxHash} isn't past Xode's confirmation threshold yet - try again later.`);
  }
  // The ledger names the block; the chain has to agree that this tx's transfer is in it.
  const paddedVending = ethers.zeroPadValue(vendingAddress, 32).toLowerCase();
  const transfers = (await provider.getLogs({ address: usdtAddress, topics: [TRANSFER_TOPIC], fromBlock: held.sourceBlock, toBlock: held.sourceBlock }))
    .filter((l) => l.transactionHash.toLowerCase() === held.sourceTxHash.toLowerCase() && l.topics[2]?.toLowerCase() === paddedVending)
    .sort((a, b) => a.index - b.index);
  const log = transfers[depositIndex];
  if (!log) throw new Error(`Xode block ${held.sourceBlock} has no USDT transfer #${depositIndex} into the vending contract in ${held.sourceTxHash}.`);
  const depositId = depositIdAt(log.transactionHash, depositIndex);
  if (depositId.toLowerCase() !== held.depositId.toLowerCase()) {
    throw new Error(`Deposit #${depositIndex} of ${held.sourceTxHash} works out to id ${depositId}, but the ledger held ${held.depositId} - not releasing.`);
  }
  if (await makeAccountedTransfers(provider, usdtAddress, vendingAddress).isAccounted(log.blockNumber, log.transactionHash, log.index)) {
    throw new Error(`That transfer was pulled in by buy() / fundUsdtInventory() - it isn't a deposit to pay.`);
  }
  const buyer = ethers.getAddress(ethers.dataSlice(log.topics[1], 12));
  const usdtAmount = ethers.toBigInt(log.data);
  const usdt = `${ethers.formatUnits(usdtAmount, USDT_DECIMALS)} USDT`;
  console.log(`Releasing Xode deposit ${log.transactionHash} #${depositIndex}: ${usdt} to ${buyer} at the fixed rate (deposit id ${depositId}).`);

  const settlement = await createSettlementClient({
    xodeEthRpc: config.xodeEthRpc,
    vendingAddress: config.vendingAddress,
    relayerPrivateKey: loadRelayerKey().key,
    expectedChainId: config.xodeChainId,
    rpcTimeoutMs: config.rpcTimeoutMs,
    allowOwnerAsRelayer: config.allowOwnerAsRelayer,
    roles: { native: true, external: false },
  });
  const ledger = makeLedger(config.ledgerFile);
  const entry = {
    adapter: LABEL, buyer, usdtAmount, sourceChain: "xode", sourceTxHash: log.transactionHash,
    depositIndex, depositId, sourceBlock: log.blockNumber, sourceLogIndex: log.index,
  };
  if (await settlement.isNativeSettled(depositId)) {
    console.log("Already settled (or cancelled for a refund) on-chain - nothing to do.");
    ledger.record({ ...entry, status: "already-settled" });
    return;
  }

  try {
    const receipt = await settlement.settleNative(buyer, usdtAmount, depositId, LABEL);
    ledger.record({ ...entry, status: "settled", settleTxHash: receipt.hash, settleBlock: receipt.blockNumber });
  } catch (err) {
    ledger.record({ ...entry, status: "failed", message: describeError(err) });
    const why: Record<string, string> = {
      OverNativePurchaseLimit: `${usdt} is over XonVendingMachine's per-purchase limit - raise it with setNativeLimits (owner key, a queued change) first, then run this again`,
      OverNativeDailyLimit: `${usdt} is more than the native daily allowance has left right now - try again later`,
      OverAddressDailyLimit: `${buyer} has used up its per-address daily limit - try again once it has refilled`,
      FixedRatePaused: "the fixed-rate paths are paused - try again once they're resumed",
      UnverifiedDeposit: "the vending contract's USDT balance doesn't cover this deposit on top of what's accounted for - check `npm run reconcile`",
      DepositIsCancelled: "the owner cancelled this deposit to refund it - it must not be paid",
    };
    const { name } = classifySettleError(settlement.vending, err);
    if (name && why[name]) throw new Error(why[name]);
    throw err;
  }
}

async function releaseExternal(held: LedgerRecord): Promise<void> {
  const depositIndex = held.depositIndex ?? 0;
  const sourceTxHash = held.sourceTxHash.toLowerCase();
  const chain = externalChain(config, held.sourceChain);
  if (!chain) throw new Error(`No RPC/gateway configured for source chain "${held.sourceChain}".`);

  // Re-derive the deposit from the source chain rather than trusting the ledger file.
  const provider = makeProvider(chain.rpcUrl, config.rpcTimeoutMs);
  const chainId = await verifyEndpoint(provider, { label: chain.name, expectedChainId: chain.chainId, contracts: { UsdtGateway: chain.gatewayAddress } });
  const gateway = new ethers.Contract(chain.gatewayAddress, GATEWAY_ABI, provider);
  const gatewayAddress = (await gateway.getAddress()).toLowerCase();
  const receipt = await provider.getTransactionReceipt(sourceTxHash);
  if (!receipt || receipt.status !== 1) throw new Error(`${sourceTxHash} not found or failed on ${held.sourceChain}.`);
  if (receipt.blockNumber > await getSafeHead(provider, chain.confirmations)) {
    throw new Error(`${sourceTxHash} isn't past ${held.sourceChain}'s confirmation threshold yet - try again later.`);
  }
  const depositLog = receipt.logs
    .filter((log) => log.address.toLowerCase() === gatewayAddress && GATEWAY_DEPOSIT_TOPICS.includes(log.topics[0]))
    .sort((a, b) => a.index - b.index)[depositIndex];
  if (!depositLog) throw new Error(`${sourceTxHash} has no deposit event #${depositIndex} from the gateway at ${gatewayAddress}.`);
  const crossCheck = await connectCrossChecker(chain.verifyRpcUrls, {
    label: chain.name, chainId, gatewayAddress, confirmations: chain.confirmations, rpcTimeoutMs: config.rpcTimeoutMs,
  });
  const verdict = await crossCheck.check(depositLog);
  if (!verdict.ok) throw new Error(`Not releasing: ${verdict.reason}.`);
  const deposit = parseGatewayDeposit(gateway.interface, depositLog, held.sourceChain)!;

  const { buyer, usdtAmount, minXonOut } = deposit;
  const depositId = depositIdAt(externalDepositId(held.sourceChain, receipt.hash), depositIndex);
  if (depositId.toLowerCase() !== held.depositId.toLowerCase()) {
    throw new Error(`Deposit #${depositIndex} of ${sourceTxHash} works out to id ${depositId}, but the ledger held ${held.depositId} - not releasing.`);
  }
  const usdt = `${ethers.formatUnits(usdtAmount, USDT_DECIMALS)} USDT`;
  const price = minXonOut === undefined ? "at the fixed rate" : `at market price, minimum ${ethers.formatEther(minXonOut)} XON`;
  console.log(`Releasing ${held.sourceChain} deposit ${receipt.hash} #${depositIndex}: ${usdt} to ${buyer} ${price} (deposit id ${depositId}).`);

  const settlement = await createSettlementClient({
    xodeEthRpc: config.xodeEthRpc,
    vendingAddress: config.vendingAddress,
    relayerPrivateKey: loadRelayerKey().key,
    expectedChainId: config.xodeChainId,
    rpcTimeoutMs: config.rpcTimeoutMs,
    allowOwnerAsRelayer: config.allowOwnerAsRelayer,
    roles: { native: false, external: true },
  });
  const ledger = makeLedger(config.ledgerFile);
  const entry = {
    adapter: LABEL, buyer, usdtAmount, sourceChain: held.sourceChain,
    sourceTxHash: receipt.hash, depositIndex, depositId, sourceBlock: receipt.blockNumber, sourceLogIndex: depositLog.index,
    ...(minXonOut === undefined ? {} : { minXonOut }),
  };

  if (await isRefundedOnGateway(gateway, deposit.gatewayNonce, await gatewayRecordsDeposits(gateway))) {
    throw new Error(`Deposit #${depositIndex} of ${receipt.hash} was refunded on the gateway - it must not be paid out as well.`);
  }
  if (await settlement.isExternalSettled(depositId)) {
    console.log("Already settled on-chain - nothing to do.");
    ledger.record({ ...entry, status: "already-settled" });
    return;
  }

  try {
    const settleReceipt = minXonOut === undefined
      ? await settlement.settleExternal(buyer, usdtAmount, deposit.fixedMinXonOut ?? 1n, held.sourceChain, depositId, LABEL)
      : await settlement.settleExternalSwap(buyer, usdtAmount, minXonOut, held.sourceChain, depositId, LABEL);
    ledger.record({ ...entry, status: "settled", settleTxHash: settleReceipt.hash, settleBlock: settleReceipt.blockNumber });
  } catch (err) {
    ledger.record({ ...entry, status: "failed", message: describeError(err) });
    const { name } = classifySettleError(settlement.vending, err);
    if (name === "OverExternalDepositLimit") {
      throw new Error(`${usdt} is over XonVendingMachine's own per-deposit limit - raise it with setExternalLimits (owner key) first, then run this again.`);
    }
    if (minXonOut !== undefined && (name === null || name === "Error")) {
      throw new Error(`The swap failed - the pool may be paused, still pending approval, or now below the buyer's minimum of ${ethers.formatEther(minXonOut)} XON. Check the pool; if it can't meet the minimum, refund the deposit instead (npm run refunds).`);
    }
    if (name === "InsufficientUsdtInventory") {
      throw new Error(`XonVendingMachine doesn't hold ${usdt} of USDT inventory for a market-price payout - add some with fundUsdtInventory (owner key) first.`);
    }
    if (name === "OverExternalDailyLimit") {
      throw new Error(`${usdt} is more than XonVendingMachine's daily allowance has left right now - try again later, or raise it with setExternalLimits (owner key).`);
    }
    if (name === "FixedRatePaused") {
      throw new Error("The fixed-rate paths are paused - try again once they're resumed.");
    }
    throw err;
  }
}

runTool(main);
