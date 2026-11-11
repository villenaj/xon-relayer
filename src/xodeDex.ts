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
import { fallbackAccount, USDT_ASSET_ID } from "./xcmSwap.js";

/// `pallet_revive`'s NativeToEthRatio on Xode: Solidity sees 1 planck of XON as 1e6 wei.
export const NATIVE_TO_ETH_RATIO = 1_000_000n;

// How the DEX names the two assets (its pools are keyed by these XCM locations).
const XON = { parents: 1, interior: "Here" };
const USDT = { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: 1984 }] } };

export interface XodeDex {
  /// XON (18-decimal units, as Solidity sees it) the pool gives for `usdtAmount` raw USDT right
  /// now, after the pool fee - or null if there's no pool / no liquidity.
  quoteUsdtToXon(usdtAmount: bigint): Promise<bigint | null>;
  /// The pool's spot price as XON (18-decimal units) per 1 whole USDT - the vending contract's
  /// `rate` units - from its reserves, before fees and price impact. Null if there's no pool.
  spotXonPerUsdt(): Promise<bigint | null>;
  /// Whether governance has paused the swap call the XCM exchange stands in for.
  swapsPaused(): Promise<boolean>;
  /// Whether the XON/USDT pool may be traded: false while AssetWaiting still has it pending.
  poolActive(): Promise<boolean>;
  /// The AccountId32 pallet-revive credits for an EVM address on Xode: the Substrate account
  /// mapped to it (`map_account`), else its `0xEE`-padded fallback account. XON an EVM transfer
  /// pays to `address` lands in exactly this account.
  accountOf(address: string): Promise<string>;
  /// XON's existential deposit, in planck.
  existentialDeposit(): bigint;
  /// Runs `message` (a hex `VersionedXcm`) as if AssetHub had sent it, without committing anything.
  dryRunFromAssetHub(message: string): Promise<{ complete: boolean; error: string | null }>;
  /// Xode's latest finalized block number.
  finalizedHead(): Promise<number>;
  /// The last block at or before `timestampMs` (0 if none).
  blockAtOrBefore(timestampMs: number): Promise<number>;
  /// Looks through blocks `from`..`to` for the message with id `topic` and what it did for
  /// `beneficiaryAccount`; null if it isn't in those blocks. Stops at the first "swapped" or
  /// "returned"; a "lost" (provisional) is only returned if nothing better is in the range.
  findXcmSwapOutcome(topic: string, beneficiaryAccount: string, usdtAmount: bigint, from: number, to: number): Promise<XcmSwapOutcome | null>;
  disconnect(): Promise<void>;
}

/// What an XCM-route purchase did on Xode, from the events of the block that processed it.
export type XcmSwapOutcome = { blockNumber: number; blockHash: string; error: string | null } & (
  /// Swapped: the beneficiary was paid `xonPlanck`.
  | { kind: "swapped"; xonPlanck: bigint }
  /// The swap didn't happen (minimum not met, swaps paused, pool pending...): the beneficiary got
  /// the USDT instead, on Xode, less Xode's fee.
  | { kind: "returned"; usdtAmount: bigint }
  /// Neither reached the beneficiary. `trapped`: the message left this purchase's USDT in Xode's
  /// asset trap, to be claimed; otherwise a message with this id was processed but nothing of it
  /// can be accounted for. Provisional until no better match follows (see `outcomeInEvents`).
  | { kind: "lost"; trapped: boolean }
);

const ASSET_HUB = { parents: 1, interior: { X1: [{ Parachain: 1000 }] } };

interface EventRecordLike {
  phase?: { toString(): string };
  event: { section: string; method: string; data: { toJSON(): unknown } & ArrayLike<{ toString(): string; toHex?: () => string }> };
}

/// The outcome of the purchase message with id `topic` among one block's events, if it's there.
/// A message's events are the ones after the previous `messageQueue.Processed` in the same phase
/// (MessageQueue runs one message at a time and reports each when it's done).
///
/// The topic is public once the AssetHub tx is, so anyone could send another message with it.
/// A message only counts as this purchase's "swapped" or "returned" if the USDT it brought in adds
/// up to `usdtAmount`: Xode's fee plus what was swapped (pool deposit) or returned (issued to the
/// beneficiary). Those are final. Any other message with the topic gives "lost" - `trapped` if
/// Xode's fee plus USDT left in the asset trap add up to `usdtAmount` - which is only provisional:
/// someone else's message can produce it cheaply, so a "swapped"/"returned" later in the block
/// wins here, and the caller keeps looking in later blocks before believing it.
export function outcomeInEvents(records: readonly EventRecordLike[], topic: string, beneficiaryAccount: string, usdtAssetId: number, usdtAmount: bigint): { kind: "swapped"; xonPlanck: bigint; error: string | null } | { kind: "returned"; usdtAmount: bigint; error: string | null } | { kind: "lost"; trapped: boolean; error: string | null } | null {
  const wantedTopic = topic.toLowerCase();
  const wantedAccount = beneficiaryAccount.toLowerCase();
  const hexOf = (v: { toString(): string; toHex?: () => string }) => (v.toHex ? v.toHex() : v.toString()).toLowerCase();
  const phaseOf = (r: EventRecordLike) => r.phase?.toString() ?? "";
  const isUsdt = (v: { toString(): string }) => v.toString().replace(/,/g, "") === String(usdtAssetId);
  let start = 0;
  let lost: { kind: "lost"; trapped: boolean; error: string | null } | null = null;
  for (let i = 0; i < records.length; i++) {
    const { section, method, data } = records[i].event;
    if (section !== "messageQueue" || method !== "Processed") continue;
    const segmentStart = start;
    start = i + 1;
    if (hexOf(data[0]) !== wantedTopic) continue;

    const phase = phaseOf(records[i]);
    let minted = 0n;
    let returned = 0n;
    let usdtIn = 0n;
    let trappedUsdt = 0n;
    let error: string | null = null;
    for (const record of records.slice(segmentStart, i)) {
      if (phaseOf(record) !== phase) continue;
      const { event } = record;
      const d = event.data;
      if (event.section === "balances" && event.method === "Minted" && hexOf(d[0]) === wantedAccount) minted += BigInt(d[1].toString());
      if (event.section === "assets" && (event.method === "Issued" || event.method === "Deposited") && isUsdt(d[0])) {
        const amount = BigInt(d[2].toString());
        usdtIn += amount;
        if (event.method === "Issued" && hexOf(d[1]) === wantedAccount) returned += amount;
      }
      if (event.section === "polkadotXcm" && event.method === "AssetsTrapped") trappedUsdt += trappedUsdtIn(event.data.toJSON(), usdtAssetId);
      if (event.section === "polkadotXcm" && event.method === "ProcessXcmError" && hexOf(d[2]) === wantedTopic) error = d[1].toString();
    }
    if (usdtIn === usdtAmount && minted > 0n) return { kind: "swapped", xonPlanck: minted, error };
    if (usdtIn === usdtAmount && returned > 0n) return { kind: "returned", usdtAmount: returned, error };
    // This purchase with its USDT trapped, one whose assets can't be accounted for - or someone
    // else's message with the same topic. The last one seen is reported.
    lost = { kind: "lost", trapped: trappedUsdt > 0n && usdtIn + trappedUsdt === usdtAmount, error };
  }
  return lost;
}

/// The USDT (AssetHub's asset `usdtAssetId`, as Xode sees it) among the assets of an
/// `AssetsTrapped` event's JSON. Other assets, and anything unreadable, count as none.
function trappedUsdtIn(json: unknown, usdtAssetId: number): bigint {
  const index = (v: unknown) => String(v).replace(/,/g, "");
  const isUsdt = (id: unknown): boolean => {
    const loc = id as { parents?: unknown; interior?: Record<string, unknown> } | null;
    const junctions = loc?.interior?.x3 ?? loc?.interior?.X3;
    if (index(loc?.parents) !== "1" || !Array.isArray(junctions) || junctions.length !== 3) return false;
    const [para, pallet, asset] = junctions as Record<string, unknown>[];
    return index(para?.parachain ?? para?.Parachain) === "1000" &&
      index(pallet?.palletInstance ?? pallet?.PalletInstance) === "50" &&
      index(asset?.generalIndex ?? asset?.GeneralIndex) === String(usdtAssetId);
  };
  let total = 0n;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const asset = node as { id?: unknown; fun?: { fungible?: unknown; Fungible?: unknown } };
    const amount = asset.fun?.fungible ?? asset.fun?.Fungible;
    if (asset.id !== undefined && amount !== undefined) {
      try {
        if (isUsdt(asset.id)) total += BigInt(index(amount));
      } catch {
        // not a number: not counted
      }
      return;
    }
    Object.values(node).forEach(walk);
  };
  walk(json);
  return total;
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
    async spotXonPerUsdt() {
      const reserves = await api.call.assetConversionApi.getReserves(XON, USDT);
      const pair = reserves as unknown as { isSome: boolean; unwrap(): [{ toBigInt(): bigint }, { toBigInt(): bigint }] };
      if (!pair.isSome) return null;
      const [xonPlanck, usdtRaw] = pair.unwrap().map((r) => r.toBigInt());
      if (usdtRaw === 0n) return null;
      // XON planck -> 18 decimals (x NativeToEthRatio), per 1 USDT (1e6 raw units).
      return (xonPlanck * NATIVE_TO_ETH_RATIO * 1_000_000n) / usdtRaw;
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
    async accountOf(address) {
      const mapped = await api.query.revive.originalAccount(address);
      const original = mapped as unknown as { isSome: boolean; unwrap(): { toHex(): string } };
      return original.isSome ? original.unwrap().toHex() : fallbackAccount(address);
    },
    existentialDeposit: () => (api.consts.balances.existentialDeposit as unknown as { toBigInt(): bigint }).toBigInt(),
    async dryRunFromAssetHub(message) {
      if (!api.call.dryRunApi) throw new Error("Xode doesn't expose DryRunApi");
      const xcm = api.createType("XcmVersionedXcm", message);
      const result = await api.call.dryRunApi.dryRunXcm({ V5: ASSET_HUB }, xcm);
      const r = result as unknown as { isOk: boolean; asOk: { executionResult: { isComplete: boolean; toJSON(): unknown } }; asErr: { toString(): string } };
      if (!r.isOk) return { complete: false, error: `dry run refused: ${r.asErr.toString()}` };
      const outcome = r.asOk.executionResult;
      return { complete: outcome.isComplete, error: outcome.isComplete ? null : JSON.stringify(outcome.toJSON()) };
    },
    async finalizedHead() {
      const hash = await api.rpc.chain.getFinalizedHead();
      return (await api.rpc.chain.getHeader(hash)).number.toNumber();
    },
    async blockAtOrBefore(timestampMs) {
      const at = async (n: number) => {
        const hash = await api.rpc.chain.getBlockHash(n);
        // From the block body's `timestamp.set` inherent, not state: a pruned node keeps bodies
        // but not old state.
        const block = await api.rpc.chain.getBlock(hash);
        const set = block.block.extrinsics.find((x) => x.method.section === "timestamp" && x.method.method === "set");
        if (!set) throw new Error(`block ${n} has no timestamp.set`);
        return Number((set.method.args[0] as unknown as { toBigInt(): bigint }).toBigInt());
      };
      let lo = 0;
      let hi = (await api.rpc.chain.getHeader()).number.toNumber();
      if ((await at(hi)) <= timestampMs) return hi;
      // Invariant: block `lo` is at or before the time (block 0 counts as before anything), `hi` after.
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if ((await at(mid)) <= timestampMs) lo = mid;
        else hi = mid;
      }
      return lo;
    },
    async findXcmSwapOutcome(topic, beneficiaryAccount, usdtAmount, from, to) {
      let lost: XcmSwapOutcome | null = null;
      for (let n = from; n <= to; n++) {
        const hash = await api.rpc.chain.getBlockHash(n);
        const records = (await (await api.at(hash)).query.system.events()) as unknown as EventRecordLike[];
        const found = outcomeInEvents(records, topic, beneficiaryAccount, USDT_ASSET_ID, usdtAmount);
        if (!found) continue;
        const outcome = { ...found, blockNumber: n, blockHash: hash.toHex() };
        if (outcome.kind !== "lost") return outcome;
        lost = outcome;
      }
      return lost;
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
