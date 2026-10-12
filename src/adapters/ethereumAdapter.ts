import { runEvmGatewayAdapter } from "./evmGatewayAdapter.js";
import type { AdapterContext } from "./types.js";

export function runEthereumAdapter({ settlement, config }: AdapterContext): Promise<never> {
  return runEvmGatewayAdapter({
    settlement,
    config,
    sourceChain: "ethereum",
    label: "ethereum",
    // validateConfig() guarantees both are set whenever this adapter is enabled.
    rpcUrl: config.ethereum.rpcUrl!,
    gatewayAddress: config.ethereum.gatewayAddress!,
    startBlock: config.ethereum.startBlock,
    checkpointFile: "ethereum.json",
  });
}
