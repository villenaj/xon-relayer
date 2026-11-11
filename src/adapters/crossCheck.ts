// Second-opinion RPCs for an external (AssetHub / Ethereum) deposit. Those payouts rest on what the
// relayer's RPC says happened on the source chain - and every attester trusting the same provider
// (or one compromised endpoint) collapses the attester quorum to a single point of failure. With
// ASSETHUB_VERIFY_RPCS / ETHEREUM_VERIFY_RPCS set, a deposit is paid only once every one of them,
// independently, has the same log in the same block, and has that block past the confirmation
// policy. An RPC that lags just makes the adapter wait; one that disagrees also alerts. One that's
// down fails the poll: no payout rests on fewer sources than configured.

import type { JsonRpcProvider, Log } from "ethers";
import { describeConfirmations, getSafeHead, makeProvider, verifyEndpoint, type Confirmations } from "../chain.js";
import type { Verdict } from "./depositScanner.js";

export interface CrossChecker {
  /// How many RPCs it checks against (0 = none, every deposit passes).
  readonly count: number;
  check(log: Pick<Log, "transactionHash" | "blockNumber" | "blockHash" | "index" | "address" | "topics" | "data">): Promise<Verdict>;
}

/// `providers` are labelled by position only ("verify RPC #1") - RPC URLs often carry API keys,
/// and these messages go to logs and alert webhooks.
export function makeCrossChecker(providers: readonly Pick<JsonRpcProvider, "getTransactionReceipt" | "getBlock" | "getBlockNumber">[], confirmations: Confirmations): CrossChecker {
  return {
    count: providers.length,
    async check(log) {
      for (const [i, provider] of providers.entries()) {
        const name = `verify RPC #${i + 1}`;
        const safeHead = await getSafeHead(provider as JsonRpcProvider, confirmations);
        if (log.blockNumber > safeHead) {
          return { ok: false, mismatch: false, reason: `${name} hasn't seen block ${log.blockNumber} reach ${describeConfirmations(confirmations)} yet` };
        }
        const receipt = await provider.getTransactionReceipt(log.transactionHash);
        if (!receipt) return { ok: false, mismatch: true, reason: `${name} has no such transaction, though its block is past the confirmation policy` };
        if (receipt.status !== 1) return { ok: false, mismatch: true, reason: `${name} says the transaction failed` };
        if (receipt.blockHash.toLowerCase() !== log.blockHash.toLowerCase()) {
          return { ok: false, mismatch: true, reason: `${name} has it in a different block (${receipt.blockHash}, not ${log.blockHash})` };
        }
        const same = receipt.logs.find((l) => l.index === log.index);
        if (!same
          || same.address.toLowerCase() !== log.address.toLowerCase()
          || same.data.toLowerCase() !== log.data.toLowerCase()
          || same.topics.length !== log.topics.length
          || same.topics.some((t, j) => t.toLowerCase() !== log.topics[j].toLowerCase())) {
          return { ok: false, mismatch: true, reason: `${name} has a different deposit log at index ${log.index}` };
        }
      }
      return { ok: true };
    },
  };
}

/// Connects to the verify RPCs, checking each is the same chain as the primary and has the gateway.
export async function connectCrossChecker(urls: readonly string[], options: { label: string; chainId: bigint; gatewayAddress: string; confirmations: Confirmations; rpcTimeoutMs: number }): Promise<CrossChecker> {
  const providers: JsonRpcProvider[] = [];
  for (const [i, url] of urls.entries()) {
    const provider = makeProvider(url, options.rpcTimeoutMs);
    const label = `${options.label} verify RPC #${i + 1}`;
    await verifyEndpoint(provider, { label, expectedChainId: options.chainId, contracts: { UsdtGateway: options.gatewayAddress } });
    try {
      await getSafeHead(provider, options.confirmations);
    } catch (err) {
      throw new Error(`[${label}] Can't find the safe head with ${describeConfirmations(options.confirmations)}: ${err instanceof Error ? err.message : err}`);
    }
    providers.push(provider);
  }
  return makeCrossChecker(providers, options.confirmations);
}
