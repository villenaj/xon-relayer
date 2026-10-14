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
import type { Log } from "ethers";
import path from "node:path";
import { describeConfirmations, getSafeHead, scanLogs, type Confirmations } from "../chain.js";
import { makeCheckpoint } from "../checkpoint.js";
import { USDT_DECIMALS } from "../config.js";
import { externalDepositId } from "../settlement.js";
import { classifySettleError, describeError } from "../errorClassifier.js";
import type { AdapterContext } from "./types.js";
import GATEWAY_ABI from "../abi/EthUsdtGateway.json" with { type: "json" };

const DEPOSITED_TOPIC = ethers.id("Deposited(address,address,uint256,uint256)");

export interface EvmGatewayAdapterOptions extends AdapterContext {
  sourceChain: string;
  label: string;
  rpcUrl: string;
  gatewayAddress: string;
  startBlock: number | null;
  confirmations: Confirmations;
  checkpointFile: string;
}

export async function runEvmGatewayAdapter({
  settlement, config, ledger, limiter, sourceChain, label, rpcUrl, gatewayAddress, startBlock, confirmations, checkpointFile,
}: EvmGatewayAdapterOptions): Promise<never> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const gateway = new ethers.Contract(gatewayAddress, GATEWAY_ABI, provider);
  const resolvedGatewayAddress = await gateway.getAddress();

  const checkpoint = makeCheckpoint<number>(path.join(config.checkpointDir, checkpointFile), resolvedGatewayAddress);

  console.log(`[${label}] Watching UsdtGateway (${resolvedGatewayAddress}) deposits on ${rpcUrl}, settling after ${describeConfirmations(confirmations)}`);

  const checkpointed = checkpoint.load();
  let fromBlock: number;
  if (checkpointed !== null) {
    fromBlock = checkpointed;
    console.log(`[${label}] Resuming from checkpoint: block ${fromBlock}.`);
  } else if (startBlock !== null) {
    fromBlock = startBlock;
    console.log(`[${label}] No checkpoint. Starting from configured start block ${fromBlock}.`);
  } else {
    fromBlock = (await provider.getBlockNumber()) + 1;
    console.warn(`[${label}] No checkpoint/start block - starting from current block (${fromBlock}). Pre-existing deposits will be missed.`);
  }

  // Settles each deposit in order; returns the block of the first one that needs retrying, if any.
  async function settleLogs(logs: Log[]): Promise<number | null> {
    for (const log of logs) {
      const parsed = gateway.interface.parseLog(log);
      if (!parsed) continue;
      const xodeBeneficiary: string = parsed.args.xodeBeneficiary;
      const usdtAmount: bigint = parsed.args.usdtAmount;
      const depositId = externalDepositId(sourceChain, log.transactionHash);

      if (await settlement.isExternalSettled(depositId)) {
        console.log(`[${label}] Skipping ${log.transactionHash} - already settled.`);
        continue;
      }

      const entry = {
        adapter: label, buyer: xodeBeneficiary, usdtAmount, sourceChain,
        sourceTxHash: log.transactionHash, depositId, sourceBlock: log.blockNumber,
      };
      const usdt = `${ethers.formatUnits(usdtAmount, USDT_DECIMALS)} USDT`;

      if (limiter.exceedsDepositCap(usdtAmount)) {
        console.warn(`[${label}] Holding ${log.transactionHash} (${usdt}) - over the per-deposit payout cap. Release it with: npm run settle-held -- ${log.transactionHash}`);
        ledger.record({ ...entry, status: "held", error: "OverDepositCap" });
        continue;
      }
      const release = limiter.reserve(usdtAmount);
      if (!release) {
        console.warn(`[${label}] 24h payout cap reached (${ethers.formatUnits(limiter.usedInWindow(), USDT_DECIMALS)} USDT paid) - pausing at ${log.transactionHash} (${usdt}) until it frees up.`);
        return log.blockNumber;
      }

      try {
        const receipt = await settlement.settleExternal(xodeBeneficiary, usdtAmount, sourceChain, depositId, label);
        ledger.record({ ...entry, status: "settled", settleTxHash: receipt.hash, settleBlock: receipt.blockNumber });
      } catch (err) {
        release();
        const { kind, name } = classifySettleError(settlement.vending, err);
        if (kind === "already-done") {
          console.log(`[${label}] ${log.transactionHash} was already settled by another attempt (${name}) - continuing.`);
          ledger.record({ ...entry, status: "already-settled", error: name });
          continue;
        }
        if (kind === "permanent") {
          console.error(`[${label}] Permanently skipping ${log.transactionHash} - reverted with ${name}, which can never succeed by retrying.`);
          ledger.record({ ...entry, status: "skipped", error: name });
          continue;
        }
        console.error(`[${label}] Failed to settle ${log.transactionHash} (${name ?? "unknown"}), will retry next tick:`, describeError(err));
        ledger.record({ ...entry, status: "failed", error: name, message: describeError(err) });
        return log.blockNumber;
      }
    }
    return null;
  }

  async function tick(): Promise<void> {
    const toBlock = await getSafeHead(provider, confirmations);
    const scan = { provider, address: resolvedGatewayAddress, topic: DEPOSITED_TOPIC, chunkSize: config.logChunkSize };
    await scanLogs(scan, fromBlock, toBlock, settleLogs, (next) => {
      fromBlock = next;
      checkpoint.save(next);
    });
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await tick().catch((err: unknown) => console.error(`[${label}] Poll tick failed:`, describeError(err)));
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}
