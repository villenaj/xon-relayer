// AssetHub now runs pallet-revive (enacted via governance, ~January 2026), so this leg works
// exactly like the Ethereum one - a UsdtGateway contract deployed on AssetHub itself, watched over
// AssetHub's own pallet-revive-eth-rpc bridge. This replaces the old batchAll/remark + raw
// Substrate-extrinsic-scanning approach this file used before AssetHub could run contracts.

import { runEvmGatewayAdapter } from "./evmGatewayAdapter.js";

export function runAssetHubAdapter({ settlement, config }) {
  return runEvmGatewayAdapter({
    settlement,
    config,
    sourceChain: "assethub",
    label: "assethub",
    rpcUrl: config.assetHub.rpcUrl,
    gatewayAddress: config.assetHub.gatewayAddress,
    startBlock: config.assetHub.startBlock,
    checkpointFile: "assethub.json",
  });
}
