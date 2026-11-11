// USDT that reaches XonVendingMachine on Xode without being a deposit to settle: the contract pulls
// it in itself and accounts for it in the same transaction - `buy()` (paid on the spot, `Bought`)
// and `fundUsdtInventory()` (owner's inventory for market-price payouts, `UsdtInventoryFunded`).
// Its `Transfer` looks exactly like a buyer's direct transfer, but settlePurchase can never pay it
// (UnverifiedDeposit - the USDT is already accounted for), which would stall the Xode adapter.
//
// Matched transfer by transfer, not tx by tx: a tx (a smart-wallet or multisig batch) can call
// `buy()` *and* make a plain transfer, and only the transfer `buy()` pulled in is accounted for -
// the plain one is a real deposit to pay. Each accounted event claims the latest earlier Transfer
// in its tx from the same address for the same amount (what `transferFrom` inside it emitted).
//
// Read from eth_getLogs, never receipts: Xode's eth-rpc can lose a receipt (blocks it fails to
// decode), which would stall the adapter on that deposit forever, while the logs the scanner found
// the deposit through in the first place are, by definition, there.

import { ethers, type Log, type Provider } from "ethers";

const BOUGHT_TOPIC = ethers.id("Bought(address,uint256,uint256)");
const FUNDED_TOPIC = ethers.id("UsdtInventoryFunded(address,uint256)");
const ACCOUNTED_TOPICS = [BOUGHT_TOPIC, FUNDED_TOPIC];
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

type LogLike = Pick<Log, "address" | "topics" | "data" | "transactionHash" | "index">;

/// `${txHash}:${logIndex}` of a USDT Transfer log - how accounted transfers are identified.
export const transferKey = (txHash: string, logIndex: number): string => `${txHash.toLowerCase()}:${logIndex}`;

/// Of `transfers` (USDT Transfer logs into the vending contract) and `accounted` (its Bought /
/// UsdtInventoryFunded logs) from one block, the keys of the transfers the contract accounted for.
export function matchAccountedTransfers(transfers: readonly LogLike[], accounted: readonly LogLike[], vendingAddress: string): Set<string> {
  const vending = vendingAddress.toLowerCase();
  const claimed = new Set<string>();
  const byIndex = (a: LogLike, b: LogLike) => a.index - b.index;
  const candidates = [...transfers].sort(byIndex);
  for (const event of [...accounted].sort(byIndex)) {
    if (event.address.toLowerCase() !== vending || !ACCOUNTED_TOPICS.includes(event.topics[0])) continue;
    const payer = ethers.dataSlice(event.topics[1], 12).toLowerCase();
    // Bought(buyer, usdtIn, xonOut) and UsdtInventoryFunded(from, amount): the USDT is the first word.
    const amount = ethers.toBigInt(ethers.dataSlice(event.data, 0, 32));
    const match = candidates.filter((t) =>
      t.transactionHash.toLowerCase() === event.transactionHash.toLowerCase()
      && t.index < event.index
      && !claimed.has(transferKey(t.transactionHash, t.index))
      && ethers.dataSlice(t.topics[1], 12).toLowerCase() === payer
      && ethers.toBigInt(t.data) === amount,
    ).at(-1);
    if (match) {
      claimed.add(transferKey(match.transactionHash, match.index));
    } else {
      console.warn(`[xode] ${event.transactionHash}: accounted event #${event.index} has no matching USDT transfer before it - not treating any transfer as accounted for it.`);
    }
  }
  return claimed;
}

/// Accounted-transfer lookups by block, cached for the few blocks being worked through: every
/// deposit in a block asks about the same block.
export function makeAccountedTransfers(provider: Pick<Provider, "getLogs">, usdtAddress: string, vendingAddress: string) {
  const paddedVending = ethers.zeroPadValue(vendingAddress, 32).toLowerCase();
  const cache = new Map<number, Promise<Set<string>>>();

  async function forBlock(blockNumber: number): Promise<Set<string>> {
    const accounted = await provider.getLogs({ address: vendingAddress, topics: [ACCOUNTED_TOPICS], fromBlock: blockNumber, toBlock: blockNumber });
    if (accounted.length === 0) return new Set(); // the usual case: one cheap call
    const transfers = (await provider.getLogs({ address: usdtAddress, topics: [TRANSFER_TOPIC], fromBlock: blockNumber, toBlock: blockNumber }))
      .filter((l) => l.topics[2]?.toLowerCase() === paddedVending);
    return matchAccountedTransfers(transfers, accounted, vendingAddress);
  }

  return {
    /// Whether the USDT Transfer log `logIndex` of `txHash`, in `blockNumber`, is one the vending
    /// contract pulled in and accounted for itself (so not a deposit).
    async isAccounted(blockNumber: number, txHash: string, logIndex: number): Promise<boolean> {
      let pending = cache.get(blockNumber);
      if (!pending) {
        pending = forBlock(blockNumber);
        // A failed lookup isn't cached - the next ask retries it.
        pending.catch(() => cache.delete(blockNumber));
        cache.set(blockNumber, pending);
        if (cache.size > 16) cache.delete(cache.keys().next().value!);
      }
      return (await pending).has(transferKey(txHash, logIndex));
    },
  };
}
