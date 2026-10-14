// AssetHub now runs pallet-revive (enacted via governance, ~January 2026), so this leg works
// exactly like the Ethereum one - a UsdtGateway contract deployed on AssetHub itself, watched over
// AssetHub's own pallet-revive-eth-rpc bridge. This replaces the old batchAll/remark + raw
// Substrate-extrinsic-scanning approach this file used before AssetHub could run contracts.

import { runEvmGatewayAdapter } from "./evmGatewayAdapter.js";
import type { AdapterContext } from "./types.js";

export function runAssetHubAdapter(context: AdapterContext): Promise<void> {
  const { config } = context;
  return runEvmGatewayAdapter({
    ...context,
    sourceChain: "assethub",
    label: "assethub",
    // validateConfig() guarantees both are set whenever this adapter is enabled.
    rpcUrl: config.assetHub.rpcUrl!,
    gatewayAddress: config.assetHub.gatewayAddress!,
    startBlock: config.assetHub.startBlock,
    confirmations: config.assetHub.confirmations,
    checkpointFile: "assethub.json",
  });
}
