// Watches `UsdtGateway.Deposited` events on any EVM-compatible chain other than Xode itself
// (Ethereum, or AssetHub now that it runs pallet-revive) and settles the corresponding XON payout
// on Xode. One instance of this adapter runs per such chain - see ethereumAdapter.ts and
// assetHubAdapter.ts, which are both just this function called with a different chain config.
//
// This is a custodial leg regardless of which chain it watches: USDT deposited into the gateway
// contract just sits there under its `owner`'s control until manually moved - there's no on-chain
// link between that chain and Xode. The relayer's attestation (via settleExternalPurchase) is the
// only thing connecting the two. See XonVendingMachine.sol's doc comment for the full trust story.

import { ethers } from "ethers";
import { makeProvider, verifyEndpoint, type Confirmations } from "../chain.js";
import { USDT_DECIMALS } from "../config.js";
import { externalDepositId } from "../settlement.js";
import { runDepositScanner, type Deposit, type Gate } from "./depositScanner.js";
import type { AdapterContext } from "./types.js";
import GATEWAY_ABI from "../abi/EthUsdtGateway.json" with { type: "json" };

const DEPOSITED_TOPIC = ethers.id("Deposited(address,address,uint256,uint256)");

export interface EvmGatewayAdapterOptions extends AdapterContext {
  sourceChain: string;
  label: string;
  rpcUrl: string;
  gatewayAddress: string;
  startBlock: number | null;
  startBlockName: string;
  confirmations: Confirmations;
  /// Chain ID the RPC must report, if configured.
  expectedChainId: bigint | null;
  checkpointFile: string;
}

export async function runEvmGatewayAdapter(options: EvmGatewayAdapterOptions): Promise<void> {
  const { settlement, ledger, limiter, alerts, sourceChain, label, rpcUrl } = options;
  const provider = makeProvider(rpcUrl, options.config.rpcTimeoutMs);
  await verifyEndpoint(provider, { label, expectedChainId: options.expectedChainId, contracts: { UsdtGateway: options.gatewayAddress } });
  const gateway = new ethers.Contract(options.gatewayAddress, GATEWAY_ABI, provider);
  const gatewayAddress = await gateway.getAddress();

  // Payout caps (see payoutLimits.ts): over the per-deposit cap is held for an operator; over the
  // 24h cap pauses this adapter until older payouts age out.
  let capPaused = false;
  function gate(deposit: Deposit): Gate {
    const usdt = `${ethers.formatUnits(deposit.usdtAmount, USDT_DECIMALS)} USDT`;
    if (limiter.exceedsDepositCap(deposit.usdtAmount)) {
      alerts.send(`[${label}] Held deposit ${deposit.sourceTxHash}: ${usdt} to ${deposit.buyer} is over the per-deposit payout cap. After reviewing it, release with: npm run settle-held -- ${deposit.sourceTxHash}`);
      ledger.record({ adapter: label, ...deposit, status: "held", error: "OverDepositCap" });
      return { action: "skip" };
    }
    const release = limiter.reserve(deposit.usdtAmount);
    if (!release) {
      if (!capPaused) {
        const paid = `${ethers.formatUnits(limiter.usedInWindow(), USDT_DECIMALS)} USDT`;
        alerts.send(`[${label}] 24h payout cap reached (${paid} paid) - pausing at ${deposit.sourceTxHash} (${usdt}) until older payouts age out.`);
        capPaused = true;
      }
      return { action: "stall" };
    }
    if (capPaused) {
      console.log(`[${label}] Under the 24h payout cap again - resuming.`);
      capPaused = false;
    }
    return { action: "settle", release };
  }

  await runDepositScanner(options, {
    label,
    description: `UsdtGateway (${gatewayAddress}) deposits on ${rpcUrl}`,
    provider,
    logAddress: gatewayAddress,
    topic: DEPOSITED_TOPIC,
    confirmations: options.confirmations,
    checkpointFile: options.checkpointFile,
    checkpointIdentity: gatewayAddress,
    startBlock: options.startBlock,
    startBlockName: options.startBlockName,

    parse(log) {
      const parsed = gateway.interface.parseLog(log);
      if (!parsed) return null;
      return {
        buyer: parsed.args.xodeBeneficiary,
        usdtAmount: parsed.args.usdtAmount,
        sourceChain,
        sourceTxHash: log.transactionHash,
        depositId: externalDepositId(sourceChain, log.transactionHash),
        sourceBlock: log.blockNumber,
      };
    },
    isSettled: (d) => settlement.isExternalSettled(d.depositId),
    settle: (d) => settlement.settleExternal(d.buyer, d.usdtAmount, sourceChain, d.depositId, label),
    gate,
  });
}
