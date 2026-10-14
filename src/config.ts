import 'dotenv/config';
import path from "node:path";
import { ethers } from "ethers";
import { parseConfirmations, type Confirmations } from "./chain.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

function optionalNumber(name: string): number | null {
  const value = process.env[name];
  return value ? Number(value) : null;
}

function confirmations(name: string, fallback: Confirmations): Confirmations {
  return parseConfirmations(name, process.env[name], fallback);
}

// USDT has 6 decimals on both Ethereum and AssetHub (asset 1984).
export const USDT_DECIMALS = 6;

/// A human-readable token amount ("5000", "1250.50") as raw units, or null if unset.
function optionalAmount(name: string, decimals: number, unit: string): bigint | null {
  const value = process.env[name];
  if (!value) return null;
  let amount: bigint;
  try {
    amount = ethers.parseUnits(value, decimals);
  } catch {
    throw new Error(`${name} must be a ${unit} amount like "5000" or "1250.50" (got "${value}").`);
  }
  if (amount <= 0n) throw new Error(`${name} must be greater than 0 (got "${value}") - leave it unset to turn it off.`);
  return amount;
}

const optionalUsdt = (name: string) => optionalAmount(name, USDT_DECIMALS, "USDT");
// XON is Xode's native token; its eth-rpc bridge reports balances with 18 decimals.
const optionalXon = (name: string) => optionalAmount(name, 18, "XON");

const checkpointDir = process.env.CHECKPOINT_DIR ?? ".checkpoints";

export const config = {
  // Xode side - every adapter ends up calling settlePurchase/settleExternalPurchase here.
  xodeEthRpc: process.env.XODE_ETH_RPC ?? "http://127.0.0.1:8546",
  vendingAddress: required("VENDING_ADDRESS"),
  relayerPrivateKey: required("RELAYER_PRIVATE_KEY"),

  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5000),
  // Max blocks per eth_getLogs call - lower it if a provider rejects ranges this large.
  logChunkSize: Number(process.env.LOG_CHUNK_SIZE ?? 2000),
  checkpointDir,
  // Append-only JSON Lines record of every settle attempt - see ledger.ts.
  ledgerFile: process.env.LEDGER_FILE ?? path.join(checkpointDir, "ledger.jsonl"),

  // Only used on a genuinely first run (no checkpoint file yet) - e.g. if you're bootstrapping
  // the xode adapter against a contract that might already have unsettled deposits sitting on it.
  xodeStartBlock: optionalNumber("XODE_START_BLOCK"),
  // The Xode path is backed by the contract's own balance check, so a block count is enough here.
  // CONFIRMATIONS is the pre-per-chain name for this setting, still honoured.
  xodeConfirmations: process.env.XODE_CONFIRMATIONS !== undefined
    ? confirmations("XODE_CONFIRMATIONS", 1)
    : confirmations("CONFIRMATIONS", 1),

  // Caps on AssetHub/Ethereum payouts, in USDT - see payoutLimits.ts. Unset means no cap.
  payoutLimits: {
    maxPerDeposit: optionalUsdt("MAX_EXTERNAL_DEPOSIT_USDT"),
    maxPer24h: optionalUsdt("MAX_EXTERNAL_DAILY_USDT"),
  },

  // /health + /metrics HTTP server (see telemetry.ts). HTTP_PORT=0 turns it off. Bound to
  // localhost by default - put a reverse proxy in front, or set HTTP_HOST, to expose it.
  httpHost: process.env.HTTP_HOST ?? "127.0.0.1",
  httpPort: Number(process.env.HTTP_PORT ?? 9464),
  // An adapter that hasn't caught up to its chain head for this long is reported unhealthy/alerted.
  stallAlertAfterMs: Number(process.env.STALL_ALERT_AFTER_MS ?? 600_000),

  // Balance monitoring (see monitor.ts). Unset thresholds mean no alert for that balance (it's
  // still exported as a metric).
  monitorIntervalMs: Number(process.env.MONITOR_INTERVAL_MS ?? 60_000),
  minRelayerBalance: optionalXon("MIN_RELAYER_BALANCE_XON"),
  minVendingReserve: optionalXon("MIN_VENDING_RESERVE_XON"),
  // Optional chat webhook (Slack/Discord/Mattermost-style) that alerts are POSTed to.
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || null,

  // How long to let in-flight settles finish after SIGTERM/SIGINT before exiting anyway. Keep
  // systemd's TimeoutStopSec above this.
  shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 120_000),

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
    startBlock: optionalNumber("ASSETHUB_START_BLOCK"),
    confirmations: confirmations("ASSETHUB_CONFIRMATIONS", "finalized"),
  },

  // Ethereum adapter - watches UsdtGateway.Deposited on the actual Ethereum network (or any
  // EVM chain you deployed it to, including a local anvil instance for testing).
  ethereum: {
    rpcUrl: process.env.ETHEREUM_RPC,
    gatewayAddress: process.env.ETH_GATEWAY_ADDRESS,
    startBlock: optionalNumber("ETHEREUM_START_BLOCK"),
    confirmations: confirmations("ETHEREUM_CONFIRMATIONS", "finalized"),
  },
};

export type Config = typeof config;

export function validateConfig(): void {
  const positiveIntegers = {
    POLL_INTERVAL_MS: config.pollIntervalMs,
    LOG_CHUNK_SIZE: config.logChunkSize,
    STALL_ALERT_AFTER_MS: config.stallAlertAfterMs,
    MONITOR_INTERVAL_MS: config.monitorIntervalMs,
    SHUTDOWN_TIMEOUT_MS: config.shutdownTimeoutMs,
  };
  for (const [name, value] of Object.entries(positiveIntegers)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer (got "${process.env[name]}").`);
    }
  }
  if (!Number.isInteger(config.httpPort) || config.httpPort < 0 || config.httpPort > 65535) {
    throw new Error(`HTTP_PORT must be 0 (off) or a port number (got "${process.env.HTTP_PORT}").`);
  }
  if (config.adapters.assetHub && (!config.assetHub.rpcUrl || !config.assetHub.gatewayAddress)) {
    throw new Error("ENABLE_ASSETHUB_ADAPTER is on but ASSETHUB_EVM_RPC / ASSETHUB_GATEWAY_ADDRESS are not both set.");
  }
  if (config.adapters.ethereum && (!config.ethereum.rpcUrl || !config.ethereum.gatewayAddress)) {
    throw new Error("ENABLE_ETHEREUM_ADAPTER is on but ETHEREUM_RPC / ETH_GATEWAY_ADDRESS are not both set.");
  }
}
