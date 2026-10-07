// Watches USDT `Transfer` events into the vending contract on Xode itself (the fully-verified
// path: XonVendingMachine checks the real on-chain USDT balance before paying out, see
// `settlePurchase` in XonVendingMachine.sol).

import { ethers } from "ethers";
import path from "node:path";
import { makeCheckpoint } from "../checkpoint.js";
import { classifySettleError } from "../errorClassifier.js";

const LABEL = "xode";
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

export async function runXodeAdapter({ settlement, config }) {
  const { provider, vending } = settlement;
  const vendingAddress = await vending.getAddress();
  const usdtAddress = await vending.usdt();

  const checkpoint = makeCheckpoint(path.join(config.checkpointDir, "xode.json"), vendingAddress);

  console.log(`[${LABEL}] Watching USDT (${usdtAddress}) transfers into ${vendingAddress}`);

  const checkpointed = checkpoint.load();
  let fromBlock;
  if (checkpointed !== null) {
    fromBlock = checkpointed;
    console.log(`[${LABEL}] Resuming from checkpoint: block ${fromBlock}.`);
  } else if (config.xodeStartBlock !== null) {
    fromBlock = config.xodeStartBlock;
    console.log(`[${LABEL}] No checkpoint. Starting from XODE_START_BLOCK=${fromBlock}.`);
  } else {
    fromBlock = (await provider.getBlockNumber()) + 1;
    console.warn(`[${LABEL}] No checkpoint/start block - starting from current block (${fromBlock}). Pre-existing deposits will be missed.`);
  }

  async function tick() {
    const latest = await provider.getBlockNumber();
    const toBlock = latest - config.confirmations;
    if (toBlock < fromBlock) return;

    // This bridge's eth_getLogs doesn't accept `null`/`[]` as a topic wildcard (confirmed
    // directly against it), so filter only by topic0 (Transfer) and match client-side below.
    const logs = await provider.getLogs({ address: usdtAddress, topics: [TRANSFER_TOPIC], fromBlock, toBlock });

    const paddedVending = ethers.zeroPadValue(vendingAddress, 32).toLowerCase();
    let stalledAtBlock = null;

    for (const log of logs) {
      if (log.topics[2].toLowerCase() !== paddedVending) continue;

      const buyer = ethers.getAddress(ethers.dataSlice(log.topics[1], 12));
      const amount = ethers.toBigInt(log.data);
      const depositTxHash = log.transactionHash;

      if (await settlement.isNativeSettled(depositTxHash)) {
        console.log(`[${LABEL}] Skipping ${depositTxHash} - already settled.`);
        continue;
      }

      try {
        await settlement.settleNative(buyer, amount, depositTxHash, LABEL);
      } catch (err) {
        const { kind, name } = classifySettleError(settlement.vending, err);
        if (kind === "already-done") {
          console.log(`[${LABEL}] ${depositTxHash} was already settled by another attempt (${name}) - continuing.`);
          continue;
        }
        if (kind === "permanent") {
          console.error(`[${LABEL}] Permanently skipping ${depositTxHash} - reverted with ${name}, which can never succeed by retrying.`);
          continue;
        }
        console.error(`[${LABEL}] Failed to settle ${depositTxHash} (${name ?? "unknown"}), will retry next tick:`, err.shortMessage ?? err.message);
        stalledAtBlock = log.blockNumber;
        break;
      }
    }

    fromBlock = stalledAtBlock ?? toBlock + 1;
    checkpoint.save(fromBlock);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await tick().catch((err) => console.error(`[${LABEL}] Poll tick failed:`, err.shortMessage ?? err.message));
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}
