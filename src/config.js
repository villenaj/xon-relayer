import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function bool(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

export const config = {
  // Xode side - every adapter ends up calling settlePurchase/settleExternalPurchase here.
  xodeEthRpc: process.env.XODE_ETH_RPC ?? "http://127.0.0.1:8546",
  vendingAddress: required("VENDING_ADDRESS"),
  relayerPrivateKey: required("RELAYER_PRIVATE_KEY"),

  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5000),
  confirmations: Number(process.env.CONFIRMATIONS ?? 1),
  checkpointDir: process.env.CHECKPOINT_DIR ?? ".checkpoints",

  // Only used on a genuinely first run (no checkpoint file yet) - e.g. if you're bootstrapping
  // the xode adapter against a contract that might already have unsettled deposits sitting on it.
  xodeStartBlock: process.env.XODE_START_BLOCK ? Number(process.env.XODE_START_BLOCK) : null,

  adapters: {
    xode: bool("ENABLE_XODE_ADAPTER", true),
    assetHub: bool("ENABLE_ASSETHUB_ADAPTER", true),
    ethereum: bool("ENABLE_ETHEREUM_ADAPTER", true),
  },

  // AssetHub adapter - now that AssetHub runs pallet-revive, this works exactly like the Ethereum
  // leg: a UsdtGateway contract deployed on AssetHub itself, watched over AssetHub's own
  // pallet-revive-eth-rpc bridge (a separate eth-rpc instance from Xode's, pointed at AssetHub's
  // own Substrate RPC).
  assetHub: {
    rpcUrl: process.env.ASSETHUB_EVM_RPC,
    gatewayAddress: process.env.ASSETHUB_GATEWAY_ADDRESS,
    startBlock: process.env.ASSETHUB_START_BLOCK ? Number(process.env.ASSETHUB_START_BLOCK) : null,
  },

  // Ethereum adapter - watches UsdtGateway.Deposited on the actual Ethereum network (or any
  // EVM chain you deployed it to, including a local anvil instance for testing).
  ethereum: {
    rpcUrl: process.env.ETHEREUM_RPC,
    gatewayAddress: process.env.ETH_GATEWAY_ADDRESS,
    startBlock: process.env.ETHEREUM_START_BLOCK ? Number(process.env.ETHEREUM_START_BLOCK) : null,
  },
};

export function validateConfig() {
  if (config.adapters.assetHub && (!config.assetHub.rpcUrl || !config.assetHub.gatewayAddress)) {
    throw new Error("ENABLE_ASSETHUB_ADAPTER is on but ASSETHUB_EVM_RPC / ASSETHUB_GATEWAY_ADDRESS are not both set.");
  }
  if (config.adapters.ethereum && (!config.ethereum.rpcUrl || !config.ethereum.gatewayAddress)) {
    throw new Error("ENABLE_ETHEREUM_ADAPTER is on but ETHEREUM_RPC / ETH_GATEWAY_ADDRESS are not both set.");
  }
}
