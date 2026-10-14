import { runEvmGatewayAdapter } from "./evmGatewayAdapter.js";
import type { AdapterContext } from "./types.js";

export function runEthereumAdapter(context: AdapterContext): Promise<void> {
  const { config } = context;
  return runEvmGatewayAdapter({
    ...context,
    sourceChain: "ethereum",
    label: "ethereum",
    // validateConfig() guarantees both are set whenever this adapter is enabled.
    rpcUrl: config.ethereum.rpcUrl!,
    gatewayAddress: config.ethereum.gatewayAddress!,
    startBlock: config.ethereum.startBlock,
    startBlockName: "ETHEREUM_START_BLOCK",
    confirmations: config.ethereum.confirmations,
    checkpointFile: config.ethereum.checkpointFile,
  });
}
