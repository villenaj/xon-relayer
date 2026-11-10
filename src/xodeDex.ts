// Read-only view of Xode's DEX (pallet-asset-conversion) over Xode's Substrate RPC, for market-price
// payouts (`settleExternalSwap`). Two jobs:
//   - quoting: how much XON a USDT amount buys right now (the front-end API's swap quotes);
//   - diagnosing a failed swap. When the swap inside settleExternalSwap fails, Xode's XCM precompile
//     reverts with the same generic message whatever the cause, so the revert alone can't say
//     whether to refund the buyer or wait. This asks the chain instead: swaps paused by governance
//     (TxPause) or a pool that isn't approved yet (AssetWaiting) clear up by themselves, so the
//     deposit is retried; a pool that now gives less than the buyer's minimum never will, so the
//     deposit is skipped and goes to the refund list.
//
// Only reads chain state - nothing here signs.

import { ApiPromise, WsProvider } from "@polkadot/api";
import type { SettleErrorClassification } from "./errorClassifier.js";

/// `pallet_revive`'s NativeToEthRatio on Xode: Solidity sees 1 planck of XON as 1e6 wei.
export const NATIVE_TO_ETH_RATIO = 1_000_000n;

// How the DEX names the two assets (its pools are keyed by these XCM locations).
const XON = { parents: 1, interior: "Here" };
const USDT = { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: 1984 }] } };

export interface XodeDex {
  /// XON (18-decimal units, as Solidity sees it) the pool gives for `usdtAmount` raw USDT right
  /// now, after the pool fee - or null if there's no pool / no liquidity.
  quoteUsdtToXon(usdtAmount: bigint): Promise<bigint | null>;
  /// Whether governance has paused the swap call the XCM exchange stands in for.
  swapsPaused(): Promise<boolean>;
  /// Whether the XON/USDT pool may be traded: false while AssetWaiting still has it pending.
  poolActive(): Promise<boolean>;
  disconnect(): Promise<void>;
}

export async function connectXodeDex(url: string): Promise<XodeDex> {
  const api = await ApiPromise.create({ provider: new WsProvider(url), noInitWarn: true, throwOnConnect: true });
  const required = ["assetConversionApi"] as const;
  for (const name of required) {
    if (!api.call[name]) throw new Error(`Xode at ${url} doesn't expose the ${name} runtime API - is this a Xode node?`);
  }
  return {
    async quoteUsdtToXon(usdtAmount) {
      const quote = await api.call.assetConversionApi.quotePriceExactTokensForTokens(USDT, XON, usdtAmount, true);
      const planck = (quote as unknown as { isSome: boolean; unwrap(): { toBigInt(): bigint } });
      return planck.isSome ? planck.unwrap().toBigInt() * NATIVE_TO_ETH_RATIO : null;
    },
    async swapsPaused() {
      if (!api.query.txPause) return false;
      const paused = await api.query.txPause.pausedCalls(["AssetConversion", "swap_exact_tokens_for_tokens"]);
      return (paused as unknown as { isSome: boolean }).isSome;
    },
    async poolActive() {
      if (!api.query.assetWaiting) return true;
      // Pools are keyed with XON first (WithFirstAsset<TokenLocation>). No record means the pool
      // predates AssetWaiting, which treats it as Active.
      const details = await api.query.assetWaiting.poolDetailsById([XON, USDT]);
      const record = details as unknown as { isSome: boolean; unwrap(): { status: { isActive: boolean } } };
      return !record.isSome || record.unwrap().status.isActive;
    },
    disconnect: () => api.disconnect(),
  };
}

/// Why a market-price settle failed, for a failure the revert data couldn't name (the XCM
/// precompile's generic error). `dex` null means there's no Substrate RPC to ask, so all we can do
/// is retry.
export async function diagnoseSwapFailure(
  dex: XodeDex | null,
  usdtAmount: bigint,
  minXonOut: bigint,
): Promise<SettleErrorClassification & { detail: string }> {
  if (!dex) {
    return { kind: "transient", name: "SwapFailed", detail: "the swap failed, and without XODE_SUBSTRATE_RPC the relayer can't tell why - retrying" };
  }
  if (await dex.swapsPaused()) {
    return { kind: "transient", name: "SwapsPaused", detail: "DEX swaps are paused by governance (TxPause) - retrying until they're unpaused" };
  }
  if (!(await dex.poolActive())) {
    return { kind: "transient", name: "PoolNotActive", detail: "the XON/USDT pool is still waiting for governance approval (AssetWaiting) - retrying" };
  }
  const quote = await dex.quoteUsdtToXon(usdtAmount);
  if (quote === null) {
    return { kind: "transient", name: "NoPoolQuote", detail: "the DEX can't quote XON/USDT (no pool or no liquidity) - retrying" };
  }
  if (quote < minXonOut) {
    return { kind: "permanent", name: "MinimumNotMet", detail: `the pool now gives ${quote} for this deposit, below the buyer's minimum of ${minXonOut} - refund it` };
  }
  return { kind: "transient", name: "SwapFailed", detail: `the swap failed though the pool quotes ${quote} (minimum ${minXonOut}) - retrying` };
}
