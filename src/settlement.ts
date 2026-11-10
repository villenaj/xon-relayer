// Shared binding to XonVendingMachine on Xode - the one place every adapter ends up calling into,
// regardless of which chain the USDT was actually paid on.

import { ethers } from "ethers";
import type { JsonRpcProvider, NonceManager, TransactionReceipt, TransactionRequest, TransactionResponse, Wallet } from "ethers";
import { makeProvider, verifyEndpoint } from "./chain.js";
import { describeError } from "./errorClassifier.js";
import VENDING_ABI from "./abi/XonVendingMachine.json" with { type: "json" };

export interface ConfirmTiming {
  /// How long to wait for a settle tx before checking on it (and, if it's still pending,
  /// resending it at the same nonce with higher fees).
  confirmTimeoutMs: number;
  /// How often to poll for its receipt meanwhile.
  receiptPollMs: number;
  /// How many fee bumps to try before giving up on this attempt and leaving it to the next tick.
  maxFeeBumps: number;
}

const DEFAULT_TIMING: ConfirmTiming = { confirmTimeoutMs: 60_000, receiptPollMs: 2_000, maxFeeBumps: 3 };
const FEE_BUMP_PERCENT = 125n; // geth-style pools need >= +10% to accept a replacement

// Only what sendAndConfirm actually uses, so tests can supply fakes.
type SenderProvider = Pick<JsonRpcProvider, "getTransactionReceipt" | "getTransaction" | "getFeeData" | "call">;

export interface Sender {
  provider: SenderProvider;
  wallet: Pick<Wallet, "sendTransaction">;
  signer: Pick<NonceManager, "reset">;
}

// Sends a settle tx and waits for it to be mined, recovering from the ways a shared NonceManager
// can otherwise get permanently stuck:
//   - NonceManager bumps its local nonce *before* sending, even if the send then fails (e.g. gas
//     estimation reverting) - so a failed send leaves a gap, and every later tx sits in the pool
//     behind it forever. Any failed send resets the nonce to re-sync from the chain.
//   - A tx dropped from the pool after being accepted leaves the same gap - also reset.
//   - A tx stuck pending (underpriced) blocks every later nonce - resent at the same nonce with
//     bumped fees. Settling is idempotent, so whichever copy lands is fine.
export async function sendAndConfirm(
  { provider, wallet, signer }: Sender,
  label: string,
  send: () => Promise<TransactionResponse>,
  timing: ConfirmTiming = DEFAULT_TIMING,
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
    const receipt = await pollForReceipt(provider, sent.map((tx) => tx.hash), timing);
    if (receipt) {
      if (receipt.status !== 1) await throwRevertReason(provider, original, receipt, label);
      return receipt;
    }

    const known = await Promise.all(sent.map((tx) => provider.getTransaction(tx.hash)));
    if (known.every((tx) => tx === null)) {
      signer.reset();
      throw new Error(`[${label}] Settle tx ${original.hash} (nonce ${original.nonce}) was dropped from the pool - nonce reset, will retry.`);
    }
    if (bumps >= timing.maxFeeBumps) {
      throw new Error(`[${label}] Settle tx ${original.hash} (nonce ${original.nonce}) still pending after ${timing.maxFeeBumps} fee bumps - will retry.`);
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
      console.warn(`[${label}] Settle tx ${latest.hash} not mined after ${timing.confirmTimeoutMs / 1000}s - resent as ${replacement.hash} with higher fees.`);
      sent.push(replacement);
    } catch (err) {
      // e.g. "nonce too low" because a copy just got mined, or the pool rejecting the bump - either
      // way, keep waiting on what's already been sent.
      console.warn(`[${label}] Fee-bumped replacement for ${latest.hash} not accepted:`, describeError(err));
    }
  }
}

async function pollForReceipt(provider: SenderProvider, hashes: string[], timing: ConfirmTiming): Promise<TransactionReceipt | null> {
  const deadline = Date.now() + timing.confirmTimeoutMs;
  for (;;) {
    for (const hash of hashes) {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt) return receipt;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, timing.receiptPollMs));
  }
}

async function bumpedFees(provider: SenderProvider, tx: TransactionResponse): Promise<TransactionRequest> {
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
async function throwRevertReason(provider: SenderProvider, tx: TransactionResponse, receipt: TransactionReceipt, label: string): Promise<never> {
  // If the replay reverts, its error carries the decodable revert data.
  await provider.call({ to: tx.to, from: tx.from, data: tx.data, blockTag: receipt.blockNumber });
  throw new Error(`[${label}] Settle tx ${receipt.hash} reverted in block ${receipt.blockNumber} (replay gave no reason).`);
}

export interface SettlementClientOptions {
  xodeEthRpc: string;
  vendingAddress: string;
  relayerPrivateKey: string;
  /// Chain ID the Xode RPC must report, if configured.
  expectedChainId: bigint | null;
  rpcTimeoutMs: number;
  /// Development only: let the relayer key also be the vending contract's owner.
  allowOwnerAsRelayer?: boolean;
  /// Whether this instance settles Xode-native deposits (needs the contract's `relayer` key) and
  /// cross-chain ones (needs an attester key). Both by default.
  roles?: { native: boolean; external: boolean };
  /// Up to this many ms of random wait before executing a market-price swap, so its moment is
  /// harder to predict and sandwich. 0 = none.
  settleJitterMs?: number;
}

/// Not an error as such: this relayer has voted for the deposit, but too few other attesters have
/// yet. The adapter retries (and so waits for them) like any transient failure.
export class AwaitingQuorumError extends Error {
  constructor(readonly depositId: string, readonly votes: bigint, readonly threshold: bigint) {
    super(`Voted for ${depositId}; waiting for other attesters (${votes} of ${threshold} votes).`);
    this.name = "AwaitingQuorumError";
  }
}

export type SettlementClient = Awaited<ReturnType<typeof createSettlementClient>>;

export async function createSettlementClient({
  xodeEthRpc, vendingAddress, relayerPrivateKey, expectedChainId, rpcTimeoutMs, allowOwnerAsRelayer = false,
  roles = { native: true, external: true }, settleJitterMs = 0,
}: SettlementClientOptions) {
  const provider = makeProvider(xodeEthRpc, rpcTimeoutMs);
  const chainId = await verifyEndpoint(provider, { label: "xode", expectedChainId, contracts: { XonVendingMachine: vendingAddress } });
  const wallet = new ethers.Wallet(relayerPrivateKey, provider);
  // All three adapters share this one client (and its one signer) - without NonceManager, two
  // adapters settling around the same moment race on the "pending" nonce lookup a plain Wallet
  // does on every send, and the loser's transaction gets silently dropped (nonce collision).
  // NonceManager tracks and increments the nonce in-process instead, so concurrent settles from
  // different adapters queue up correctly. sendAndConfirm() handles re-syncing it when it drifts.
  const signer = new ethers.NonceManager(wallet);
  const vending = new ethers.Contract(vendingAddress, VENDING_ABI, signer);
  const sender: Sender = { provider, wallet, signer };

  if (roles.native) {
    const onChainRelayer: string = await vending.relayer();
    if (onChainRelayer.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error(
        `The relayer key (${wallet.address}) does not match XonVendingMachine's relayer (${onChainRelayer}), which Xode-native deposits need. ` +
        `Use the right key, or run this instance with ENABLE_XODE_ADAPTER=false (only one relayer settles those).`,
      );
    }
  }
  if (roles.external && !(await vending.isAttester(wallet.address))) {
    throw new Error(
      `The relayer key (${wallet.address}) isn't one of XonVendingMachine's attesters, whose votes cross-chain payouts need. ` +
      `Have the owner add it (addAttester - a queued change), or use an attester's key.`,
    );
  }

  /// Votes for a cross-chain deposit (once), then executes it if enough attesters agree - otherwise
  /// throws AwaitingQuorumError, and the adapter comes back to it.
  async function attestThenExecute(
    label: string, depositId: string, params: string,
    attest: () => Promise<TransactionResponse>, execute: () => Promise<TransactionResponse>, jitter: boolean,
  ): Promise<TransactionReceipt> {
    if (!(await vending.hasAttested(depositId, wallet.address))) {
      const vote = await sendAndConfirm(sender, label, attest);
      console.log(`[${label}] Voted for ${depositId} (tx ${vote.hash}).`);
    }
    const [votes, threshold]: bigint[] = await Promise.all([vending.attestations(depositId, params), vending.attestationThreshold()]);
    if (votes < threshold) throw new AwaitingQuorumError(depositId, votes, threshold);
    if (jitter && settleJitterMs > 0) {
      const wait = Math.floor(Math.random() * settleJitterMs);
      await new Promise((resolve) => setTimeout(resolve, wait));
      // Another attester may have executed it meanwhile.
      if (await vending.externalSettledDeposits(depositId)) throw Object.assign(new Error("Executed by another attester."), { data: vending.interface.encodeErrorResult("AlreadyExternallySettled", []) });
    }
    return sendAndConfirm(sender, label, execute);
  }
  // The relayer key lives on a server and signs unattended; the owner key can withdraw the whole
  // XON reserve and USDT inventory, lift every limit and replace the relayer. One key for both
  // means stealing the relayer key takes everything, and the limits stop bounding the loss.
  const owner: string = await vending.owner();
  if (owner.toLowerCase() === wallet.address.toLowerCase()) {
    const message = `The relayer key (${wallet.address}) is also XonVendingMachine's owner - a stolen relayer key would then control the reserve, the inventory and every limit. Give the relayer its own key (setRelayer, owner key), or set ALLOW_OWNER_AS_RELAYER=true for development.`;
    if (!allowOwnerAsRelayer) throw new Error(message);
    console.warn(`WARNING: ${message}`);
  }

  return {
    provider,
    chainId,
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
    /// XonVendingMachine's own limits on external payouts (raw USDT units), or null if the
    /// deployed contract predates them.
    async externalLimits(): Promise<{ maxPerDeposit: bigint; maxPerDay: bigint; available: bigint } | null> {
      try {
        const [maxPerDeposit, maxPerDay, available]: bigint[] = await Promise.all([
          vending.maxExternalPerDeposit(), vending.maxExternalPerDay(), vending.externalAvailable(),
        ]);
        return { maxPerDeposit, maxPerDay, available };
      } catch {
        return null;
      }
    },
    async isExternalSettled(depositId: string): Promise<boolean> {
      return vending.externalSettledDeposits(depositId);
    },
    async settleExternal(buyer: string, usdtAmount: bigint, sourceChain: string, depositId: string, label: string): Promise<TransactionReceipt> {
      console.log(`[${label}] New deposit: ${buyer} paid ${usdtAmount.toString()} USDT on ${sourceChain} (id ${depositId}). Settling...`);
      const params: string = await vending.purchaseParams(buyer, usdtAmount, sourceChain);
      const receipt = await attestThenExecute(label, depositId, params,
        () => vending.attestExternalPurchase(buyer, usdtAmount, sourceChain, depositId),
        () => vending.settleExternalPurchase(buyer, usdtAmount, sourceChain, depositId), false);
      console.log(`[${label}] Settled ${depositId} in block ${receipt.blockNumber} (settle tx ${receipt.hash}).`);
      return receipt;
    },
    /// Market-price version (gateway `depositForSwap`): swaps the vending contract's USDT inventory
    /// for XON on Xode's DEX and pays the buyer the result, if it's at least `minXonOut`.
    async settleExternalSwap(buyer: string, usdtAmount: bigint, minXonOut: bigint, sourceChain: string, depositId: string, label: string): Promise<TransactionReceipt> {
      console.log(`[${label}] New swap deposit: ${buyer} paid ${usdtAmount.toString()} USDT on ${sourceChain}, minimum ${ethers.formatEther(minXonOut)} XON (id ${depositId}). Settling...`);
      const params: string = await vending.swapParams(buyer, usdtAmount, minXonOut, sourceChain);
      const receipt = await attestThenExecute(label, depositId, params,
        () => vending.attestExternalSwap(buyer, usdtAmount, minXonOut, sourceChain, depositId),
        () => vending.settleExternalSwap(buyer, usdtAmount, minXonOut, sourceChain, depositId), true);
      console.log(`[${label}] Settled ${depositId} at market price in block ${receipt.blockNumber} (settle tx ${receipt.hash}).`);
      return receipt;
    },
    /// USDT the vending contract holds for market-price payouts (raw units), or null if the
    /// deployed contract predates them.
    async usdtInventory(): Promise<bigint | null> {
      try {
        return await vending.accountedUsdt();
      } catch {
        return null;
      }
    },
  };
}

/// Namespaces a cross-chain deposit's own identifier by source chain, so an AssetHub extrinsic
/// hash and an Ethereum tx hash can never collide in `externalSettledDeposits` even though both
/// are just "some bytes32" to the contract.
export function externalDepositId(sourceChain: string, rawId: string): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], [sourceChain, rawId]));
}

/// The id of the `index`-th deposit (0-based) within one source tx, given the tx's base id (its
/// hash for Xode, `externalDepositId` for AssetHub/Ethereum). One tx can carry several deposits -
/// a batch from a multisig or smart wallet - and the base id alone would let only the first be
/// paid. The first deposit keeps the base id itself, so every deposit settled before ids were
/// indexed keeps the id it was settled under and can't be paid again.
export function depositIdAt(baseId: string, index: number): string {
  if (index === 0) return baseId;
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [baseId, index]));
}
