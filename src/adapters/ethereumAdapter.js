import { runEvmGatewayAdapter } from "./evmGatewayAdapter.js";

export function runEthereumAdapter({ settlement, config }) {
  return runEvmGatewayAdapter({
    settlement,
    config,
    sourceChain: "ethereum",
    label: "ethereum",
    rpcUrl: config.ethereum.rpcUrl,
    gatewayAddress: config.ethereum.gatewayAddress,
    startBlock: config.ethereum.startBlock,
    checkpointFile: "ethereum.json",
  });
}
