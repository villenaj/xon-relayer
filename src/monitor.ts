// Periodic checks that aren't tied to any one deposit: the relayer's gas balance, the vending
// contract's XON reserve and its USDT inventory for market-price payouts (any of them running dry
// stalls the adapters behind it - InsufficientReserve and InsufficientUsdtInventory are treated as
// transient), and adapters that have stopped catching up. Alerts fire when a
// condition starts and when it clears, not on every check.

import { ethers } from "ethers";
import { USDT_DECIMALS, type Config } from "./config.js";
import { describeError } from "./errorClassifier.js";
import type { Alerts } from "./alerts.js";
import type { PayoutLimiter } from "./payoutLimits.js";
import type { SettlementClient } from "./settlement.js";
import type { Shutdown } from "./shutdown.js";
import type { Telemetry } from "./telemetry.js";

export interface MonitorOptions {
  settlement: SettlementClient;
  config: Config;
  telemetry: Telemetry;
  alerts: Alerts;
  limiter: PayoutLimiter;
  shutdown: Shutdown;
}

export async function runMonitor({ settlement, config, telemetry, alerts, limiter, shutdown }: MonitorOptions): Promise<void> {
  const { provider, relayerAddress } = settlement;
  const vendingAddress = await settlement.vending.getAddress();
  const low = new Set<string>();
  let stalled = new Set<string>();

  const xon = (v: bigint) => `${ethers.formatEther(v)} XON`;
  const usdt = (v: bigint) => `${ethers.formatUnits(v, USDT_DECIMALS)} USDT`;

  // Tracks one balance against its threshold; returns a warning while it's below.
  function checkBalance(key: string, what: string, balance: bigint, min: bigint | null, fix: string, format = xon): string | null {
    if (min === null) return null;
    const message = `${what} is ${format(balance)}, below the ${format(min)} threshold - ${fix}.`;
    if (balance < min) {
      if (!low.has(key)) alerts.send(message);
      low.add(key);
      return message;
    }
    if (low.delete(key)) alerts.send(`${what} is back to ${format(balance)}.`);
    return null;
  }

  async function check(): Promise<void> {
    const [relayerBalance, reserve, inventory] = await Promise.all([
      provider.getBalance(relayerAddress), provider.getBalance(vendingAddress), settlement.usdtInventory(),
    ]);
    telemetry.setBalances(Number(ethers.formatEther(relayerBalance)), Number(ethers.formatEther(reserve)));
    if (inventory !== null) telemetry.setUsdtInventory(Number(ethers.formatUnits(inventory, USDT_DECIMALS)));
    telemetry.setExternalPaid24h(Number(ethers.formatUnits(limiter.usedInWindow(), USDT_DECIMALS)));

    const warnings = [
      checkBalance("relayer", `Relayer ${relayerAddress} gas balance`, relayerBalance, config.minRelayerBalance, "top it up or settles will start failing"),
      checkBalance("reserve", `Vending contract ${vendingAddress} reserve`, reserve, config.minVendingReserve, "fund it or payouts will stall on InsufficientReserve"),
      inventory === null ? null : checkBalance("inventory", `Vending contract ${vendingAddress} USDT inventory`, inventory, config.minUsdtInventory, "add USDT with fundUsdtInventory (owner key) or market-price payouts will stall on InsufficientUsdtInventory", usdt),
    ].filter((w): w is string => w !== null);
    telemetry.setWarnings(warnings);

    const nowStalled = new Set(telemetry.stalledAdapters());
    const minutes = Math.round(config.stallAlertAfterMs / 60_000);
    for (const adapter of nowStalled) {
      if (!stalled.has(adapter)) {
        alerts.send(`Adapter "${adapter}" hasn't caught up to its chain head for over ${minutes} min - RPC failures, a deposit that keeps failing to settle, or the 24h payout cap. Check its logs.`);
      }
    }
    for (const adapter of stalled) {
      if (!nowStalled.has(adapter)) alerts.send(`Adapter "${adapter}" has caught up again.`);
    }
    stalled = nowStalled;
  }

  while (!shutdown.requested) {
    try {
      await check();
    } catch (err) {
      console.error("[monitor] Check failed:", describeError(err));
    }
    await shutdown.sleep(config.monitorIntervalMs);
  }
}
