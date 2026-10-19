// Chain-reading helpers shared by every adapter: connecting with sane timeouts, checking at startup
// that an RPC is the chain and contract we think it is, how far back from the head counts as "safe
// to settle", and walking a block range in chunks small enough for RPC providers to accept.

import { FetchRequest, JsonRpcProvider, type Log } from "ethers";

export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/// A JSON-RPC provider with a request timeout. ethers' default is 5 minutes, long enough for one
/// hung RPC call to freeze an adapter's whole poll (and its health) for that long.
export function makeProvider(url: string, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): JsonRpcProvider {
  const request = new FetchRequest(url);
  request.timeout = timeoutMs;
  return new JsonRpcProvider(request);
}

export interface EndpointCheck {
  label: string;
  /// Chain ID the RPC must report, or null to accept any (logged either way).
  expectedChainId: bigint | null;
  /// Contracts that must have code on this chain, by description.
  contracts: Record<string, string>;
}

/// Startup sanity check: the RPC is the chain it's configured as, and the configured contracts
/// actually exist on it. Catches a testnet RPC paired with mainnet addresses (or vice versa), or a
/// typo'd address, before the relayer acts on them.
export async function verifyEndpoint(provider: JsonRpcProvider, { label, expectedChainId, contracts }: EndpointCheck): Promise<bigint> {
  const { chainId } = await provider.getNetwork();
  if (expectedChainId !== null && chainId !== expectedChainId) {
    throw new Error(`[${label}] RPC reports chain ID ${chainId}, but it's configured for chain ${expectedChainId} - wrong RPC URL?`);
  }
  for (const [what, address] of Object.entries(contracts)) {
    if ((await provider.getCode(address)) === "0x") {
      throw new Error(`[${label}] No contract code for ${what} at ${address} on chain ${chainId} - wrong address, or wrong network?`);
    }
  }
  return chainId;
}

/// How settled a source-chain block must be before deposits in it are paid out: a fixed number of
/// blocks behind the head, or one of the consensus-backed tags. AssetHub/Ethereum payouts rest
/// purely on the relayer's say-so, so paying for a deposit that's later reorged away is a straight
/// loss - "finalized" is the default there for that reason.
export type Confirmations = number | "safe" | "finalized";

export function parseConfirmations(name: string, value: string | undefined, fallback: Confirmations): Confirmations {
  if (value === undefined || value === "") return fallback;
  if (value === "safe" || value === "finalized") return value;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, "safe" or "finalized" (got "${value}").`);
  }
  return n;
}

export function describeConfirmations(confirmations: Confirmations): string {
  return typeof confirmations === "number" ? `${confirmations} confirmation(s)` : `"${confirmations}" blocks`;
}

/// The newest block whose deposits are safe to settle under the given confirmation policy.
export async function getSafeHead(provider: JsonRpcProvider, confirmations: Confirmations): Promise<number> {
  if (typeof confirmations === "number") {
    return (await provider.getBlockNumber()) - confirmations;
  }
  const block = await provider.getBlock(confirmations);
  if (!block) {
    throw new Error(`RPC returned no "${confirmations}" block - if this chain's RPC doesn't support that tag, use a block count instead.`);
  }
  return block.number;
}

export interface LogScan {
  provider: JsonRpcProvider;
  address: string;
  topic: string;
  chunkSize: number;
}

/// Fetches logs for [fromBlock, toBlock] in chunks of at most `chunkSize` blocks, in order. Most
/// providers reject a single eth_getLogs over a large range (often >1k-10k blocks), which without
/// chunking would make an adapter that fell behind (downtime, or an old start block) fail every
/// tick forever. `handle` returns the block it stalled at (to retry from there), or null to move
/// on; `onProgress` gets the next block to resume from after every chunk, so progress through a
/// long backlog is checkpointed as it goes rather than only once it's all done. `shouldStop` is
/// checked between chunks (for shutdown). Returns the next block to scan from.
export async function scanLogs(
  { provider, address, topic, chunkSize }: LogScan,
  fromBlock: number,
  toBlock: number,
  handle: (logs: Log[]) => Promise<number | null>,
  onProgress: (nextFromBlock: number) => void,
  shouldStop: () => boolean = () => false,
): Promise<number> {
  let start = fromBlock;
  while (start <= toBlock && !shouldStop()) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    const logs = await provider.getLogs({ address, topics: [topic], fromBlock: start, toBlock: end });
    const stalledAtBlock = await handle(logs);
    start = stalledAtBlock ?? end + 1;
    onProgress(start);
    if (stalledAtBlock !== null) break;
  }
  return start;
}
