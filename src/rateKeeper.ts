// Keeps XonVendingMachine's fixed `rate` close to the Xode DEX price. A fixed rate that drifts from
// the market is free money: buy XON from the vending contract, sell it on the DEX (or the reverse
// trade's equivalent loss on deposits). Every RATE_KEEPER_INTERVAL_MS this reads the pool's spot
// price and, when the rate is off by more than RATE_DEADBAND_BPS, moves it one step toward the
// market with `updateRate` - signed by the rate keeper key (never the owner's), and bounded on-chain
// by the contract's maxRateStepBps / minRateUpdateInterval, so a stolen keeper key can only move
// the price slowly. Without a keeper key it only alerts when the rate drifts past RATE_ALERT_BPS.
//
// Stepping slowly also means a sudden market move leaves the rate stale for a while. So past
// RATE_PAUSE_BPS the keeper also pauses the fixed-rate paths (`keeperPauseFixedRate`) - the
// market-price swap keeps working - and lifts its pause once the rate is back within half of that.
//
// The pool's spot price is a single reading anyone with capital can move for a block. Acting on it
// directly would let a trader push the pool, have the keeper step `rate` (or pause the fixed paths)
// after it, swap back, and buy at the rate they steered - every interval. So the keeper acts on the
// median of the last RATE_KEEPER_SAMPLES readings, each from a different block and one check apart:
// to steer it, the pool has to be held off-market for over half that window, against arbitrage.

import { ethers } from "ethers";
import type { Alerts } from "./alerts.js";
import type { Config } from "./config.js";
import { describeError } from "./errorClassifier.js";
import { sendAndConfirm, type Sender, type SettlementClient } from "./settlement.js";
import type { Shutdown } from "./shutdown.js";
import type { Telemetry } from "./telemetry.js";
import type { XodeDex } from "./xodeDex.js";
import VENDING_ABI from "./abi/XonVendingMachine.json" with { type: "json" };

/// The rate to set next, or null to leave it: nothing inside the deadband; otherwise one step
/// toward `target`, never past it and never more than `maxStepBps` of the current rate.
export function nextRate({ current, target, maxStepBps, deadbandBps }: { current: bigint; target: bigint; maxStepBps: bigint; deadbandBps: bigint }): bigint | null {
  if (current <= 0n || target <= 0n) return null;
  const gap = target > current ? target - current : current - target;
  if (gap * 10_000n <= target * deadbandBps) return null;
  const maxStep = (current * maxStepBps) / 10_000n;
  if (maxStep === 0n) return null;
  const next = target > current ? (gap > maxStep ? current + maxStep : target) : (gap > maxStep ? current - maxStep : target);
  return next === current ? null : next;
}

/// Whether the keeper's fixed-rate pause should be on: on past `pauseBps`, off again only once the
/// deviation is back within half of it (so it doesn't flap around the threshold).
export function wantFixedRatePause({ offBps, pausedNow, pauseBps }: { offBps: bigint; pausedNow: boolean; pauseBps: bigint }): boolean {
  if (pauseBps <= 0n) return false;
  if (offBps > pauseBps) return true;
  if (pausedNow && offBps > pauseBps / 2n) return true;
  return false;
}

/// Basis points between `rate` and `target`, relative to the target.
export const deviationBps = (rate: bigint, target: bigint): bigint => ((rate > target ? rate - target : target - rate) * 10_000n) / target;

/// The median of `values` (the lower middle one for an even count), or null for none.
export function median(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/// DEX price readings, one per block, keeping the newest `size`. `target()` is their median once
/// the window is full, and null until then - the keeper doesn't act on a partial window.
export function makePriceWindow(size: number) {
  const samples: { block: number; price: bigint }[] = [];
  return {
    add(block: number, price: bigint): void {
      // A second reading from the same block adds nothing independent - replace, don't count it.
      if (samples.length > 0 && samples[samples.length - 1].block === block) samples.pop();
      samples.push({ block, price });
      while (samples.length > size) samples.shift();
    },
    /// No pool right now: start over, rather than act on readings from before it went away.
    reset(): void {
      samples.length = 0;
    },
    target(): bigint | null {
      return samples.length < size ? null : median(samples.map((s) => s.price));
    },
    get size(): number {
      return samples.length;
    },
  };
}

export interface RateKeeperOptions {
  settlement: SettlementClient;
  /// RATE_KEEPER_PRIVATE_KEY (see loadRateKeeperKey), or null to only watch and alert.
  keeperKey: string | null;
  config: Config;
  dex: XodeDex;
  telemetry: Telemetry;
  alerts: Alerts;
  shutdown: Shutdown;
}

export async function runRateKeeper({ settlement, config, dex, telemetry, alerts, shutdown, keeperKey }: RateKeeperOptions): Promise<void> {
  const { provider } = settlement;
  const vendingAddress = await settlement.vending.getAddress();
  const owner: string = await settlement.vending.owner();

  // The keeper signs with its own key and nonce - never the relayer's NonceManager - and sends
  // through sendAndConfirm, so a dropped or underpriced tx is bumped or given up on instead of
  // waiting forever (a bare .wait() would silently freeze the keeper, pause and all).
  let keeper: ethers.Contract | null = null;
  let sender: Sender | null = null;
  if (keeperKey) {
    const wallet = new ethers.Wallet(keeperKey, provider);
    if (wallet.address.toLowerCase() === owner.toLowerCase() && !config.allowOwnerAsRelayer) {
      throw new Error(`The rate keeper key (${wallet.address}) is XonVendingMachine's owner - give the keeper its own key (setRateKeeper, owner key).`);
    }
    const appointed: string = await settlement.vending.rateKeeper();
    if (appointed.toLowerCase() !== wallet.address.toLowerCase()) {
      console.warn(`[rate] The rate keeper key (${wallet.address}) isn't XonVendingMachine's rateKeeper (${appointed}) - only watching the rate. Appoint it with setRateKeeper (owner key).`);
    } else {
      const signer = new ethers.NonceManager(wallet);
      keeper = new ethers.Contract(vendingAddress, VENDING_ABI, signer);
      sender = { provider, wallet, signer };
      console.log(`[rate] Keeping the fixed rate within ${Number(config.rateDeadbandBps) / 100}% of the DEX price as ${wallet.address}.`);
    }
  } else {
    console.log(`[rate] No RATE_KEEPER_PRIVATE_KEY - only alerting when the fixed rate is over ${Number(config.rateAlertBps) / 100}% off the DEX price.`);
  }

  const window = makePriceWindow(config.rateKeeperSamples);
  console.log(`[rate] Acting on the median of ${config.rateKeeperSamples} DEX price sample(s), one every ${config.rateKeeperIntervalMs / 1000}s from different blocks.`);
  let drifting = false;
  async function check(): Promise<void> {
    const [current, spot, head] = await Promise.all([settlement.vending.rate() as Promise<bigint>, dex.spotXonPerUsdt(), provider.getBlockNumber()]);
    // The raw spot price is still exported, so the metric shows what the pool is doing right now.
    telemetry.setRates(Number(ethers.formatEther(current)), spot === null ? null : Number(ethers.formatEther(spot)));
    if (spot === null) {
      window.reset();
      return;
    }
    window.add(head, spot);
    const target = window.target();
    if (target === null) return; // still filling the window

    const off = deviationBps(current, target);
    const describe = () => `fixed rate ${ethers.formatEther(current)} XON/USDT vs DEX ${ethers.formatEther(target)} (median of ${window.size}; ${Number(off) / 100}% off)`;
    if (off > config.rateAlertBps && !drifting) {
      alerts.send(`[rate] The vending contract's ${describe()} - buying at the fixed rate and selling on the DEX (or the reverse) is profitable until it's corrected.`);
      drifting = true;
    } else if (off <= config.rateAlertBps && drifting) {
      alerts.send(`[rate] Fixed rate back within ${Number(config.rateAlertBps) / 100}% of the DEX: ${describe()}.`);
      drifting = false;
    }
    if (!keeper || !sender) return;

    const pausedNow: boolean = await keeper.fixedRatePausedByKeeper();
    const pause = wantFixedRatePause({ offBps: off, pausedNow, pauseBps: config.ratePauseBps });
    if (pause !== pausedNow) {
      const receipt = await sendAndConfirm(sender, "rate", () => keeper!.keeperPauseFixedRate(pause));
      const message = pause
        ? `[rate] Paused the fixed-rate paths (buy / fixed-rate deposits): ${describe()}. Market-price swaps carry on.`
        : `[rate] Fixed-rate paths resumed: ${describe()}.`;
      alerts.send(`${message} (tx ${receipt?.hash})`);
    }

    const [maxStepBps, minInterval, last, block] = await Promise.all([
      keeper.maxRateStepBps() as Promise<bigint>, keeper.minRateUpdateInterval() as Promise<bigint>,
      keeper.lastRateUpdate() as Promise<bigint>, provider.getBlock("latest"),
    ]);
    if (!block || BigInt(block.timestamp) < last + minInterval) return;
    const next = nextRate({ current, target, maxStepBps, deadbandBps: config.rateDeadbandBps });
    if (next === null) return;
    const receipt = await sendAndConfirm(sender, "rate", () => keeper!.updateRate(next));
    console.log(`[rate] ${describe()} - rate set to ${ethers.formatEther(next)} (tx ${receipt?.hash}).`);
  }

  while (!shutdown.requested) {
    try {
      await check();
    } catch (err) {
      console.error("[rate] Check failed:", describeError(err));
    }
    await shutdown.sleep(config.rateKeeperIntervalMs);
  }
}
