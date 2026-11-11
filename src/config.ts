import 'dotenv/config';
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { DEFAULT_RPC_TIMEOUT_MS, parseConfirmations, type Confirmations } from "./chain.js";

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

function optionalChainId(name: string): bigint | null {
  const value = process.env[name];
  if (!value) return null;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a numeric chain ID (got "${value}").`);
  return BigInt(value);
}

const checkpointDir = process.env.CHECKPOINT_DIR ?? ".checkpoints";

function marketRoute(value: string | undefined): "xcm" | "gateway" {
  if (value === undefined || value === "") return "xcm";
  if (value !== "xcm" && value !== "gateway") throw new Error(`ASSETHUB_MARKET_ROUTE must be "xcm" or "gateway" (got "${value}").`);
  return value;
}

/// A signing key from the first of these that's set (exactly one may be):
///   1. the systemd credential `credential` ($CREDENTIALS_DIRECTORY/<credential>) - production,
///      encrypted at rest via LoadCredentialEncrypted (see systemd/xon-relayer.service);
///   2. `<envVar>_FILE` - a file holding the key (e.g. a Docker secret);
///   3. `<envVar>` - the key itself (development/tests only).
/// The env var is deleted once read, so nothing this process spawns inherits it. Never echoed.
function loadKey(what: string, credential: string, envVar: string): { key: string; source: string } | null {
  const credentialDir = process.env.CREDENTIALS_DIRECTORY;
  const credentialFile = credentialDir ? path.join(credentialDir, credential) : null;
  const candidates: { source: string; read: () => string }[] = [];
  if (credentialFile && existsSync(credentialFile)) {
    candidates.push({ source: `systemd credential "${credential}"`, read: () => readFileSync(credentialFile, "utf8") });
  }
  const keyFile = process.env[`${envVar}_FILE`];
  if (keyFile) candidates.push({ source: `${envVar}_FILE (${keyFile})`, read: () => readFileSync(keyFile, "utf8") });
  const envKey = process.env[envVar];
  if (envKey) candidates.push({ source: `${envVar} env var`, read: () => envKey });
  delete process.env[envVar];

  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new Error(`The ${what} is set in more than one place (${candidates.map((c) => c.source).join(", ")}) - set exactly one.`);
  }
  const [{ source, read }] = candidates;
  const raw = read().trim();
  // Never echo the value - only say what's wrong with it. Wallets often export keys without the
  // 0x prefix (MetaMask does), so accept that too.
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`The ${what} from ${source} isn't a 32-byte hex private key (64 hex characters, optionally prefixed with 0x).`);
  }
  return { key: raw.startsWith("0x") ? raw : `0x${raw}`, source };
}

/// The relayer's signing key (credential "relayer-key", RELAYER_PRIVATE_KEY_FILE, or
/// RELAYER_PRIVATE_KEY). Only things that sign call this (the relayer, settle-held); read-only
/// tools and the front-end API never load the key.
export function loadRelayerKey(): { key: string; source: string } {
  const loaded = loadKey("relayer key", "relayer-key", "RELAYER_PRIVATE_KEY");
  if (!loaded) {
    throw new Error(`No relayer key: load it as the systemd credential "relayer-key", or set RELAYER_PRIVATE_KEY_FILE (or RELAYER_PRIVATE_KEY for development).`);
  }
  return loaded;
}

/// The rate keeper's key (see rateKeeper.ts) - credential "rate-keeper-key",
/// RATE_KEEPER_PRIVATE_KEY_FILE or RATE_KEEPER_PRIVATE_KEY - or null for none. Loaded only by the
/// relayer, never at import: the API and tools share the same settings and must not read it.
export function loadRateKeeperKey(): { key: string; source: string } | null {
  return loadKey("rate keeper key", "rate-keeper-key", "RATE_KEEPER_PRIVATE_KEY");
}

/// Comma-separated URLs, or none.
function urlList(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((u) => u.trim()).filter(Boolean);
}

function bps(name: string, fallback: number): bigint {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new Error(`${name} must be basis points from 0 to 10000 (got "${process.env[name]}").`);
  return BigInt(value);
}

export const config = {
  // Xode side - every adapter ends up calling settlePurchase/settleExternalPurchase here.
  xodeEthRpc: process.env.XODE_ETH_RPC ?? "http://127.0.0.1:8546",
  vendingAddress: required("VENDING_ADDRESS"),
  // Optional, but set them in production: the relayer refuses to start if an RPC reports a
  // different chain, so a testnet RPC can't be paired with mainnet addresses (or vice versa).
  xodeChainId: optionalChainId("XODE_CHAIN_ID"),
  // Development only: start even though the relayer key is also the vending contract's owner.
  allowOwnerAsRelayer: bool("ALLOW_OWNER_AS_RELAYER", false),
  // Xode's Substrate RPC (ws:// or wss://), for market-price payouts: the front-end API quotes
  // swaps from the DEX with it, and the relayer asks it why a swap failed (paused, pool pending, or
  // below the buyer's minimum - see xodeDex.ts). Without it, failed swaps are only ever retried.
  xodeSubstrateRpc: process.env.XODE_SUBSTRATE_RPC || null,
  rpcTimeoutMs: Number(process.env.RPC_TIMEOUT_MS ?? DEFAULT_RPC_TIMEOUT_MS),

  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5000),
  // Max blocks per eth_getLogs call - lower it if a provider rejects ranges this large.
  logChunkSize: Number(process.env.LOG_CHUNK_SIZE ?? 2000),
  checkpointDir,
  // Append-only JSON Lines record of every settle attempt - see ledger.ts.
  ledgerFile: process.env.LEDGER_FILE ?? path.join(checkpointDir, "ledger.jsonl"),

  // Only used on a genuinely first run (no checkpoint file yet) - e.g. if you're bootstrapping
  // the xode adapter against a contract that might already have unsettled deposits sitting on it.
  xodeStartBlock: optionalNumber("XODE_START_BLOCK"),
  // Finalized by default: the payout is backed by the contract's own balance check, but the
  // checkpoint never moves back - a deposit a reorg re-included below it would never be seen.
  // CONFIRMATIONS is the pre-per-chain name for this setting, still honoured.
  xodeConfirmations: process.env.XODE_CONFIRMATIONS !== undefined
    ? confirmations("XODE_CONFIRMATIONS", "finalized")
    : confirmations("CONFIRMATIONS", "finalized"),
  xodeCheckpointFile: "xode.json",

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
  // USDT the vending contract holds for market-price payouts (`accountedUsdt`); below this, alert.
  minUsdtInventory: optionalUsdt("MIN_USDT_INVENTORY"),

  // Fixed-rate drift (see rateKeeper.ts; needs XODE_SUBSTRATE_RPC for the DEX price). Without a
  // keeper key it only alerts past RATE_ALERT_BPS; with one it also moves the rate toward the
  // market whenever it's more than RATE_DEADBAND_BPS off, within the contract's own bounds.
  rateKeeperIntervalMs: Number(process.env.RATE_KEEPER_INTERVAL_MS ?? 60_000),
  // The keeper acts on the median of this many DEX price samples, one per check, from different
  // blocks - so moving the pool for a block or two (a flash swap) can't steer the rate or pause it.
  rateKeeperSamples: Number(process.env.RATE_KEEPER_SAMPLES ?? 5),
  rateDeadbandBps: bps("RATE_DEADBAND_BPS", 50),
  rateAlertBps: bps("RATE_ALERT_BPS", 300),
  // Past this, the keeper pauses the fixed-rate paths until the rate is back within half of it
  // (0 = never). Defaults to RATE_ALERT_BPS.
  ratePauseBps: bps("RATE_PAUSE_BPS", Number(process.env.RATE_ALERT_BPS ?? 300)),
  // Up to this many ms of random wait before a market-price swap executes (see settlement.ts).
  settleJitterMs: Number(process.env.SETTLE_JITTER_MS ?? 15_000),
  // Optional chat webhook (Slack/Discord/Mattermost-style) that alerts are POSTed to.
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || null,

  // Front-end API (`npm run api`, see src/api/) - a separate, keyless process: it builds unsigned
  // transactions for the buyer's wallet to sign and reads chain state, but never signs anything.
  // Bound to localhost by default - put it behind a TLS reverse proxy to expose it.
  apiHost: process.env.API_HOST ?? "127.0.0.1",
  apiPort: Number(process.env.API_PORT ?? 8080),
  // Origins allowed to call the API from a browser (comma-separated, or "*"). Empty allows none.
  apiCorsOrigins: (process.env.API_CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
  // How far the fixed rate may drop between a gateway deposit being prepared and being settled
  // before the deposit is refunded instead of paid less: the deposit carries the quote less this
  // as its minimum (basis points). The rate keeper moves the rate by at most a few percent at a time.
  fixedRateToleranceBps: Number(process.env.FIXED_RATE_TOLERANCE_BPS ?? 300),
  // Market-price purchases from AssetHub. "xcm" (default): one call to AssetHub's XCM precompile
  // moves the buyer's USDT to Xode and swaps it on the DEX on arrival - no gateway, no relayer, no
  // USDT inventory (see xcmSwap.ts; needs XODE_SUBSTRATE_RPC). "gateway": the older
  // depositForSwap into the AssetHub gateway, paid by the relayer from the vending contract.
  // Fixed-rate AssetHub purchases always use the gateway.
  assetHubMarketRoute: marketRoute(process.env.ASSETHUB_MARKET_ROUTE),
  // Xode's parachain id - where the XCM route sends the USDT.
  xodeParaId: Number(process.env.XODE_PARA_ID ?? 3417),
  // XCM-route purchases the API has seen settle, for /api/deposits (the relayer's ledger never
  // sees them: nothing of theirs passes through the relayer).
  xcmPurchasesFile: process.env.XCM_PURCHASES_FILE ?? path.join(checkpointDir, "xcm-purchases.jsonl"),
  // Cap on open event streams (tx waits + address watches) across all clients.
  apiMaxStreams: Number(process.env.API_MAX_STREAMS ?? 500),
  // How often the API's block scanner polls each chain while someone is subscribed.
  apiPollIntervalMs: Number(process.env.API_POLL_INTERVAL_MS ?? 3000),

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
    chainId: optionalChainId("ASSETHUB_CHAIN_ID"),
    checkpointFile: "assethub.json",
    // Independent RPCs that must each confirm a deposit before it's paid (see crossCheck.ts).
    verifyRpcUrls: urlList("ASSETHUB_VERIFY_RPCS"),
    // Only for display by the front-end API - its eth-rpc bridge reports balances with 18 decimals.
    nativeSymbol: process.env.ASSETHUB_NATIVE_SYMBOL ?? "DOT",
  },

  // Ethereum adapter - watches UsdtGateway.Deposited on the actual Ethereum network (or any
  // EVM chain you deployed it to, including a local anvil instance for testing).
  ethereum: {
    rpcUrl: process.env.ETHEREUM_RPC,
    gatewayAddress: process.env.ETH_GATEWAY_ADDRESS,
    startBlock: optionalNumber("ETHEREUM_START_BLOCK"),
    confirmations: confirmations("ETHEREUM_CONFIRMATIONS", "finalized"),
    chainId: optionalChainId("ETHEREUM_CHAIN_ID"),
    checkpointFile: "ethereum.json",
    verifyRpcUrls: urlList("ETHEREUM_VERIFY_RPCS"),
    nativeSymbol: process.env.ETHEREUM_NATIVE_SYMBOL ?? "ETH",
  },
};

export type Config = typeof config;

/// The relayer (the process that signs payouts) must be told which chain each RPC is supposed to
/// be: a deposit id names its source only by label ("ethereum", "assethub"), so an RPC URL that
/// points at the wrong network - a testnet, a fork - would have its deposits attested and paid in
/// real XON. With the chain IDs set, startup refuses an RPC that reports another chain. The API and
/// the tools don't sign anything and may run without them.
export function requireChainIds(): void {
  const missing = [
    config.xodeChainId === null ? "XODE_CHAIN_ID" : null,
    config.assetHub.rpcUrl && config.assetHub.gatewayAddress && config.assetHub.chainId === null ? "ASSETHUB_CHAIN_ID" : null,
    config.ethereum.rpcUrl && config.ethereum.gatewayAddress && config.ethereum.chainId === null ? "ETHEREUM_CHAIN_ID" : null,
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} must be set: the relayer only pays deposits from RPCs that report the chain ID it was told to expect (Polkadot AssetHub is 420420419, Ethereum mainnet 1).`);
  }
}

export function validateConfig(): void {
  const positiveIntegers = {
    POLL_INTERVAL_MS: config.pollIntervalMs,
    LOG_CHUNK_SIZE: config.logChunkSize,
    STALL_ALERT_AFTER_MS: config.stallAlertAfterMs,
    MONITOR_INTERVAL_MS: config.monitorIntervalMs,
    SHUTDOWN_TIMEOUT_MS: config.shutdownTimeoutMs,
    RPC_TIMEOUT_MS: config.rpcTimeoutMs,
    API_MAX_STREAMS: config.apiMaxStreams,
    API_POLL_INTERVAL_MS: config.apiPollIntervalMs,
    RATE_KEEPER_INTERVAL_MS: config.rateKeeperIntervalMs,
    RATE_KEEPER_SAMPLES: config.rateKeeperSamples,
  };
  for (const [name, value] of Object.entries(positiveIntegers)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer (got "${process.env[name]}").`);
    }
  }
  if (!Number.isInteger(config.httpPort) || config.httpPort < 0 || config.httpPort > 65535) {
    throw new Error(`HTTP_PORT must be 0 (off) or a port number (got "${process.env.HTTP_PORT}").`);
  }
  if (!Number.isInteger(config.apiPort) || config.apiPort < 1 || config.apiPort > 65535) {
    throw new Error(`API_PORT must be a port number (got "${process.env.API_PORT}").`);
  }
  if (!Number.isInteger(config.fixedRateToleranceBps) || config.fixedRateToleranceBps < 0 || config.fixedRateToleranceBps > 2000) {
    throw new Error(`FIXED_RATE_TOLERANCE_BPS must be a whole number of basis points from 0 to 2000 (got "${process.env.FIXED_RATE_TOLERANCE_BPS}").`);
  }
  if (!Number.isInteger(config.xodeParaId) || config.xodeParaId < 1 || config.xodeParaId > 0xffffffff) {
    throw new Error(`XODE_PARA_ID must be a parachain id (got "${process.env.XODE_PARA_ID}").`);
  }
  if (config.xodeSubstrateRpc && !/^wss?:\/\//.test(config.xodeSubstrateRpc)) {
    throw new Error(`XODE_SUBSTRATE_RPC must be a ws:// or wss:// URL (got "${config.xodeSubstrateRpc}").`);
  }
  const addresses = {
    VENDING_ADDRESS: config.vendingAddress,
    ASSETHUB_GATEWAY_ADDRESS: config.assetHub.gatewayAddress,
    ETH_GATEWAY_ADDRESS: config.ethereum.gatewayAddress,
  };
  for (const [name, value] of Object.entries(addresses)) {
    if (value && !ethers.isAddress(value)) throw new Error(`${name} isn't a valid address (got "${value}").`);
  }
  if (config.adapters.assetHub && (!config.assetHub.rpcUrl || !config.assetHub.gatewayAddress)) {
    throw new Error("ENABLE_ASSETHUB_ADAPTER is on but ASSETHUB_EVM_RPC / ASSETHUB_GATEWAY_ADDRESS are not both set.");
  }
  if (config.adapters.ethereum && (!config.ethereum.rpcUrl || !config.ethereum.gatewayAddress)) {
    throw new Error("ENABLE_ETHEREUM_ADAPTER is on but ETHEREUM_RPC / ETH_GATEWAY_ADDRESS are not both set.");
  }
}
