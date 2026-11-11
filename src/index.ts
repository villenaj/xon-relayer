import { ethers } from "ethers";
import type { Server } from "node:http";
import { config, loadRateKeeperKey, loadRelayerKey, requireChainIds, USDT_DECIMALS, validateConfig } from "./config.js";
import { acquireInstanceLock } from "./instanceLock.js";
import { createSettlementClient, type SettlementClient } from "./settlement.js";
import { makeLedger, readLedger, type Ledger } from "./ledger.js";
import { makePayoutLimiter } from "./payoutLimits.js";
import { makeAlerts } from "./alerts.js";
import { makeShutdown } from "./shutdown.js";
import { startHttpServer, Telemetry } from "./telemetry.js";
import { runMonitor } from "./monitor.js";
import { runXodeAdapter } from "./adapters/xodeAdapter.js";
import { runAssetHubAdapter } from "./adapters/assetHubAdapter.js";
import { runEthereumAdapter } from "./adapters/ethereumAdapter.js";
import { connectXodeDex, type XodeDex } from "./xodeDex.js";
import { runRateKeeper } from "./rateKeeper.js";

async function main(): Promise<void> {
  validateConfig();
  requireChainIds();
  acquireInstanceLock(config.checkpointDir);
  const relayerKey = loadRelayerKey();
  if (relayerKey.source.startsWith("RELAYER_PRIVATE_KEY env")) {
    console.warn("Relayer key comes from a plain env var - fine for development, but use the systemd credential in production (see README).");
  }
  const rateKeeperKey = loadRateKeeperKey();
  if (rateKeeperKey?.source.startsWith("RATE_KEEPER_PRIVATE_KEY env")) {
    console.warn("Rate keeper key comes from a plain env var - the front-end API reads the same settings file. Use the systemd credential \"rate-keeper-key\" or RATE_KEEPER_PRIVATE_KEY_FILE in production.");
  }

  // SIGTERM (systemd stop) / SIGINT (Ctrl+C): stop taking on new deposits, let the one in flight
  // finish, save checkpoints, exit. A second signal, or the timeout, exits immediately - safe,
  // since settling is idempotent and a half-done deposit is just retried on the next start.
  const shutdown = makeShutdown();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (shutdown.requested) {
        console.error(`${signal} again - exiting immediately.`);
        process.exit(1);
      }
      console.log(`${signal} received - finishing in-flight settles (up to ${config.shutdownTimeoutMs / 1000}s)...`);
      shutdown.request();
      setTimeout(() => {
        console.error("Shutdown timed out - exiting with work still in flight (it will be retried on restart).");
        process.exit(1);
      }, config.shutdownTimeoutMs).unref();
    });
  }

  const alerts = makeAlerts(config.alertWebhookUrl);
  const telemetry = new Telemetry(config.stallAlertAfterMs);
  let server: Server | null = null;
  if (config.httpPort !== 0) {
    server = await startHttpServer(telemetry, shutdown, config.httpHost, config.httpPort);
    console.log(`Serving /health and /metrics on http://${config.httpHost}:${config.httpPort}`);
  }

  const settlement = await createSettlementClient({
    xodeEthRpc: config.xodeEthRpc,
    vendingAddress: config.vendingAddress,
    relayerPrivateKey: relayerKey.key,
    expectedChainId: config.xodeChainId,
    rpcTimeoutMs: config.rpcTimeoutMs,
    allowOwnerAsRelayer: config.allowOwnerAsRelayer,
    roles: { native: config.adapters.xode, external: config.adapters.assetHub || config.adapters.ethereum },
    settleJitterMs: config.settleJitterMs,
  });
  console.log(`Relayer address: ${settlement.relayerAddress} (key from ${relayerKey.source})`);
  console.log(`Vending contract: ${config.vendingAddress} on Xode chain ${settlement.chainId}`);

  const fileLedger = makeLedger(config.ledgerFile);
  const ledger: Ledger = {
    record(entry) {
      fileLedger.record(entry);
      telemetry.settleAttempt(entry.adapter, entry.status);
    },
  };
  console.log(`Recording settle attempts to ${config.ledgerFile}`);

  const limiter = makePayoutLimiter(config.payoutLimits, readLedger(config.ledgerFile));
  const { maxPerDeposit, maxPer24h } = config.payoutLimits;
  const usdt = (v: bigint | null) => (v === null ? "no cap" : `${ethers.formatUnits(v, USDT_DECIMALS)} USDT`);
  console.log(
    `External payout caps: per deposit ${usdt(maxPerDeposit)}, per 24h ${usdt(maxPer24h)} ` +
    `(${usdt(limiter.usedInWindow())} already paid in the last 24h).`,
  );
  if ((config.adapters.assetHub || config.adapters.ethereum) && maxPerDeposit === null && maxPer24h === null) {
    console.warn("No MAX_EXTERNAL_DEPOSIT_USDT / MAX_EXTERNAL_DAILY_USDT set - AssetHub/Ethereum payouts are uncapped.");
  }
  if (config.adapters.assetHub || config.adapters.ethereum) await checkOnChainLimits(settlement, maxPerDeposit, maxPer24h);
  if (config.minRelayerBalance === null || config.minVendingReserve === null) {
    console.warn("MIN_RELAYER_BALANCE_XON / MIN_VENDING_RESERVE_XON not both set - no low-balance alert for the unset one.");
  }

  // Xode's DEX over Substrate RPC: tells a market-price deposit the pool can no longer pay (refund)
  // from a swap that failed for a reason that clears up (paused, pool pending - retry).
  let dex: XodeDex | null = null;
  if (config.xodeSubstrateRpc) {
    dex = await connectXodeDex(config.xodeSubstrateRpc);
    console.log(`Diagnosing failed market-price swaps via ${config.xodeSubstrateRpc}`);
  } else if (config.adapters.assetHub || config.adapters.ethereum) {
    console.warn("XODE_SUBSTRATE_RPC is not set - a market-price (depositForSwap) deposit whose swap fails is retried forever, even when the pool can never meet its minimum. Set it to send those to the refund list.");
  }
  if (await settlement.usdtInventory() === null) {
    console.warn("XonVendingMachine predates market-price payouts (no accountedUsdt) - depositForSwap deposits will fail to settle until it's redeployed.");
  } else if (config.minUsdtInventory === null) {
    console.warn("MIN_USDT_INVENTORY not set - no alert when the USDT inventory for market-price payouts runs low.");
  }

  const context = { settlement, config, ledger, limiter, telemetry, alerts, shutdown, dex };
  const adapters: Promise<void>[] = [];
  if (config.adapters.xode) adapters.push(runXodeAdapter(context));
  if (config.adapters.assetHub) adapters.push(runAssetHubAdapter(context));
  if (config.adapters.ethereum) adapters.push(runEthereumAdapter(context));

  if (adapters.length === 0) {
    throw new Error("No adapters enabled - set ENABLE_XODE_ADAPTER/ENABLE_ASSETHUB_ADAPTER/ENABLE_ETHEREUM_ADAPTER.");
  }

  // Each adapter and the monitor loop until shutdown, handling anything retryable internally - so
  // a rejection here is truly unrecoverable, and brings the whole process down (Promise.all
  // rejects on the first one) rather than leaving it running half-working.
  const keeperLoop = dex ? [runRateKeeper({ settlement, config, dex, telemetry, alerts, shutdown, keeperKey: rateKeeperKey?.key ?? null })] : [];
  if (!dex && rateKeeperKey) console.warn("RATE_KEEPER_PRIVATE_KEY is set but XODE_SUBSTRATE_RPC isn't - the keeper needs the DEX price, so it won't run.");
  await Promise.all([...adapters, runMonitor(context), ...keeperLoop]);

  server?.close();
  await dex?.disconnect();
  console.log("Shut down cleanly.");
}

/// Logs XonVendingMachine's own limits on AssetHub/Ethereum payouts, and warns where they'd get in
/// the way: off (nothing external gets paid), or tighter than the relayer's caps (deposits the
/// relayer would pay get held or stall on the contract's limit instead).
async function checkOnChainLimits(settlement: SettlementClient, relayerPerDeposit: bigint | null, relayerPer24h: bigint | null): Promise<void> {
  const limits = await settlement.externalLimits();
  if (!limits) {
    console.warn("XonVendingMachine has no on-chain limits on external payouts (an older deployment) - a stolen relayer key could drain its whole reserve. See the redeploy steps in the contracts repo runbook (docs/xon-vending-runbook.md).");
    return;
  }
  const usdt = (v: bigint) => `${ethers.formatUnits(v, USDT_DECIMALS)} USDT`;
  console.log(`On-chain external limits: per deposit ${usdt(limits.maxPerDeposit)}, per 24h ${usdt(limits.maxPerDay)} (${usdt(limits.available)} available now).`);
  if (limits.maxPerDeposit === 0n || limits.maxPerDay === 0n) {
    console.warn("XonVendingMachine's external limits are 0, so AssetHub/Ethereum deposits will all be held - the owner needs to call setExternalLimits.");
    return;
  }
  if (relayerPerDeposit === null || relayerPerDeposit > limits.maxPerDeposit) {
    console.warn("MAX_EXTERNAL_DEPOSIT_USDT is unset or above the on-chain per-deposit limit - deposits between the two will be held by the contract instead of the relayer. Set it at or below the on-chain limit.");
  }
  if (relayerPer24h === null || relayerPer24h > limits.maxPerDay) {
    console.warn("MAX_EXTERNAL_DAILY_USDT is unset or above the on-chain daily limit - the adapters will stall on OverExternalDailyLimit instead of pausing at the relayer's cap. Set it at or below the on-chain limit.");
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
