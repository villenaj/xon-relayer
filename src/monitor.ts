// Periodic checks that aren't tied to any one deposit: the relayer's gas balance, USDT that
// reached the vending contract without a Transfer log (strayUsdt.ts), the vending
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
import { makeAccountedTransfers } from "./adapters/accountedTransfers.js";
import { getSafeHead, hasOptionalView, scanLogs } from "./chain.js";
import { depositIdAt } from "./settlement.js";
import { createStrayUsdtWatch, type StrayUsdtWatch } from "./strayUsdt.js";

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

/// The stray-USDT watch (strayUsdt.ts) wired to Xode, or null for a vending contract that
/// doesn't track `accountedUsdt`.
async function connectStrayUsdtWatch(settlement: SettlementClient, config: Config, vendingAddress: string): Promise<StrayUsdtWatch | null> {
  const { provider, vending } = settlement;
  if (!(await hasOptionalView(() => vending.accountedUsdt()))) return null;
  const usdtAddress: string = await vending.usdt();
  const token = new ethers.Contract(usdtAddress, ["function balanceOf(address) view returns (uint256)"], provider);
  const paddedVending = ethers.zeroPadValue(vendingAddress, 32).toLowerCase();
  const accounted = makeAccountedTransfers(provider, usdtAddress, vendingAddress);
  const tracksCancels = await hasOptionalView(() => vending.nativeCancelled(ethers.ZeroHash));
  return createStrayUsdtWatch({
    safeHead: () => getSafeHead(provider, config.xodeConfirmations),
    async deposits(from, to) {
      const logs: ethers.Log[] = [];
      await scanLogs({ provider, address: usdtAddress, topic: TRANSFER_TOPIC, chunkSize: config.logChunkSize }, from, to, async (chunk) => {
        logs.push(...chunk.filter((l) => l.topics[2]?.toLowerCase() === paddedVending));
        return null;
      }, () => {});
      // Numbered within their tx like the adapter does (depositIdAt), before leaving out the
      // transfers the contract accounted for itself.
      const seen = new Map<string, number>();
      const out: { depositId: string; amount: bigint }[] = [];
      for (const log of logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)) {
        const index = seen.get(log.transactionHash) ?? 0;
        seen.set(log.transactionHash, index + 1);
        if (await accounted.isAccounted(log.blockNumber, log.transactionHash, log.index)) continue;
        out.push({ depositId: depositIdAt(log.transactionHash, index), amount: ethers.toBigInt(log.data) });
      }
      return out;
    },
    async resolved(depositId, block) {
      if (await vending.settledDeposits(depositId, { blockTag: block })) return true;
      return tracksCancels && (await vending.nativeCancelled(depositId, { blockTag: block })) as boolean;
    },
    async balances(block) {
      const [balance, accountedUsdt]: [bigint, bigint] = await Promise.all([token.balanceOf(vendingAddress, { blockTag: block }), vending.accountedUsdt({ blockTag: block })]);
      return { balance, accounted: accountedUsdt };
    },
  });
}

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
  const strayWatch = await connectStrayUsdtWatch(settlement, config, vendingAddress);
  let strayWarning: string | null = null;
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

    // USDT that reached the vending contract without an ERC-20 Transfer (strayUsdt.ts). Its own
    // failure (an RPC hiccup) mustn't hide the balance warnings above.
    if (strayWatch) {
      try {
        const { stray, block, alert } = await strayWatch.check();
        strayWarning = stray > 0n
          ? `Vending contract ${vendingAddress} holds ${usdt(stray)} that arrived without an ERC-20 Transfer (as of block ${block}) - a Substrate assets.transfer or an XCM deposit. The relayer can't see who sent it, so it's neither paid out nor listed for a refund: find the sender on a block explorer and refund them from the owner Safe (npm run reconcile shows the totals).`
          : null;
        if (alert?.kind === "found" && strayWarning) alerts.send(strayWarning);
        if (alert?.kind === "cleared") alerts.send(`Vending contract ${vendingAddress} no longer holds unexplained USDT.`);
      } catch (err) {
        console.error("[monitor] Stray-USDT check failed:", describeError(err));
      }
      if (strayWarning) warnings.push(strayWarning);
    }
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
