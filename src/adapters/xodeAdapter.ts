// Watches USDT `Transfer` events into the vending contract on Xode itself (the fully-verified
// path: XonVendingMachine checks the real on-chain USDT balance before paying out, see
// `settlePurchase` in XonVendingMachine.sol).

import { ethers } from "ethers";
import { makeAccountedTransfers } from "./accountedTransfers.js";
import { runDepositScanner } from "./depositScanner.js";
import type { AdapterContext } from "./types.js";

const LABEL = "xode";
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

export async function runXodeAdapter(context: AdapterContext): Promise<void> {
  const { settlement, config } = context;
  const { provider, vending } = settlement;
  const vendingAddress = await vending.getAddress();
  const usdtAddress: string = await vending.usdt();
  const paddedVending = ethers.zeroPadValue(vendingAddress, 32).toLowerCase();
  const accounted = makeAccountedTransfers(provider, usdtAddress, vendingAddress);

  await runDepositScanner(context, {
    label: LABEL,
    description: `USDT (${usdtAddress}) transfers into ${vendingAddress}`,
    provider,
    // This bridge's eth_getLogs doesn't accept `null`/`[]` as a topic wildcard (confirmed
    // directly against it), so filter only by topic0 (Transfer) and match the recipient in parse().
    logAddress: usdtAddress,
    topic: TRANSFER_TOPIC,
    confirmations: config.xodeConfirmations,
    checkpointFile: config.xodeCheckpointFile,
    checkpointIdentity: vendingAddress,
    startBlock: config.xodeStartBlock,
    startBlockName: "XODE_START_BLOCK",

    parse(log) {
      if (log.topics[2].toLowerCase() !== paddedVending) return null;
      return {
        buyer: ethers.getAddress(ethers.dataSlice(log.topics[1], 12)),
        usdtAmount: ethers.toBigInt(log.data),
        sourceChain: "xode",
        sourceTxHash: log.transactionHash,
        sourceBlock: log.blockNumber,
      };
    },
    // Native deposits are identified on-chain by their own tx hash (indexed past the first).
    baseDepositId: (txHash) => txHash,
    // USDT the contract pulled in and accounted for itself (buy(), fundUsdtInventory()) isn't a
    // deposit: there's nothing to pay, and settlePurchase would revert UnverifiedDeposit forever.
    // Matched to this exact transfer, so a plain transfer batched with a buy() is still paid.
    // isNativeSettled also covers a deposit the owner cancelled to refund it.
    isSettled: async (d) => (await settlement.isNativeSettled(d.depositId))
      || accounted.isAccounted(d.sourceBlock, d.sourceTxHash, d.sourceLogIndex),
    settle: (d) => settlement.settleNative(d.buyer, d.usdtAmount, d.depositId, LABEL),
  });
}
