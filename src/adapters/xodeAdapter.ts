// Watches USDT `Transfer` events into the vending contract on Xode itself (the fully-verified
// path: XonVendingMachine checks the real on-chain USDT balance before paying out, see
// `settlePurchase` in XonVendingMachine.sol).

import { ethers } from "ethers";
import type { Log } from "ethers";
import path from "node:path";
import { describeConfirmations, getSafeHead, scanLogs } from "../chain.js";
import { makeCheckpoint } from "../checkpoint.js";
import { classifySettleError, describeError } from "../errorClassifier.js";
import { runPollLoop } from "./pollLoop.js";
import type { AdapterContext } from "./types.js";

const LABEL = "xode";
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

export async function runXodeAdapter(context: AdapterContext): Promise<void> {
  const { settlement, config, ledger, shutdown } = context;
  const { provider, vending } = settlement;
  const vendingAddress = await vending.getAddress();
  const usdtAddress: string = await vending.usdt();

  const checkpoint = makeCheckpoint<number>(path.join(config.checkpointDir, config.xodeCheckpointFile), vendingAddress);

  console.log(`[${LABEL}] Watching USDT (${usdtAddress}) transfers into ${vendingAddress}, settling after ${describeConfirmations(config.xodeConfirmations)}`);

  const checkpointed = checkpoint.load();
  let fromBlock: number;
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

  const paddedVending = ethers.zeroPadValue(vendingAddress, 32).toLowerCase();

  // Settles each deposit in order; returns the block of the first one that needs retrying (or
  // that shutdown interrupted before), if any.
  async function settleLogs(logs: Log[]): Promise<number | null> {
    for (const log of logs) {
      if (log.topics[2].toLowerCase() !== paddedVending) continue;
      if (shutdown.requested) return log.blockNumber;

      const buyer = ethers.getAddress(ethers.dataSlice(log.topics[1], 12));
      const amount = ethers.toBigInt(log.data);
      const depositTxHash = log.transactionHash;

      if (await settlement.isNativeSettled(depositTxHash)) {
        console.log(`[${LABEL}] Skipping ${depositTxHash} - already settled.`);
        continue;
      }

      // Native deposits are identified on-chain by their own tx hash, so depositId === sourceTxHash.
      const entry = {
        adapter: LABEL, buyer, usdtAmount: amount, sourceChain: "xode",
        sourceTxHash: depositTxHash, depositId: depositTxHash, sourceBlock: log.blockNumber,
      };

      try {
        const receipt = await settlement.settleNative(buyer, amount, depositTxHash, LABEL);
        ledger.record({ ...entry, status: "settled", settleTxHash: receipt.hash, settleBlock: receipt.blockNumber });
      } catch (err) {
        const { kind, name } = classifySettleError(settlement.vending, err);
        if (kind === "already-done") {
          console.log(`[${LABEL}] ${depositTxHash} was already settled by another attempt (${name}) - continuing.`);
          ledger.record({ ...entry, status: "already-settled", error: name });
          continue;
        }
        if (kind === "permanent") {
          console.error(`[${LABEL}] Permanently skipping ${depositTxHash} - reverted with ${name}, which can never succeed by retrying.`);
          ledger.record({ ...entry, status: "skipped", error: name });
          continue;
        }
        console.error(`[${LABEL}] Failed to settle ${depositTxHash} (${name ?? "unknown"}), will retry next tick:`, describeError(err));
        ledger.record({ ...entry, status: "failed", error: name, message: describeError(err) });
        return log.blockNumber;
      }
    }
    return null;
  }

  async function tick(): Promise<number> {
    const toBlock = await getSafeHead(provider, config.xodeConfirmations);
    // This bridge's eth_getLogs doesn't accept `null`/`[]` as a topic wildcard (confirmed
    // directly against it), so filter only by topic0 (Transfer) and match client-side above.
    const scan = { provider, address: usdtAddress, topic: TRANSFER_TOPIC, chunkSize: config.logChunkSize };
    const next = await scanLogs(scan, fromBlock, toBlock, settleLogs, (n) => {
      fromBlock = n;
      checkpoint.save(n);
    }, () => shutdown.requested);
    return Math.max(0, toBlock - next + 1);
  }

  await runPollLoop(context, LABEL, tick);
}
