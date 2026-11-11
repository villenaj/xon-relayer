// The API side of market-price purchases from AssetHub over XCM (see ../xcmSwap.ts for the
// message itself). Nothing here holds or moves funds: it builds the one call the buyer's wallet
// signs, checks it on both chains before handing it out, and reads back what happened on Xode.
//
//   prepare  - resolves the beneficiary's AccountId32 on Xode, builds the call, dry-runs the
//              message on Xode (refusing it if the swap wouldn't go through right now) and
//              simulates the call on AssetHub (refusing it if it would revert there)
//   outcome  - finds the message on Xode by its topic and reads what the beneficiary got
//   history  - remembers settled purchases for /api/deposits, since the relayer's ledger never
//              sees them

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { USDT_DECIMALS } from "../config.js";
import {
  accountToAddress,
  encodeXcmSwap,
  encodeXcmSwapOnXode,
  fallbackAccount,
  MAX_SWAP_WEIGHT,
  minXonToPlanck,
  newTopic,
  PLANCK_TO_WEI,
  XCM_PRECOMPILE,
  XCM_SWAP_FEE,
  XCM_SWAP_MIN_USDT,
  xcmPrecompile,
  type XcmSwapParams,
  type XcmWeight,
} from "../xcmSwap.js";
import type { XcmSwapOutcome, XodeDex } from "../xodeDex.js";
import { ApiError } from "./http.js";
import type { Network } from "./networks.js";

/// How long a "can Xode swap right now" answer is reused for quotes.
const READY_TTL_MS = 60_000;
/// How far before the AssetHub block the search on Xode starts (clock skew between the chains).
const SEARCH_MARGIN_MS = 120_000;
/// Most Xode blocks one status check reads; the next check carries on from there.
const BLOCKS_PER_CHECK = 50;
/// How many more Xode blocks are searched after a "lost" outcome before it's believed. Anyone can
/// send a message carrying a purchase's topic that looks lost; the purchase itself arrives within
/// a few blocks of the AssetHub transaction, and a "swapped"/"returned" found meanwhile wins.
const LOST_GRACE_BLOCKS = 25;
/// Purchases whose search state is kept in memory.
const MAX_TRACKED = 5_000;

export type XcmRoute = ReturnType<typeof makeXcmRoute>;

export interface XcmHistoryRecord {
  sourceTxHash: string;
  topic: string;
  beneficiary: string;
  usdtAmount: string;
  state: "settled" | "refunded" | "skipped";
  /// XON paid, in 18-decimal units (settled).
  xonAmount: string | null;
  /// USDT left with the beneficiary on Xode (refunded).
  returnedUsdt: string | null;
  xodeBlockHash: string;
  time: string;
}

/// Settled XCM purchases, kept in an append-only JSON Lines file.
export function makeXcmHistory(file: string) {
  let byTx: Map<string, XcmHistoryRecord> | null = null;
  function load(): Map<string, XcmHistoryRecord> {
    if (byTx) return byTx;
    byTx = new Map();
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as XcmHistoryRecord;
          byTx.set(record.sourceTxHash.toLowerCase(), record);
        } catch {
          console.warn(`[api] Ignoring a malformed line in ${file}.`);
        }
      }
    }
    return byTx;
  }
  return {
    record(record: XcmHistoryRecord): void {
      const known = load();
      const key = record.sourceTxHash.toLowerCase();
      if (known.has(key)) return;
      known.set(key, record);
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        appendFileSync(file, JSON.stringify(record) + "\n");
      } catch (err) {
        // History is a convenience; the purchase itself is on-chain either way.
        console.error(`[api] Couldn't write ${file}:`, err instanceof Error ? err.message : err);
      }
    },
    forBeneficiary(beneficiary: string): XcmHistoryRecord[] {
      const wanted = beneficiary.toLowerCase();
      return [...load().values()].filter((r) => r.beneficiary.toLowerCase() === wanted).reverse();
    },
  };
}

const usdtText = (raw: bigint) => `${ethers.formatUnits(raw, USDT_DECIMALS)} USDT`;

/// `dex` null: no Substrate RPC to Xode, so the route can't be offered (it needs Xode for the
/// beneficiary's account, the dry run and the outcome).
export function makeXcmRoute(dex: XodeDex | null, history: ReturnType<typeof makeXcmHistory>) {
  let readiness: { at: number; ready: Promise<boolean> } | null = null;
  const tracked = new Map<string, { next: number | null; outcome: XcmSwapOutcome | null; lost: XcmSwapOutcome | null; busy: Promise<XcmSwapOutcome | null> | null }>();

  function requireDex(): XodeDex {
    if (!dex) throw new ApiError(503, "SwapQuotesUnavailable", "This API has no Substrate connection to Xode (XODE_SUBSTRATE_RPC), which market-price purchases from AssetHub need.");
    return dex;
  }

  /// The XON (18 decimals) the DEX gives right now for `amount` once Xode has taken its fee.
  async function quote(amount: bigint): Promise<bigint | null> {
    if (!dex || amount <= XCM_SWAP_FEE) return null;
    return dex.quoteUsdtToXon(amount - XCM_SWAP_FEE);
  }

  /// Whether Xode can swap an arriving purchase at all right now: a 1 USDT purchase accepting any
  /// amount, dry-run as AssetHub would send it. False before Xode's runtime has the XCM exchanger,
  /// while swaps are paused or the pool is pending - so no quote is offered that can't be met.
  function ready(paraId: number): Promise<boolean> {
    if (!dex) return Promise.resolve(false);
    if (readiness && Date.now() - readiness.at < READY_TTL_MS) return readiness.ready;
    const probe = encodeXcmSwapOnXode({
      usdtAmount: 1_000_000n,
      minXonPlanck: 1n,
      beneficiaryAccount: fallbackAccount("0x000000000000000000000000000000000000dEaD"),
      topic: ethers.ZeroHash,
      paraId,
    });
    const answer = dex.dryRunFromAssetHub(probe).then((r) => r.complete, (err: unknown) => {
      console.error("[api] XCM swap readiness check failed:", err instanceof Error ? err.message : err);
      readiness = null; // ask again next time rather than caching a connection blip
      return false;
    });
    readiness = { at: Date.now(), ready: answer };
    return answer;
  }

  /// Limits that keep a failed swap's leftover with the buyer (see XCM_SWAP_MIN_USDT) and a paid
  /// one above XON's existential deposit.
  function checkLimits(amount: bigint, minXonOut: bigint): void {
    if (amount < XCM_SWAP_MIN_USDT) {
      throw new ApiError(422, "BelowMinimumDeposit", `Market-price purchases from AssetHub are at least ${usdtText(XCM_SWAP_MIN_USDT)}.`);
    }
    const ed = requireDex().existentialDeposit();
    if (minXonToPlanck(minXonOut) < ed) {
      throw new ApiError(422, "MinimumTooSmall", `minXonOut must be at least ${ethers.formatEther(ed * PLANCK_TO_WEI)} XON (XON's existential deposit) - less can't be paid to an empty account.`);
    }
  }

  function warnings(minXonOut: bigint, quoted: bigint | null): string[] {
    if (quoted !== null && quoted < minXonOut) {
      return [`The DEX currently gives less XON than this minimum - unless the price moves back, the swap will fail and the USDT, less Xode's ${usdtText(XCM_SWAP_FEE)} fee, is left with the beneficiary on Xode instead.`];
    }
    return [];
  }

  /// Why Xode would refuse this purchase right now, for the error message.
  async function whyNot(amount: bigint, minXonOut: bigint): Promise<string> {
    const d = requireDex();
    if (await d.swapsPaused()) return "DEX swaps are paused on Xode right now";
    if (!(await d.poolActive())) return "the XON/USDT pool on Xode isn't approved for trading yet";
    const quoted = await quote(amount);
    if (quoted === null) return "Xode can't swap XCM purchases right now (no pool liquidity, or its runtime doesn't support it yet)";
    if (quoted < minXonOut) return `the DEX would give ${ethers.formatEther(quoted)} XON, below the minimum of ${ethers.formatEther(minXonOut)}`;
    return "Xode can't swap XCM purchases right now";
  }

  return {
    quote,
    ready,
    checkLimits,
    warnings,

    /// The call for the buyer's wallet, checked on both chains first.
    async prepare(net: Network, from: string, beneficiary: string, amount: bigint, minXonOut: bigint): Promise<{ params: XcmSwapParams; weight: XcmWeight }> {
      const d = requireDex();
      if (!net.xcmSwap) throw new Error(`${net.name} has no XCM route`);
      checkLimits(amount, minXonOut);
      const params: XcmSwapParams = {
        usdtAmount: amount,
        minXonPlanck: minXonToPlanck(minXonOut),
        beneficiaryAccount: await d.accountOf(beneficiary),
        topic: newTopic(),
        paraId: net.xcmSwap.paraId,
      };
      // What pallet-revive will pay is exactly what an EVM transfer to `beneficiary` would reach.
      if (accountToAddress(params.beneficiaryAccount) !== ethers.getAddress(beneficiary)) {
        throw new Error(`Xode mapped ${beneficiary} to ${params.beneficiaryAccount}, which isn't that address's account`);
      }

      // On Xode: the swap must go through right now, or the buyer is told why instead of signing.
      const onXode = await d.dryRunFromAssetHub(encodeXcmSwapOnXode(params));
      if (!onXode.complete) {
        throw new ApiError(422, "SwapUnavailable", `This purchase wouldn't be swapped on Xode right now: ${await whyNot(amount, minXonOut)}.`);
      }

      // On AssetHub: weigh the program, and make sure the call itself wouldn't revert (USDT, or the
      // DOT for the delivery fee, missing).
      const message = encodeXcmSwap(params);
      const [refTime, proofSize] = (await net.provider.call({ to: XCM_PRECOMPILE, data: xcmPrecompile.encodeFunctionData("weighMessage", [message]) })
        .then((r) => xcmPrecompile.decodeFunctionResult("weighMessage", r)[0])) as [bigint, bigint];
      const weight = { refTime, proofSize };
      if (refTime > MAX_SWAP_WEIGHT.refTime || proofSize > MAX_SWAP_WEIGHT.proofSize) {
        throw new Error(`AssetHub weighs the swap at ${refTime}/${proofSize}, over the ${MAX_SWAP_WEIGHT.refTime}/${MAX_SWAP_WEIGHT.proofSize} a prepared call may ask for`);
      }
      try {
        await net.provider.estimateGas({ from, to: XCM_PRECOMPILE, data: xcmPrecompile.encodeFunctionData("execute", [message, [refTime, proofSize]]) });
      } catch (err) {
        const reason = (err as { shortMessage?: string }).shortMessage ?? (err instanceof Error ? err.message : String(err));
        throw new ApiError(422, "SwapRejected", `AssetHub would reject this purchase (${reason}). It needs the USDT plus some ${net.nativeSymbol} in ${from} for the fee to deliver it to Xode (about 0.031 ${net.nativeSymbol}).`);
      }
      return { params, weight };
    },

    /// What the purchase in `txHash` did on Xode, looking from `sinceMs` (its AssetHub block's time).
    /// Null while it hasn't been processed yet (as far as Xode's finalized blocks show).
    async outcome(txHash: string, params: XcmSwapParams, sinceMs: number): Promise<XcmSwapOutcome | null> {
      const d = requireDex();
      // By tx, not topic: the topic is public, and another tx could carry it too.
      const key = txHash.toLowerCase();
      let entry = tracked.get(key);
      if (!entry) {
        if (tracked.size >= MAX_TRACKED) tracked.delete(tracked.keys().next().value!);
        entry = { next: null, outcome: null, lost: null, busy: null };
        tracked.set(key, entry);
      }
      if (entry.outcome) return entry.outcome;
      if (entry.busy) return entry.busy; // a stream and a poll asking at once share one search
      const current = entry;
      current.busy = (async () => {
        const from = current.next ?? (await d.blockAtOrBefore(sinceMs - SEARCH_MARGIN_MS));
        current.next = from; // the start is searched for once
        const finalized = await d.finalizedHead();
        if (from > finalized) return null;
        const to = Math.min(finalized, from + BLOCKS_PER_CHECK - 1);
        let found = await d.findXcmSwapOutcome(params.topic, params.beneficiaryAccount, params.usdtAmount, from, to);
        current.next = to + 1;
        if (found?.kind === "lost") {
          // Provisional: remembered, and only reported once the blocks after it show nothing better.
          current.lost = found;
          found = null;
        }
        if (!found && current.lost && to >= current.lost.blockNumber + LOST_GRACE_BLOCKS) found = current.lost;
        if (found) {
          current.outcome = found;
          const beneficiary = accountToAddress(params.beneficiaryAccount);
          history.record({
            sourceTxHash: txHash,
            topic: params.topic,
            beneficiary,
            usdtAmount: params.usdtAmount.toString(),
            state: found.kind === "swapped" ? "settled" : found.kind === "returned" ? "refunded" : "skipped",
            xonAmount: found.kind === "swapped" ? (found.xonPlanck * PLANCK_TO_WEI).toString() : null,
            returnedUsdt: found.kind === "returned" ? found.usdtAmount.toString() : null,
            xodeBlockHash: found.blockHash,
            time: new Date().toISOString(),
          });
        }
        return found;
      })().finally(() => {
        current.busy = null;
      });
      return current.busy;
    },

    history,
  };
}

