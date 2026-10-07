// Shared binding to XonVendingMachine on Xode - the one place every adapter ends up calling into,
// regardless of which chain the USDT was actually paid on.

import { ethers } from "ethers";
import { readFileSync } from "node:fs";

const VENDING_ABI = JSON.parse(readFileSync(new URL("./abi/XonVendingMachine.json", import.meta.url)));

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
async function waitWithTimeout(tx, label, provider) {
  let result;
  try {
    result = await Promise.race([
      tx.wait(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`[${label}] Timed out waiting for settle tx ${tx.hash} to confirm.`)), WAIT_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    if (err.code === "CALL_EXCEPTION" && !err.data && err.receipt) {
      try {
        await provider.call({ to: tx.to, from: tx.from, data: tx.data, blockTag: err.receipt.blockNumber });
      } catch (replayErr) {
        throw replayErr; // carries the decodable revert data the original error was missing
      }
    }
    throw err;
  }
  return result;
}

export async function createSettlementClient({ xodeEthRpc, vendingAddress, relayerPrivateKey }) {
  const provider = new ethers.JsonRpcProvider(xodeEthRpc);
  const wallet = new ethers.Wallet(relayerPrivateKey, provider);
  const signer = new ethers.NonceManager(wallet);
  const vending = new ethers.Contract(vendingAddress, VENDING_ABI, signer);

  const onChainRelayer = await vending.relayer();
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
    async isNativeSettled(depositTxHash) {
      return vending.settledDeposits(depositTxHash);
    },
    async settleNative(buyer, usdtAmount, depositTxHash, label) {
      console.log(`[${label}] New deposit: ${buyer} sent ${usdtAmount.toString()} USDT (tx ${depositTxHash}). Settling...`);
      const tx = await vending.settlePurchase(buyer, usdtAmount, depositTxHash);
      const receipt = await waitWithTimeout(tx, label, provider);
      console.log(`[${label}] Settled ${depositTxHash} in block ${receipt.blockNumber} (settle tx ${receipt.hash}).`);
    },

    // Cross-chain path: USDT paid on AssetHub or Ethereum - see XonVendingMachine's docs on the
    // trust this implies (the relayer's attestation is the only input, not independently verified).
    async isExternalSettled(depositId) {
      return vending.externalSettledDeposits(depositId);
    },
    async settleExternal(buyer, usdtAmount, sourceChain, depositId, label) {
      console.log(`[${label}] New deposit: ${buyer} paid ${usdtAmount.toString()} USDT on ${sourceChain} (id ${depositId}). Settling...`);
      const tx = await vending.settleExternalPurchase(buyer, usdtAmount, sourceChain, depositId);
      const receipt = await waitWithTimeout(tx, label, provider);
      console.log(`[${label}] Settled ${depositId} in block ${receipt.blockNumber} (settle tx ${receipt.hash}).`);
    },
  };
}

/// Namespaces a cross-chain deposit's own identifier by source chain, so an AssetHub extrinsic
/// hash and an Ethereum tx hash can never collide in `externalSettledDeposits` even though both
/// are just "some bytes32" to the contract.
export function externalDepositId(sourceChain, rawId) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], [sourceChain, rawId]));
}
