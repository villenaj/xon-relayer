// Shared binding to XonVendingMachine on Xode - the one place every adapter ends up calling into,
// regardless of which chain the USDT was actually paid on.

import { ethers } from "ethers";
import type { JsonRpcProvider, NonceManager, TransactionReceipt, TransactionRequest, TransactionResponse, Wallet } from "ethers";
import { describeError } from "./errorClassifier.js";
import VENDING_ABI from "./abi/XonVendingMachine.json" with { type: "json" };

// How long to wait for a settle tx before checking on it (and, if it's still pending, resending
// it at the same nonce with higher fees), how often to poll for its receipt meanwhile, and how
// many fee bumps to try before giving up on this attempt and leaving it to the next tick.
const CONFIRM_TIMEOUT_MS = 60_000;
const RECEIPT_POLL_MS = 2_000;
const MAX_FEE_BUMPS = 3;
const FEE_BUMP_PERCENT = 125n; // geth-style pools need >= +10% to accept a replacement

interface Sender {
  provider: JsonRpcProvider;
  wallet: Wallet;
  signer: NonceManager;
}

// Sends a settle tx and waits for it to be mined, recovering from the ways a shared NonceManager
// can otherwise get permanently stuck:
//   - NonceManager bumps its local nonce *before* sending, even if the send then fails (e.g. gas
//     estimation reverting) - so a failed send leaves a gap, and every later tx sits in the pool
//     behind it forever. Any failed send resets the nonce to re-sync from the chain.
//   - A tx dropped from the pool after being accepted leaves the same gap - also reset.
//   - A tx stuck pending (underpriced) blocks every later nonce - resent at the same nonce with
//     bumped fees. Settling is idempotent, so whichever copy lands is fine.
async function sendAndConfirm(
  { provider, wallet, signer }: Sender,
  label: string,
  send: () => Promise<TransactionResponse>,
): Promise<TransactionReceipt> {
  let original: TransactionResponse;
  try {
    original = await send();
  } catch (err) {
    signer.reset();
    throw err;
  }

  const sent = [original];
  for (let bumps = 0; ; bumps++) {
    const receipt = await pollForReceipt(provider, sent.map((tx) => tx.hash), CONFIRM_TIMEOUT_MS);
    if (receipt) {
      if (receipt.status !== 1) await throwRevertReason(provider, original, receipt, label);
      return receipt;
    }

    const known = await Promise.all(sent.map((tx) => provider.getTransaction(tx.hash)));
    if (known.every((tx) => tx === null)) {
      signer.reset();
      throw new Error(`[${label}] Settle tx ${original.hash} (nonce ${original.nonce}) was dropped from the pool - nonce reset, will retry.`);
    }
    if (bumps >= MAX_FEE_BUMPS) {
      throw new Error(`[${label}] Settle tx ${original.hash} (nonce ${original.nonce}) still pending after ${MAX_FEE_BUMPS} fee bumps - will retry.`);
    }

    const latest = sent[sent.length - 1];
    try {
      // Sent straight from the wallet, bypassing NonceManager: it would overwrite the nonce, and
      // this nonce is already accounted for there.
      const replacement = await wallet.sendTransaction({
        to: original.to,
        data: original.data,
        value: original.value,
        nonce: original.nonce,
        gasLimit: original.gasLimit,
        chainId: original.chainId,
        ...(await bumpedFees(provider, latest)),
      });
      console.warn(`[${label}] Settle tx ${latest.hash} not mined after ${CONFIRM_TIMEOUT_MS / 1000}s - resent as ${replacement.hash} with higher fees.`);
      sent.push(replacement);
    } catch (err) {
      // e.g. "nonce too low" because a copy just got mined, or the pool rejecting the bump - either
      // way, keep waiting on what's already been sent.
      console.warn(`[${label}] Fee-bumped replacement for ${latest.hash} not accepted:`, describeError(err));
    }
  }
}

async function pollForReceipt(provider: JsonRpcProvider, hashes: string[], timeoutMs: number): Promise<TransactionReceipt | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const hash of hashes) {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt) return receipt;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS));
  }
}

async function bumpedFees(provider: JsonRpcProvider, tx: TransactionResponse): Promise<TransactionRequest> {
  const current = await provider.getFeeData();
  const bump = (v: bigint) => (v * FEE_BUMP_PERCENT) / 100n + 1n;
  const atLeast = (v: bigint, floor: bigint | null) => (floor !== null && floor > v ? floor : v);

  if (tx.maxFeePerGas !== null && tx.maxPriorityFeePerGas !== null) {
    const maxPriorityFeePerGas = atLeast(bump(tx.maxPriorityFeePerGas), current.maxPriorityFeePerGas);
    const maxFeePerGas = atLeast(atLeast(bump(tx.maxFeePerGas), current.maxFeePerGas), maxPriorityFeePerGas);
    return { type: 2, maxFeePerGas, maxPriorityFeePerGas };
  }
  return { type: tx.type, gasPrice: atLeast(bump(tx.gasPrice), current.gasPrice) };
}

// Confirmed directly against this chain's `eth-rpc` bridge: a mined-but-reverted receipt (status
// 0) carries no revert data - so error classification would always see "unknown" for this path.
// Replaying the exact same call via `eth_call` at the block it was mined in recovers the real
// revert reason (verified with `cast call` against the same failure), which is what callers
// actually need to classify permanent vs. transient errors.
async function throwRevertReason(provider: JsonRpcProvider, tx: TransactionResponse, receipt: TransactionReceipt, label: string): Promise<never> {
  // If the replay reverts, its error carries the decodable revert data.
  await provider.call({ to: tx.to, from: tx.from, data: tx.data, blockTag: receipt.blockNumber });
  throw new Error(`[${label}] Settle tx ${receipt.hash} reverted in block ${receipt.blockNumber} (replay gave no reason).`);
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
  // All three adapters share this one client (and its one signer) - without NonceManager, two
  // adapters settling around the same moment race on the "pending" nonce lookup a plain Wallet
  // does on every send, and the loser's transaction gets silently dropped (nonce collision).
  // NonceManager tracks and increments the nonce in-process instead, so concurrent settles from
  // different adapters queue up correctly. sendAndConfirm() handles re-syncing it when it drifts.
  const signer = new ethers.NonceManager(wallet);
  const vending = new ethers.Contract(vendingAddress, VENDING_ABI, signer);
  const sender: Sender = { provider, wallet, signer };

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
    async settleNative(buyer: string, usdtAmount: bigint, depositTxHash: string, label: string): Promise<TransactionReceipt> {
      console.log(`[${label}] New deposit: ${buyer} sent ${usdtAmount.toString()} USDT (tx ${depositTxHash}). Settling...`);
      const receipt = await sendAndConfirm(sender, label, () => vending.settlePurchase(buyer, usdtAmount, depositTxHash));
      console.log(`[${label}] Settled ${depositTxHash} in block ${receipt.blockNumber} (settle tx ${receipt.hash}).`);
      return receipt;
    },

    // Cross-chain path: USDT paid on AssetHub or Ethereum - see XonVendingMachine's docs on the
    // trust this implies (the relayer's attestation is the only input, not independently verified).
    async isExternalSettled(depositId: string): Promise<boolean> {
      return vending.externalSettledDeposits(depositId);
    },
    async settleExternal(buyer: string, usdtAmount: bigint, sourceChain: string, depositId: string, label: string): Promise<TransactionReceipt> {
      console.log(`[${label}] New deposit: ${buyer} paid ${usdtAmount.toString()} USDT on ${sourceChain} (id ${depositId}). Settling...`);
      const receipt = await sendAndConfirm(sender, label, () => vending.settleExternalPurchase(buyer, usdtAmount, sourceChain, depositId));
      console.log(`[${label}] Settled ${depositId} in block ${receipt.blockNumber} (settle tx ${receipt.hash}).`);
      return receipt;
    },
  };
}

/// Namespaces a cross-chain deposit's own identifier by source chain, so an AssetHub extrinsic
/// hash and an Ethereum tx hash can never collide in `externalSettledDeposits` even though both
/// are just "some bytes32" to the contract.
export function externalDepositId(sourceChain: string, rawId: string): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], [sourceChain, rawId]));
}
