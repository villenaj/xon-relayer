// Operator command: pays out an AssetHub/Ethereum deposit the relayer held for being over the
// per-deposit cap (status "held" in the ledger). Bypasses the caps - that's the point - so it only
// takes the ledger's word for *which chain* the deposit is on: the beneficiary and amount are
// re-read from the deposit tx itself on the source chain, which must also be past that chain's
// confirmation threshold.
//
// Usage: npm run settle-held -- <source tx hash>

import { ethers } from "ethers";
import { getSafeHead } from "../chain.js";
import { config, USDT_DECIMALS } from "../config.js";
import { describeError } from "../errorClassifier.js";
import { makeLedger, readLedger } from "../ledger.js";
import { createSettlementClient, externalDepositId } from "../settlement.js";
import { externalChain, runTool } from "./common.js";
import GATEWAY_ABI from "../abi/EthUsdtGateway.json" with { type: "json" };

const LABEL = "settle-held";

async function main(): Promise<void> {
  const sourceTxHash = process.argv[2]?.toLowerCase();
  if (!sourceTxHash || !ethers.isHexString(sourceTxHash, 32)) {
    throw new Error("Usage: npm run settle-held -- <source tx hash>");
  }

  const records = readLedger(config.ledgerFile).filter((r) => r.sourceTxHash.toLowerCase() === sourceTxHash);
  const held = records.find((r) => r.status === "held");
  if (!held) {
    throw new Error(`No "held" ledger entry for ${sourceTxHash} in ${config.ledgerFile} - only held deposits can be released here.`);
  }

  const chain = externalChain(config, held.sourceChain);
  if (!chain) throw new Error(`No RPC/gateway configured for source chain "${held.sourceChain}".`);

  // Re-derive the deposit from the source chain rather than trusting the ledger file.
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
  const gateway = new ethers.Contract(chain.gatewayAddress, GATEWAY_ABI, provider);
  const gatewayAddress = (await gateway.getAddress()).toLowerCase();
  const receipt = await provider.getTransactionReceipt(sourceTxHash);
  if (!receipt || receipt.status !== 1) throw new Error(`${sourceTxHash} not found or failed on ${held.sourceChain}.`);
  if (receipt.blockNumber > await getSafeHead(provider, chain.confirmations)) {
    throw new Error(`${sourceTxHash} isn't past ${held.sourceChain}'s confirmation threshold yet - try again later.`);
  }
  const deposit = receipt.logs
    .filter((log) => log.address.toLowerCase() === gatewayAddress)
    .map((log) => gateway.interface.parseLog(log))
    .find((parsed) => parsed?.name === "Deposited");
  if (!deposit) throw new Error(`${sourceTxHash} has no Deposited event from the gateway at ${gatewayAddress}.`);

  const buyer: string = deposit.args.xodeBeneficiary;
  const usdtAmount: bigint = deposit.args.usdtAmount;
  const depositId = externalDepositId(held.sourceChain, receipt.hash);
  const usdt = `${ethers.formatUnits(usdtAmount, USDT_DECIMALS)} USDT`;
  console.log(`Releasing ${held.sourceChain} deposit ${receipt.hash}: ${usdt} to ${buyer} (deposit id ${depositId}).`);

  const settlement = await createSettlementClient({
    xodeEthRpc: config.xodeEthRpc,
    vendingAddress: config.vendingAddress,
    relayerPrivateKey: config.relayerPrivateKey,
  });
  const ledger = makeLedger(config.ledgerFile);
  const entry = {
    adapter: LABEL, buyer, usdtAmount, sourceChain: held.sourceChain,
    sourceTxHash: receipt.hash, depositId, sourceBlock: receipt.blockNumber,
  };

  if (await settlement.isExternalSettled(depositId)) {
    console.log("Already settled on-chain - nothing to do.");
    ledger.record({ ...entry, status: "already-settled" });
    return;
  }

  try {
    const settleReceipt = await settlement.settleExternal(buyer, usdtAmount, held.sourceChain, depositId, LABEL);
    ledger.record({ ...entry, status: "settled", settleTxHash: settleReceipt.hash, settleBlock: settleReceipt.blockNumber });
  } catch (err) {
    ledger.record({ ...entry, status: "failed", message: describeError(err) });
    throw err;
  }
}

runTool(main);
