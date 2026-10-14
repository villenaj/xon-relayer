import { ethers } from "ethers";
import type { Server } from "node:http";
import { config, USDT_DECIMALS, validateConfig } from "./config.js";
import { createSettlementClient } from "./settlement.js";
import { makeLedger, readLedger, type Ledger } from "./ledger.js";
import { makePayoutLimiter } from "./payoutLimits.js";
import { makeAlerts } from "./alerts.js";
import { makeShutdown } from "./shutdown.js";
import { startHttpServer, Telemetry } from "./telemetry.js";
import { runMonitor } from "./monitor.js";
import { runXodeAdapter } from "./adapters/xodeAdapter.js";
import { runAssetHubAdapter } from "./adapters/assetHubAdapter.js";
import { runEthereumAdapter } from "./adapters/ethereumAdapter.js";

async function main(): Promise<void> {
  validateConfig();

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
    relayerPrivateKey: config.relayerPrivateKey,
  });
  console.log(`Relayer address: ${settlement.relayerAddress}`);
  console.log(`Vending contract: ${config.vendingAddress}`);

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
  if (config.minRelayerBalance === null || config.minVendingReserve === null) {
    console.warn("MIN_RELAYER_BALANCE_XON / MIN_VENDING_RESERVE_XON not both set - no low-balance alert for the unset one.");
  }

  const context = { settlement, config, ledger, limiter, telemetry, alerts, shutdown };
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
  await Promise.all([...adapters, runMonitor(context)]);

  server?.close();
  console.log("Shut down cleanly.");
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
