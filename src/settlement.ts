// Shared binding to XonVendingMachine on Xode - the one place every adapter ends up calling into,
// regardless of which chain the USDT was actually paid on.

import { ethers } from "ethers";
import type { ContractTransactionReceipt, ContractTransactionResponse } from "ethers";
import VENDING_ABI from "./abi/XonVendingMachine.json" with { type: "json" };

// All three adapters share this one client (and its one signer) - without NonceManager, two
// adapters settling around the same moment race on the "pending" nonce lookup a plain Wallet does
// on every send, and the loser's transaction gets silently dropped (nonce collision), leaving its
// `tx.wait()` hanging forever with no error. NonceManager tracks and increments the nonce
// in-process instead, so concurrent settles from different adapters queue up correctly.
const WAIT_TIMEOUT_MS = 60_000;

// Confirmed directly against this chain's `eth-rpc` bridge: when a transaction is mined but
// reverts (status 0), the CALL_EXCEPTION ethers throws from `tx.wait()` carries no usable revert
// data here (unlike a plain `eth_call`/estimateGas failure, which does) - so error classification
// would always see "unknown" for this path. Replaying the exact same call via `eth_call` at the
// block it was mined in recovers the real revert reason (verified with `cast call` against the
// same failure), which is what callers actually need to classify permanent vs. transient errors.
async function waitWithTimeout(
  tx: ContractTransactionResponse,
  label: string,
  provider: ethers.JsonRpcProvider,
): Promise<ContractTransactionReceipt> {
  let result: ContractTransactionReceipt | null;
  try {
    result = await Promise.race([
      tx.wait(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`[${label}] Timed out waiting for settle tx ${tx.hash} to confirm.`)), WAIT_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    if (ethers.isError(err, "CALL_EXCEPTION") && !err.data && err.receipt) {
      // If the replay reverts, its error carries the decodable revert data the original was missing.
      await provider.call({ to: tx.to, from: tx.from, data: tx.data, blockTag: err.receipt.blockNumber });
    }
    throw err;
  }
  if (!result) throw new Error(`[${label}] Settle tx ${tx.hash} returned no receipt.`);
  return result;
}

export interface SettlementClientOptions {
  xodeEthRpc: string;
  vendingAddress: string;
  relayerPrivateKey: string;
}

export type SettlementClient = Awaited<ReturnType<typeof createSettlementClient>>;

export async function createSettlementClient({ xodeEthRpc, vendingAddress, relayerPrivateKey }: SettlementClientOptions) {
  const provider = new ethers.JsonRpcProvider(xodeEthRpc);
  const wallet = new ethers.Wallet(relayerPrivateKey, provider);
  const signer = new ethers.NonceManager(wallet);
  const vending = new ethers.Contract(vendingAddress, VENDING_ABI, signer);

  const onChainRelayer: string = await vending.relayer();
  if (onChainRelayer.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(
      `RELAYER_PRIVATE_KEY (${wallet.address}) does not match XonVendingMachine's relayer (${onChainRelayer}). ` +
      `Call setRelayer on the contract first, or use the right key.`,
    );
  }

  return {
    provider,
    vending,
    relayerAddress: wallet.address,

    // Native path: USDT paid directly to the vending contract on Xode itself.
    async isNativeSettled(depositTxHash: string): Promise<boolean> {
      return vending.settledDeposits(depositTxHash);
    },
    async settleNative(buyer: string, usdtAmount: bigint, depositTxHash: string, label: string): Promise<void> {
      console.log(`[${label}] New deposit: ${buyer} sent ${usdtAmount.toString()} USDT (tx ${depositTxHash}). Settling...`);
      const tx: ContractTransactionResponse = await vending.settlePurchase(buyer, usdtAmount, depositTxHash);
      const receipt = await waitWithTimeout(tx, label, provider);
      console.log(`[${label}] Settled ${depositTxHash} in block ${receipt.blockNumber} (settle tx ${receipt.hash}).`);
    },

    // Cross-chain path: USDT paid on AssetHub or Ethereum - see XonVendingMachine's docs on the
    // trust this implies (the relayer's attestation is the only input, not independently verified).
    async isExternalSettled(depositId: string): Promise<boolean> {
      return vending.externalSettledDeposits(depositId);
    },
    async settleExternal(buyer: string, usdtAmount: bigint, sourceChain: string, depositId: string, label: string): Promise<void> {
      console.log(`[${label}] New deposit: ${buyer} paid ${usdtAmount.toString()} USDT on ${sourceChain} (id ${depositId}). Settling...`);
      const tx: ContractTransactionResponse = await vending.settleExternalPurchase(buyer, usdtAmount, sourceChain, depositId);
      const receipt = await waitWithTimeout(tx, label, provider);
      console.log(`[${label}] Settled ${depositId} in block ${receipt.blockNumber} (settle tx ${receipt.hash}).`);
    },
  };
}

/// Namespaces a cross-chain deposit's own identifier by source chain, so an AssetHub extrinsic
/// hash and an Ethereum tx hash can never collide in `externalSettledDeposits` even though both
/// are just "some bytes32" to the contract.
export function externalDepositId(sourceChain: string, rawId: string): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], [sourceChain, rawId]));
}
