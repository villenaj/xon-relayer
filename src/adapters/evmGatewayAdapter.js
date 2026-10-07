// Watches `UsdtGateway.Deposited` events on any EVM-compatible chain other than Xode itself
// (Ethereum, or AssetHub now that it runs pallet-revive) and settles the corresponding XON payout
// on Xode. One instance of this adapter runs per such chain - see ethereumAdapter.js and
// assetHubAdapter.js, which are both just this function called with a different chain config.
//
// This is a custodial leg regardless of which chain it watches: USDT deposited into the gateway
// contract just sits there under its `owner`'s control until manually moved - there's no on-chain
// link between that chain and Xode. The relayer's attestation (via settleExternalPurchase) is the
// only thing connecting the two. See XonVendingMachine.sol's doc comment for the full trust story.

import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeCheckpoint } from "../checkpoint.js";
import { externalDepositId } from "../settlement.js";
import { classifySettleError } from "../errorClassifier.js";

const GATEWAY_ABI = JSON.parse(readFileSync(new URL("../abi/EthUsdtGateway.json", import.meta.url)));
const DEPOSITED_TOPIC = ethers.id("Deposited(address,address,uint256,uint256)");

export async function runEvmGatewayAdapter({ settlement, config, sourceChain, label, rpcUrl, gatewayAddress, startBlock, checkpointFile }) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const gateway = new ethers.Contract(gatewayAddress, GATEWAY_ABI, provider);
  const resolvedGatewayAddress = await gateway.getAddress();

  const checkpoint = makeCheckpoint(path.join(config.checkpointDir, checkpointFile), resolvedGatewayAddress);

  console.log(`[${label}] Watching UsdtGateway (${resolvedGatewayAddress}) deposits on ${rpcUrl}`);

  const checkpointed = checkpoint.load();
  let fromBlock;
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

  async function tick() {
    const latest = await provider.getBlockNumber();
    const toBlock = latest - config.confirmations;
    if (toBlock < fromBlock) return;

    const logs = await provider.getLogs({ address: resolvedGatewayAddress, topics: [DEPOSITED_TOPIC], fromBlock, toBlock });
    let stalledAtBlock = null;

    for (const log of logs) {
      const parsed = gateway.interface.parseLog(log);
      const xodeBeneficiary = parsed.args.xodeBeneficiary;
      const usdtAmount = parsed.args.usdtAmount;
      const depositId = externalDepositId(sourceChain, log.transactionHash);

      if (await settlement.isExternalSettled(depositId)) {
        console.log(`[${label}] Skipping ${log.transactionHash} - already settled.`);
        continue;
      }

      try {
        await settlement.settleExternal(xodeBeneficiary, usdtAmount, sourceChain, depositId, label);
      } catch (err) {
        const { kind, name } = classifySettleError(settlement.vending, err);
        if (kind === "already-done") {
          console.log(`[${label}] ${log.transactionHash} was already settled by another attempt (${name}) - continuing.`);
          continue;
        }
        if (kind === "permanent") {
          console.error(`[${label}] Permanently skipping ${log.transactionHash} - reverted with ${name}, which can never succeed by retrying.`);
          continue;
        }
        console.error(`[${label}] Failed to settle ${log.transactionHash} (${name ?? "unknown"}), will retry next tick:`, err.shortMessage ?? err.message);
        stalledAtBlock = log.blockNumber;
        break;
      }
    }

    fromBlock = stalledAtBlock ?? toBlock + 1;
    checkpoint.save(fromBlock);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await tick().catch((err) => console.error(`[${label}] Poll tick failed:`, err.shortMessage ?? err.message));
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}
