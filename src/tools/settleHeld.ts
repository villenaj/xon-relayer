// Operator command: pays out an AssetHub/Ethereum deposit that was held for being over a
// per-deposit cap - the relayer's own, or XonVendingMachine's on-chain limit (status "held" in the
// ledger). A market-price deposit (SwapDeposited) is paid the same way the relayer would have:
// swapped at the DEX's price, with the buyer's own minimum. Bypasses the relayer's caps - that's the point - though not the contract's, so it only
// takes the ledger's word for *which chain* the deposit is on: the beneficiary and amount are
// re-read from the deposit tx itself on the source chain, which must also be past that chain's
// confirmation threshold.
//
// Usage: npm run settle-held -- <source tx hash> [--index <n>]
// --index picks one deposit when the tx holds several held ones (the alert says which).

import { ethers } from "ethers";
import { getSafeHead, makeProvider, verifyEndpoint } from "../chain.js";
import { config, loadRelayerKey, USDT_DECIMALS } from "../config.js";
import { classifySettleError, describeError } from "../errorClassifier.js";
import { makeLedger, readLedger } from "../ledger.js";
import { createSettlementClient, depositIdAt, externalDepositId } from "../settlement.js";
import { parseGatewayDeposit } from "../adapters/evmGatewayAdapter.js";
import { externalChain, GATEWAY_DEPOSIT_TOPICS, option, runTool } from "./common.js";
import GATEWAY_ABI from "../abi/EthUsdtGateway.json" with { type: "json" };

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
  const depositIndex = held.depositIndex ?? 0;

  const chain = externalChain(config, held.sourceChain);
  if (!chain) throw new Error(`No RPC/gateway configured for source chain "${held.sourceChain}".`);

  // Re-derive the deposit from the source chain rather than trusting the ledger file.
  const provider = makeProvider(chain.rpcUrl, config.rpcTimeoutMs);
  await verifyEndpoint(provider, { label: chain.name, expectedChainId: chain.chainId, contracts: { UsdtGateway: chain.gatewayAddress } });
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
  });
  const ledger = makeLedger(config.ledgerFile);
  const entry = {
    adapter: LABEL, buyer, usdtAmount, sourceChain: held.sourceChain,
    sourceTxHash: receipt.hash, depositIndex, depositId, sourceBlock: receipt.blockNumber,
    ...(minXonOut === undefined ? {} : { minXonOut }),
  };

  if (await settlement.isExternalSettled(depositId)) {
    console.log("Already settled on-chain - nothing to do.");
    ledger.record({ ...entry, status: "already-settled" });
    return;
  }

  try {
    const settleReceipt = minXonOut === undefined
      ? await settlement.settleExternal(buyer, usdtAmount, held.sourceChain, depositId, LABEL)
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
    throw err;
  }
}

runTool(main);
