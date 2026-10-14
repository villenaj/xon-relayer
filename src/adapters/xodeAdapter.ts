// Watches USDT `Transfer` events into the vending contract on Xode itself (the fully-verified
// path: XonVendingMachine checks the real on-chain USDT balance before paying out, see
// `settlePurchase` in XonVendingMachine.sol).

import { ethers } from "ethers";
import type { Log } from "ethers";
import path from "node:path";
import { describeConfirmations, getSafeHead, scanLogs } from "../chain.js";
import { makeCheckpoint } from "../checkpoint.js";
import { classifySettleError, describeError } from "../errorClassifier.js";
import type { AdapterContext } from "./types.js";

const LABEL = "xode";
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

export async function runXodeAdapter({ settlement, config, ledger }: AdapterContext): Promise<never> {
  const { provider, vending } = settlement;
  const vendingAddress = await vending.getAddress();
  const usdtAddress: string = await vending.usdt();

  const checkpoint = makeCheckpoint<number>(path.join(config.checkpointDir, "xode.json"), vendingAddress);

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

  // Settles each deposit in order; returns the block of the first one that needs retrying, if any.
  async function settleLogs(logs: Log[]): Promise<number | null> {
    for (const log of logs) {
      if (log.topics[2].toLowerCase() !== paddedVending) continue;

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

  async function tick(): Promise<void> {
    const toBlock = await getSafeHead(provider, config.xodeConfirmations);
    // This bridge's eth_getLogs doesn't accept `null`/`[]` as a topic wildcard (confirmed
    // directly against it), so filter only by topic0 (Transfer) and match client-side above.
    const scan = { provider, address: usdtAddress, topic: TRANSFER_TOPIC, chunkSize: config.logChunkSize };
    await scanLogs(scan, fromBlock, toBlock, settleLogs, (next) => {
      fromBlock = next;
      checkpoint.save(next);
    });
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await tick().catch((err: unknown) => console.error(`[${LABEL}] Poll tick failed:`, describeError(err)));
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}
