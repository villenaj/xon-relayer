// USDT that reaches XonVendingMachine on Xode without being a deposit to settle: the contract pulls
// it in itself and accounts for it in the same transaction - `buy()` (paid on the spot, `Bought`)
// and `fundUsdtInventory()` (owner's inventory for market-price payouts, `UsdtInventoryFunded`).
// Its `Transfer` looks exactly like a buyer's direct transfer, but settlePurchase can never pay it
// (UnverifiedDeposit - the USDT is already accounted for), which would stall the Xode adapter.

import { ethers, type Provider } from "ethers";

const ACCOUNTED_TOPICS = [
  ethers.id("Bought(address,uint256,uint256)"),
  ethers.id("UsdtInventoryFunded(address,uint256)"),
];

/// Whether `txHash` carries an event by which the vending contract accounted for its USDT itself.
export async function isAccountedByVending(provider: Pick<Provider, "getTransactionReceipt">, vendingAddress: string, txHash: string): Promise<boolean> {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error(`No receipt for ${txHash} - can't tell whether it's a deposit yet.`);
  const vending = vendingAddress.toLowerCase();
  return receipt.logs.some((log) => log.address.toLowerCase() === vending && ACCOUNTED_TOPICS.includes(log.topics[0]));
}
