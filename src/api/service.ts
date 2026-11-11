// What the front-end API reads from the chains and the relayer's ledger. Read-only: nothing here
// signs. Every deposit status comes from the chain first (the deposit tx's own logs, the vending
// contract's settled flags); the ledger only adds what the chain can't say - held/skipped/refunded,
// and which Xode tx paid it.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { ethers, type Log, type TransactionReceipt } from "ethers";
import { getSafeHead } from "../chain.js";
import { USDT_DECIMALS, type Config } from "../config.js";
import { type LedgerRecord, type LedgerStatus } from "../ledger.js";
import { depositIdAt, externalDepositId } from "../settlement.js";
import { GATEWAY_DEPOSIT_TOPICS, TRANSFER_TOPIC } from "../tools/common.js";
import type { XodeDex } from "../xodeDex.js";
import { ApiError } from "./http.js";
import type { Network, NetworkName, Networks } from "./networks.js";
import { approveSteps, depositStep, parseAddress, parseSlippageBps, parseUsdt, parseXon, purchaseSteps, swapInCall, swapStep, type TxStep } from "./transactions.js";
import { accountToAddress, PLANCK_TO_WEI, XCM_PRECOMPILE, XCM_SWAP_FEE, XCM_SWAP_MIN_USDT } from "../xcmSwap.js";
import { makeXcmHistory, makeXcmRoute } from "./xcmRoute.js";

export const SETTLED_TOPIC = ethers.id("Settled(address,bytes32,uint256,uint256)");
export const EXTERNAL_SETTLED_TOPIC = ethers.id("ExternalSettled(address,string,bytes32,uint256,uint256)");
export const EXTERNAL_SWAP_SETTLED_TOPIC = ethers.id("ExternalSwapSettled(address,string,bytes32,uint256,uint256)");
/// Slippage tolerance for market-price quotes when the caller doesn't give `slippageBps` (100 = 1%).
export const DEFAULT_SLIPPAGE_BPS = 100n;
const XON_DECIMALS = 18;

export interface Amount {
  raw: bigint;
  formatted: string;
}

export const usdtAmount = (raw: bigint): Amount => ({ raw, formatted: ethers.formatUnits(raw, USDT_DECIMALS) });
export const nativeAmount = (raw: bigint): Amount => ({ raw, formatted: ethers.formatEther(raw) });

export type DepositState =
  | "awaiting-confirmations" // deposit tx mined, but not yet past its chain's confirmation threshold
  | "settling" // confirmed; waiting for the relayer to pay it
  | "settled" // XON paid
  | "held" // over a payout cap - waits for an operator to review and release it
  | "skipped" // can never be paid (e.g. rounds to 0 XON) - the USDT is owed back as a refund
  | "refunded"; // a skipped deposit's USDT was returned

export const FINAL_DEPOSIT_STATES: ReadonlySet<DepositState> = new Set(["settled", "skipped", "refunded"]);

export interface DepositInfo {
  index: number;
  depositId: string;
  beneficiary: string;
  usdtAmount: Amount;
  state: DepositState;
  settleTxHash: string | null;
  xonAmount: Amount | null;
  error: string | null;
}

export interface TxStatus {
  network: NetworkName;
  txHash: string;
  state: "pending" | "not-found" | "failed" | "mined";
  blockNumber: number | null;
  confirmed: boolean;
  confirmations: number;
  receipt: ReturnType<typeof receiptJson> | null;
  deposits: DepositInfo[];
}

export function receiptJson(receipt: TransactionReceipt) {
  return {
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    from: receipt.from,
    to: receipt.to,
    contractAddress: receipt.contractAddress,
    status: receipt.status,
    gasUsed: receipt.gasUsed,
    gasPrice: receipt.gasPrice,
    logs: receipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data, index: log.index })),
  };
}

/// The purchase deposits in a deposit tx's logs, in the order the relayer numbers them (log
/// order - see depositScanner.ts): USDT transfers into the vending contract on Xode, gateway
/// `Deposited` / `SwapDeposited` events elsewhere.
export function depositsInLogs(network: Pick<Network, "name" | "usdtAddress" | "payTo" | "gateway">, txHash: string, logs: readonly Log[]) {
  const ordered = [...logs].sort((a, b) => a.index - b.index);
  const payTo = network.payTo.toLowerCase();
  const found: { beneficiary: string; usdtAmount: bigint }[] = [];
  for (const log of ordered) {
    if (!network.gateway) {
      if (log.address.toLowerCase() !== network.usdtAddress.toLowerCase() || log.topics[0] !== TRANSFER_TOPIC) continue;
      if (ethers.getAddress(ethers.dataSlice(log.topics[2], 12)).toLowerCase() !== payTo) continue;
      found.push({ beneficiary: ethers.getAddress(ethers.dataSlice(log.topics[1], 12)), usdtAmount: ethers.toBigInt(log.data) });
    } else {
      if (log.address.toLowerCase() !== payTo || !GATEWAY_DEPOSIT_TOPICS.includes(log.topics[0])) continue;
      const parsed = network.gateway.interface.parseLog(log);
      if (parsed) found.push({ beneficiary: parsed.args.xodeBeneficiary, usdtAmount: parsed.args.usdtAmount });
    }
  }
  const baseId = network.gateway ? externalDepositId(network.name, txHash) : txHash;
  return found.map((d, index) => ({ ...d, index, depositId: depositIdAt(baseId, index) }));
}

/// The ledger, read incrementally: only the bytes appended since the last look. The file is
/// append-only (and can be large - it's never rotated by the relayer), so re-reading all of it
/// whenever it changed blocked the event loop on every request while a deposit was being retried.
/// It's read from the start again if it shrank or was replaced (logrotate). Missing (the API runs on
/// another host than the relayer) just means no ledger detail.
export function makeLedgerView(file: string) {
  let identity = ""; // dev:ino - a replaced file starts over
  let offset = 0;
  let partial = ""; // a line not yet terminated (being written right now)
  let byDepositId = new Map<string, LedgerRecord>();

  function apply(record: LedgerRecord): void {
    // Later lines win: the last word on a deposit is its current state. A "failed" retry after
    // it was held doesn't un-hold it, so only let "failed" through when there's nothing else.
    const key = record.depositId.toLowerCase();
    const previous = byDepositId.get(key);
    if (record.status === "failed" && previous && previous.status !== "failed") return;
    byDepositId.set(key, record);
  }

  function refresh(): void {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      identity = "";
      offset = 0;
      partial = "";
      byDepositId = new Map();
      return;
    }
    const current = `${stat.dev}:${stat.ino}`;
    if (current !== identity || stat.size < offset) {
      identity = current;
      offset = 0;
      partial = "";
      byDepositId = new Map();
    }
    if (stat.size === offset) return;

    const fd = openSync(file, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(stat.size - offset);
      const read = readSync(fd, buffer, 0, buffer.length, offset);
      offset += read;
      text = partial + buffer.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
    const lines = text.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        apply(JSON.parse(line) as LedgerRecord);
      } catch {
        console.warn(`[api] Ignoring a malformed line in ${file}.`);
      }
    }
  }

  return {
    get(depositId: string): LedgerRecord | undefined {
      refresh();
      return byDepositId.get(depositId.toLowerCase());
    },
    /// The latest record for every deposit paying out to `beneficiary`, newest first.
    forBeneficiary(beneficiary: string): LedgerRecord[] {
      refresh();
      const wanted = beneficiary.toLowerCase();
      return [...byDepositId.values()].filter((r) => r.buyer.toLowerCase() === wanted).reverse();
    },
  };
}

const LEDGER_STATES: Partial<Record<LedgerStatus, DepositState>> = {
  settled: "settled",
  "already-settled": "settled",
  held: "held",
  skipped: "skipped",
  refunded: "refunded",
};

export type ApiService = ReturnType<typeof makeApiService>;

/// `dex` (Xode's DEX over Substrate RPC) enables market-price quotes; without it, only explicit
/// `minXonOut` market-price purchases can be prepared.
export function makeApiService(config: Config, networks: Networks, dex: XodeDex | null = null) {
  const { xode, vending } = networks;
  const ledger = makeLedgerView(config.ledgerFile);
  // Market-price purchases from AssetHub over XCM (net.xcmSwap set) - see xcmRoute.ts.
  const xcm = makeXcmRoute(dex, makeXcmHistory(config.xcmPurchasesFile));

  function network(name: string): Network {
    const found = networks.byName.get(name as NetworkName);
    if (!found) throw new ApiError(404, "UnknownNetwork", `Unknown or unconfigured network "${name}" - one of: ${[...networks.byName.keys()].join(", ")}.`);
    return found;
  }

  async function nativeLimits(): Promise<{ maxPerPurchase: bigint; maxPerDay: bigint; available: bigint } | null> {
    try {
      const [maxPerPurchase, maxPerDay, available]: bigint[] = await Promise.all([vending.maxNativePerPurchase(), vending.maxNativePerDay(), vending.nativeAvailable()]);
      return { maxPerPurchase, maxPerDay, available };
    } catch {
      return null;
    }
  }

  async function externalLimits(): Promise<{ maxPerDeposit: bigint; maxPerDay: bigint; available: bigint } | null> {
    try {
      const [maxPerDeposit, maxPerDay, available]: bigint[] = await Promise.all([vending.maxExternalPerDeposit(), vending.maxExternalPerDay(), vending.externalAvailable()]);
      return { maxPerDeposit, maxPerDay, available };
    } catch {
      return null;
    }
  }

  /// Things the buyer should know before paying: whether the payout will be instant, delayed or
  /// held for review. Refuses outright only when the deposit could never be paid at all.
  /// The gateway's minimum deposit and refund fee (both 0 on gateways that predate them).
  async function gatewayRules(net: Network): Promise<{ minDeposit: bigint; refundFee: bigint }> {
    if (!net.gateway) return { minDeposit: 0n, refundFee: 0n };
    try {
      const [minDeposit, refundFee]: bigint[] = await Promise.all([net.gateway.minDeposit(), net.gateway.refundFee()]);
      return { minDeposit, refundFee };
    } catch {
      return { minDeposit: 0n, refundFee: 0n };
    }
  }

  /// A deposit under the gateway's minimum would just revert - refuse it up front.
  async function requireMinDeposit(net: Network, amount: bigint): Promise<{ minDeposit: bigint; refundFee: bigint }> {
    const rules = await gatewayRules(net);
    if (amount < rules.minDeposit) {
      throw new ApiError(422, "BelowMinimumDeposit", `The ${net.name} gateway takes deposits of at least ${ethers.formatUnits(rules.minDeposit, USDT_DECIMALS)} USDT.`);
    }
    return rules;
  }

  /// The beneficiary's own daily limit (shared by every path); null when there's none.
  async function addressWarning(beneficiary: string | undefined, amount: bigint): Promise<string | null> {
    if (!beneficiary) return null;
    try {
      const available: bigint = await vending.addressAvailable(beneficiary);
      if (amount > available) return `This is over what ${beneficiary} can still receive today (${ethers.formatUnits(available, USDT_DECIMALS)} USDT's worth) - the deposit would wait and be paid automatically as that limit refills (up to a day).`;
    } catch {
      // A vending contract without per-address limits.
    }
    return null;
  }

  async function purchaseChecks(net: Network, amount: bigint): Promise<{ xon: bigint; warnings: string[] }> {
    const [xon, reserve, limits]: [bigint, bigint, Awaited<ReturnType<typeof externalLimits>>] = await Promise.all([
      vending.quote(amount),
      xode.provider.getBalance(xode.payTo),
      net.gateway ? externalLimits() : Promise.resolve(null),
    ]);
    if (xon === 0n) throw new ApiError(422, "AmountTooSmall", "That amount rounds down to 0 XON - it would never be paid out. Send more USDT.");
    await requireMinDeposit(net, amount);
    const warnings: string[] = [];
    let fixedPaused = false;
    try {
      fixedPaused = await vending.fixedRatePaused();
    } catch {
      // A vending contract without the fixed-rate pause.
    }
    if (fixedPaused) {
      warnings.push(`Fixed-rate payouts are paused right now (the fixed rate is too far from the DEX price) - this would wait and be paid automatically once they resume.${net.gateway ? " Pay at market price instead (slippageBps / minXonOut)." : ""}`);
    }
    if (reserve < xon) warnings.push("The vending contract's XON reserve is currently below this payout - it will be paid once the reserve is topped up.");
    warnings.push(...await limitWarnings(net, amount, limits));
    return { xon, warnings };
  }

  /// Whether the external payout limits will delay or hold a deposit of `amount`.
  async function limitWarnings(net: Network, amount: bigint, known?: Awaited<ReturnType<typeof externalLimits>>): Promise<string[]> {
    const warnings: string[] = [];
    if (net.gateway) {
      const limits = known === undefined ? await externalLimits() : known;
      const relayerCap = config.payoutLimits.maxPerDeposit;
      if (limits && (limits.maxPerDeposit === 0n || limits.maxPerDay === 0n)) {
        warnings.push(`Payouts for ${net.name} deposits are currently switched off - the deposit will be held until an operator enables them.`);
      } else if ((relayerCap !== null && amount > relayerCap) || (limits && amount > limits.maxPerDeposit)) {
        warnings.push("This amount is over the automatic payout limit - the deposit will be held for manual review before XON is paid.");
      } else if (limits && amount > limits.available) {
        warnings.push("Today's payout allowance is nearly used up - XON for this deposit may be delayed until it refills.");
      }
    } else {
      // Xode-native purchases have their own limits (contracts that predate them don't).
      const native = await nativeLimits();
      if (native && (native.maxPerPurchase === 0n || native.maxPerDay === 0n)) {
        warnings.push("Purchases on Xode are currently switched off - a transfer would be held until an operator enables them.");
      } else if (native && amount > native.maxPerPurchase) {
        warnings.push(`This is over the ${ethers.formatUnits(native.maxPerPurchase, USDT_DECIMALS)} USDT per-purchase limit on Xode - the transfer would be held for manual review before XON is paid.`);
      } else if (native && amount > native.available) {
        warnings.push("Today's Xode purchase allowance is nearly used up - XON for this transfer may be delayed until it refills.");
      }
    }
    return warnings;
  }

  /// How a gateway purchase is paid, from the request: at market price if it names `minXonOut`
  /// (an XON amount) or `slippageBps` (minimum = a fresh DEX quote less that much), else at the
  /// vending contract's fixed rate.
  async function payoutTerms(net: Network, amount: bigint, input: { minXonOut?: unknown; slippageBps?: unknown }): Promise<{ minXonOut: bigint; quote: bigint | null } | null> {
    if (input.minXonOut === undefined && input.slippageBps === undefined) return null;
    if (!net.gateway) throw new ApiError(400, "SwapNotSupported", "Market-price purchases are for AssetHub/Ethereum deposits - on Xode, swap on the DEX directly.");
    // Over XCM, Xode takes its fee from the USDT before the swap, so quote what's left.
    const quote = net.xcmSwap ? await xcm.quote(amount) : dex ? await dex.quoteUsdtToXon(amount) : null;
    if (input.minXonOut !== undefined) return { minXonOut: parseXon(input.minXonOut, "minXonOut"), quote };
    const bps = parseSlippageBps(input.slippageBps);
    if (!dex) throw new ApiError(503, "SwapQuotesUnavailable", "This API can't quote the DEX (no XODE_SUBSTRATE_RPC) - pass minXonOut instead of slippageBps.");
    if (quote === null) throw new ApiError(422, "NoPoolLiquidity", "The Xode DEX can't quote XON for USDT right now.");
    return { minXonOut: (quote * (10_000n - bps)) / 10_000n, quote };
  }

  /// Warnings for a market-price purchase, like purchaseChecks' for a fixed-rate one.
  async function swapChecks(net: Network, amount: bigint, minXonOut: bigint, quote: bigint | null): Promise<string[]> {
    let inventory: bigint;
    try {
      inventory = await vending.accountedUsdt();
    } catch {
      throw new ApiError(422, "SwapNotSupported", "The vending contract predates market-price payouts - use a fixed-rate purchase (leave out minXonOut / slippageBps).");
    }
    const { refundFee } = await requireMinDeposit(net, amount);
    const warnings = await limitWarnings(net, amount);
    const fee = refundFee > 0n ? `, less a ${ethers.formatUnits(refundFee < amount ? refundFee : amount, USDT_DECIMALS)} USDT refund fee` : "";
    if (quote !== null && quote < minXonOut) warnings.push(`The DEX currently gives less XON than this minimum - unless the price moves back, the deposit will be refunded${fee} rather than paid.`);
    if (inventory < amount) warnings.push("The vending contract's USDT inventory for market-price payouts is below this amount - XON will be paid once it's topped up.");
    return warnings;
  }

  /// The least XON a fixed-rate gateway deposit accepts: what the rate gives now, less the
  /// tolerance. The payout is worked out when the deposit settles, minutes later; if the rate has
  /// dropped by more than that meanwhile, the deposit is refunded instead of paid less.
  function fixedMinimum(xon: bigint): bigint {
    const min = (xon * BigInt(10_000 - config.fixedRateToleranceBps)) / 10_000n;
    return min > 0n ? min : 1n;
  }

  /// What a prepared purchase will pay: `payout` "rate" (fixed) or "swap" (market price, with the
  /// minimum and the DEX's current quote), and warnings for either.
  async function payoutSummary(net: Network, amount: bigint, terms: Awaited<ReturnType<typeof payoutTerms>>, beneficiary?: string) {
    if (terms && net.xcmSwap) {
      // Over XCM nothing goes through the vending contract, so none of its limits apply.
      xcm.checkLimits(amount, terms.minXonOut);
      return {
        payout: "swap",
        route: "xcm",
        xonAmount: terms.quote === null ? null : nativeAmount(terms.quote),
        minXonOut: nativeAmount(terms.minXonOut),
        // Kept by Xode if the minimum can't be met; the rest stays with the beneficiary on Xode.
        refundFee: usdtAmount(XCM_SWAP_FEE),
        warnings: xcm.warnings(terms.minXonOut, terms.quote),
      };
    }
    const perAddress = await addressWarning(beneficiary, amount);
    if (!terms) {
      const { xon, warnings } = await purchaseChecks(net, amount);
      return {
        payout: "rate",
        xonAmount: nativeAmount(xon),
        // Gateway deposits carry the buyer's minimum: paid at least this, or refunded.
        ...(net.gateway ? { minXonOut: nativeAmount(fixedMinimum(xon)), rateToleranceBps: config.fixedRateToleranceBps } : {}),
        warnings: perAddress ? [...warnings, perAddress] : warnings,
      };
    }
    const warnings = await swapChecks(net, amount, terms.minXonOut, terms.quote);
    const { refundFee } = await gatewayRules(net);
    return {
      payout: "swap",
      xonAmount: terms.quote === null ? null : nativeAmount(terms.quote),
      minXonOut: nativeAmount(terms.minXonOut),
      // Kept from a refund only if the minimum can't be met (raw USDT units).
      refundFee: usdtAmount(refundFee),
      warnings: perAddress ? [...warnings, perAddress] : warnings,
    };
  }

  async function requireUsdtBalance(net: Network, from: string, amount: bigint): Promise<void> {
    const balance: bigint = await net.usdt.balanceOf(from);
    if (balance < amount) {
      throw new ApiError(422, "InsufficientUsdt", `${from} has ${ethers.formatUnits(balance, USDT_DECIMALS)} USDT on ${net.name}, less than the ${ethers.formatUnits(amount, USDT_DECIMALS)} needed.`);
    }
  }

  async function allowanceOf(net: Network, owner: string): Promise<bigint> {
    return net.gateway ? net.usdt.allowance(owner, net.payTo) : 0n;
  }

  function prepared(net: Network, from: string, amount: bigint, steps: TxStep[], extra: object = {}) {
    return { network: net.name, chainId: net.chainId, from, usdtAmount: usdtAmount(amount), ...extra, steps };
  }

  /// The purchase in a mined XCM precompile call: the one deposit it makes, and what Xode did with
  /// it. A precompile call that isn't the purchase program (someone else's XCM) has none.
  async function xcmDeposits(net: Network, receipt: TransactionReceipt, confirmed: boolean): Promise<DepositInfo[]> {
    const tx = await net.provider.getTransaction(receipt.hash);
    const swap = tx ? swapInCall(tx.data) : null;
    if (!swap || swap.params.paraId !== net.xcmSwap?.paraId) return [];
    const { params } = swap;
    const beneficiary = accountToAddress(params.beneficiaryAccount);
    const base = { index: 0, depositId: params.topic, beneficiary, usdtAmount: usdtAmount(params.usdtAmount), settleTxHash: null, xonAmount: null, error: null };
    if (!confirmed) return [{ ...base, state: "awaiting-confirmations" }];
    const block = await net.provider.getBlock(receipt.blockNumber);
    if (!block) return [{ ...base, state: "settling" }];
    const outcome = await xcm.outcome(receipt.hash, params, block.timestamp * 1000);
    if (!outcome) return [{ ...base, state: "settling" }];
    const failure = outcome.error ? ` (${outcome.error})` : "";
    switch (outcome.kind) {
      case "swapped":
        return [{ ...base, state: "settled", xonAmount: nativeAmount(outcome.xonPlanck * PLANCK_TO_WEI) }];
      case "returned":
        return [{ ...base, state: "refunded", error: `The swap didn't go through on Xode${failure}, so ${ethers.formatUnits(outcome.usdtAmount, USDT_DECIMALS)} USDT (the deposit less Xode's fee) was left with ${beneficiary} on Xode instead of XON.` }];
      case "lost":
        return [{ ...base, state: "skipped", error: outcome.trapped
          ? `Neither XON nor USDT reached ${beneficiary} on Xode${failure} - the USDT is in Xode's asset trap (block ${outcome.blockHash}). Contact support with this transaction hash.`
          : `Xode processed this purchase's message${failure}, but neither XON nor USDT reached ${beneficiary} and what happened to the USDT couldn't be read (block ${outcome.blockHash}). Contact support with this transaction hash.` }];
    }
  }

  /// The fixed-rate minimum a summary carries (gateway deposits at the fixed rate only).
  function fixedMinimumOf(summary: { payout: string; minXonOut?: { raw: bigint | string } }): bigint | undefined {
    return summary.payout === "rate" && summary.minXonOut ? BigInt(summary.minXonOut.raw) : undefined;
  }

  return {
    network,

    /// Whether Xode would swap a purchase arriving over XCM right now; null if no network uses
    /// that route. For the startup check - quotes ask `xcm.ready` themselves.
    async xcmRouteReady(): Promise<boolean | null> {
      const net = [...networks.byName.values()].find((n) => n.xcmSwap);
      return net?.xcmSwap ? xcm.ready(net.xcmSwap.paraId) : null;
    },

    async info() {
      const [rate, limits] = await Promise.all([vending.quote(ethers.parseUnits("1", USDT_DECIMALS)) as Promise<bigint>, externalLimits()]);
      return {
        vendingAddress: xode.payTo,
        xon: { symbol: "XON", decimals: XON_DECIMALS, perUsdt: nativeAmount(rate) },
        usdtDecimals: USDT_DECIMALS,
        networks: [...networks.byName.values()].map((net) => ({
          name: net.name,
          chainId: net.chainId,
          chainIdHex: ethers.toQuantity(net.chainId),
          nativeSymbol: net.nativeSymbol,
          nativeDecimals: 18,
          usdtAddress: net.usdtAddress,
          // Where the USDT goes, and so what a purchase takes there.
          payTo: net.payTo,
          flow: net.gateway ? "approve-deposit" : "transfer",
          // How a market-price purchase is paid from here: "xcm" (one call to the XCM precompile,
          // swapped on Xode on arrival), "gateway" (depositForSwap), or null (Xode itself).
          marketRoute: net.xcmSwap ? "xcm" : net.gateway ? "gateway" : null,
          xcm: net.xcmSwap ? { precompile: XCM_PRECOMPILE, paraId: net.xcmSwap.paraId, fee: usdtAmount(XCM_SWAP_FEE), minPurchase: usdtAmount(XCM_SWAP_MIN_USDT) } : null,
          confirmations: net.confirmations,
        })),
        // Per gateway: the smallest deposit accepted, and the fee kept from a market-price refund
        // whose own minimum couldn't be met.
        gateways: Object.fromEntries(await Promise.all([...networks.byName.values()].filter((n) => n.gateway).map(async (n) => {
          const r = await gatewayRules(n);
          return [n.name, { minDeposit: usdtAmount(r.minDeposit), refundFee: usdtAmount(r.refundFee) }];
        }))),
        externalLimits: limits && { maxPerDeposit: usdtAmount(limits.maxPerDeposit), maxPerDay: usdtAmount(limits.maxPerDay) },
        // Market-price purchases (gateway depositForSwap): `quotes` says whether /api/quote and
        // `slippageBps` work here, or the caller has to supply `minXonOut` itself.
        marketPrice: { quotes: dex !== null, defaultSlippageBps: Number(DEFAULT_SLIPPAGE_BPS) },
      };
    },

    async limits() {
      const [limits, reserve] = await Promise.all([externalLimits(), xode.provider.getBalance(xode.payTo)]);
      const { maxPerDeposit, maxPer24h } = config.payoutLimits;
      const optional = (v: bigint | null) => (v === null ? null : usdtAmount(v));
      return {
        vendingReserveXon: nativeAmount(reserve),
        // AssetHub/Ethereum deposits above the lower of these are held for manual review.
        external: {
          onChain: limits && { maxPerDeposit: usdtAmount(limits.maxPerDeposit), maxPerDay: usdtAmount(limits.maxPerDay), availableNow: usdtAmount(limits.available) },
          relayer: { maxPerDeposit: optional(maxPerDeposit), maxPer24h: optional(maxPer24h) },
        },
      };
    },

    /// The fixed-rate quote, plus - on AssetHub/Ethereum, when the DEX can be quoted - the
    /// market-price one with the minimum `slippageBps` (default 1%) would set.
    async quote(amountValue: unknown, networkName: string | null, slippageValue: string | null = null) {
      const amount = parseUsdt(amountValue);
      const net = network(networkName ?? "xode");
      const { xon, warnings } = await purchaseChecks(net, amount);
      let swap = null;
      if (net.xcmSwap) {
        // Offered only while Xode would actually swap an arriving purchase (see xcm.ready).
        const quoted = (await xcm.ready(net.xcmSwap.paraId)) ? await xcm.quote(amount) : null;
        if (quoted !== null) {
          const slippageBps = slippageValue === null ? DEFAULT_SLIPPAGE_BPS : parseSlippageBps(slippageValue);
          const minXonOut = (quoted * (10_000n - slippageBps)) / 10_000n;
          const checks = amount < XCM_SWAP_MIN_USDT
            ? [`Market-price purchases from AssetHub are at least ${ethers.formatUnits(XCM_SWAP_MIN_USDT, USDT_DECIMALS)} USDT.`]
            : xcm.warnings(minXonOut, quoted);
          swap = { xonAmount: nativeAmount(quoted), minXonOut: nativeAmount(minXonOut), slippageBps: Number(slippageBps), refundFee: usdtAmount(XCM_SWAP_FEE), route: "xcm", warnings: checks };
        }
      } else if (net.gateway && dex) {
        const slippageBps = slippageValue === null ? DEFAULT_SLIPPAGE_BPS : parseSlippageBps(slippageValue);
        const quoted = await dex.quoteUsdtToXon(amount);
        if (quoted !== null) {
          const minXonOut = (quoted * (10_000n - slippageBps)) / 10_000n;
          try {
            const checks = await swapChecks(net, amount, minXonOut, quoted);
            swap = { xonAmount: nativeAmount(quoted), minXonOut: nativeAmount(minXonOut), slippageBps: Number(slippageBps), refundFee: usdtAmount((await gatewayRules(net)).refundFee), warnings: checks };
          } catch (err) {
            // A vending contract without market-price payouts: quote the fixed rate only.
            if (!(err instanceof ApiError && err.code === "SwapNotSupported")) throw err;
          }
        }
      }
      return {
        network: net.name, usdtAmount: usdtAmount(amount), xonAmount: nativeAmount(xon),
        // Fixed rate through a gateway: the minimum the deposit will carry (paid at least this, or refunded).
        ...(net.gateway ? { minXonOut: nativeAmount(fixedMinimum(xon)), rateToleranceBps: config.fixedRateToleranceBps } : {}),
        warnings, swap,
      };
    },

    async balances(addressValue: string, networkNames: string[] | null) {
      const address = parseAddress(addressValue, "address");
      const selected = networkNames ? networkNames.map(network) : [...networks.byName.values()];
      const entries = await Promise.all(selected.map(async (net) => {
        try {
          const [native, usdt, allowance]: bigint[] = await Promise.all([net.provider.getBalance(address), net.usdt.balanceOf(address), allowanceOf(net, address)]);
          return [net.name, {
            chainId: net.chainId,
            native: { symbol: net.nativeSymbol, ...nativeAmount(native) },
            usdt: { address: net.usdtAddress, ...usdtAmount(usdt) },
            // How much USDT the gateway may already take (null on Xode, which needs no approval).
            allowance: net.gateway ? usdtAmount(allowance) : null,
          }];
        } catch (err) {
          console.error(`[api] Balance lookup on ${net.name} failed:`, err);
          return [net.name, { error: "UpstreamError", message: `Couldn't read balances on ${net.name} right now.` }];
        }
      }));
      return { address, networks: Object.fromEntries(entries) };
    },

    async allowance(networkName: string, ownerValue: string) {
      const net = network(networkName);
      const owner = parseAddress(ownerValue, "address");
      if (!net.gateway) throw new ApiError(400, "NoApprovalNeeded", "Purchases on Xode are a plain USDT transfer - there's no allowance.");
      return { network: net.name, owner, spender: net.payTo, allowance: usdtAmount(await allowanceOf(net, owner)) };
    },

    /// `amount` "max" approves an unlimited amount.
    async prepareApprove(body: Record<string, unknown>) {
      const net = network(String(body.network ?? ""));
      const from = parseAddress(body.from, "from");
      const amount = body.amount === "max" ? ethers.MaxUint256 : parseUsdt(body.amount);
      const allowance = await allowanceOf(net, from);
      return prepared(net, from, amount, approveSteps(net, from, amount, allowance), { currentAllowance: usdtAmount(allowance) });
    },

    async prepareDeposit(body: Record<string, unknown>) {
      const net = network(String(body.network ?? ""));
      const from = parseAddress(body.from, "from");
      const beneficiary = body.beneficiary === undefined ? from : parseAddress(body.beneficiary, "beneficiary");
      const amount = parseUsdt(body.amount);
      const terms = await payoutTerms(net, amount, body);
      if (terms && net.xcmSwap) {
        throw new ApiError(400, "UseBuy", `Market-price purchases from ${net.name} are one XCM call, not a gateway deposit - prepare them with POST /api/tx/buy.`);
      }
      const summary = await payoutSummary(net, amount, terms, beneficiary);
      const step = depositStep(net, from, amount, beneficiary, terms?.minXonOut, fixedMinimumOf(summary));
      const [allowance] = await Promise.all([allowanceOf(net, from), requireUsdtBalance(net, from, amount)]);
      if (allowance < amount) {
        throw new ApiError(422, "InsufficientAllowance", `The gateway may take ${ethers.formatUnits(allowance, USDT_DECIMALS)} USDT from ${from} - approve at least ${ethers.formatUnits(amount, USDT_DECIMALS)} first (POST /api/tx/approve).`);
      }
      return prepared(net, from, amount, [step], { beneficiary, ...summary });
    },

    /// The whole purchase: every transaction needed, in order.
    async prepareBuy(body: Record<string, unknown>) {
      const net = network(String(body.network ?? ""));
      const from = parseAddress(body.from, "from");
      const beneficiary = body.beneficiary === undefined ? from : parseAddress(body.beneficiary, "beneficiary");
      const amount = parseUsdt(body.amount);
      const terms = await payoutTerms(net, amount, body);
      if (terms && net.xcmSwap) {
        await requireUsdtBalance(net, from, amount);
        const summary = await payoutSummary(net, amount, terms, beneficiary);
        const { params, weight } = await xcm.prepare(net, from, beneficiary, amount, terms.minXonOut);
        return prepared(net, from, amount, [swapStep(net, from, params, weight, beneficiary)], {
          beneficiary,
          ...summary,
          // What the call carries, so the front-end can check it against what it asked for.
          xcm: { beneficiaryAccount: params.beneficiaryAccount, topic: params.topic, paraId: params.paraId, minXonPlanck: params.minXonPlanck.toString() },
        });
      }
      const [allowance] = await Promise.all([allowanceOf(net, from), requireUsdtBalance(net, from, amount)]);
      const summary = await payoutSummary(net, amount, terms, beneficiary);
      const steps = purchaseSteps(net, from, amount, beneficiary, allowance, terms?.minXonOut, fixedMinimumOf(summary));
      return prepared(net, from, amount, steps, { beneficiary, ...summary });
    },

    /// Relays a transaction the buyer's wallet signed but didn't send itself - only to this
    /// network's USDT or gateway/vending contract, so the API isn't a general-purpose relay.
    async broadcast(body: Record<string, unknown>) {
      const net = network(String(body.network ?? ""));
      if (typeof body.signedTx !== "string") throw new ApiError(400, "InvalidTransaction", "signedTx must be a signed, serialized transaction (0x...).");
      let tx: ethers.Transaction;
      try {
        tx = ethers.Transaction.from(body.signedTx);
      } catch {
        throw new ApiError(400, "InvalidTransaction", "signedTx isn't a valid signed transaction.");
      }
      if (!tx.signature) throw new ApiError(400, "InvalidTransaction", "signedTx isn't signed.");
      if (tx.chainId !== 0n && tx.chainId !== net.chainId) throw new ApiError(400, "WrongChain", `Transaction is for chain ${tx.chainId}, but ${net.name} is chain ${net.chainId}.`);
      const allowedTo = [net.usdtAddress, net.payTo, ...(net.xcmSwap ? [XCM_PRECOMPILE] : [])].map((a) => a.toLowerCase());
      if (!tx.to || !allowedTo.includes(tx.to.toLowerCase())) throw new ApiError(400, "UnsupportedTransaction", "Only USDT and purchase transactions can be broadcast through this API.");
      // The precompile runs any XCM; only the purchase program goes through here.
      if (tx.to.toLowerCase() === XCM_PRECOMPILE.toLowerCase() && swapInCall(tx.data)?.params.paraId !== net.xcmSwap?.paraId) {
        throw new ApiError(400, "UnsupportedTransaction", "Only USDT and purchase transactions can be broadcast through this API.");
      }
      try {
        const sent = await net.provider.broadcastTransaction(body.signedTx);
        return { network: net.name, txHash: sent.hash };
      } catch (err) {
        // The node's reason (nonce too low, insufficient funds...) is about the user's own tx.
        const message = (err as { shortMessage?: string; message?: string }).shortMessage ?? (err as Error).message;
        throw new ApiError(422, "BroadcastRejected", message);
      }
    },

    /// Where a transaction is, and - for a purchase - where each of its deposits is.
    async txStatus(networkName: string, hashValue: string): Promise<TxStatus> {
      const net = network(networkName);
      if (!ethers.isHexString(hashValue, 32)) throw new ApiError(400, "InvalidTxHash", "Transaction hash must be 0x followed by 64 hex characters.");
      const txHash = hashValue.toLowerCase();
      const base: TxStatus = { network: net.name, txHash, state: "pending", blockNumber: null, confirmed: false, confirmations: 0, receipt: null, deposits: [] };

      const receipt = await net.provider.getTransactionReceipt(txHash);
      if (!receipt) {
        const pending = await net.provider.getTransaction(txHash);
        return { ...base, state: pending ? "pending" : "not-found" };
      }
      const [head, safeHead] = await Promise.all([net.provider.getBlockNumber(), getSafeHead(net.provider, net.confirmations)]);
      const confirmed = receipt.blockNumber <= safeHead;
      const status: TxStatus = {
        ...base,
        state: receipt.status === 1 ? "mined" : "failed",
        blockNumber: receipt.blockNumber,
        confirmed,
        confirmations: Math.max(0, head - receipt.blockNumber + 1),
        receipt: receiptJson(receipt),
      };
      if (receipt.status !== 1) return status;

      if (net.xcmSwap && receipt.to?.toLowerCase() === XCM_PRECOMPILE.toLowerCase()) {
        status.deposits = await xcmDeposits(net, receipt, confirmed);
        return status;
      }

      status.deposits = await Promise.all(depositsInLogs(net, receipt.hash, receipt.logs).map(async (d): Promise<DepositInfo> => {
        const settled: boolean = net.gateway ? await vending.externalSettledDeposits(d.depositId) : await vending.settledDeposits(d.depositId);
        const record = ledger.get(d.depositId);
        const fromLedger = record ? LEDGER_STATES[record.status] : undefined;
        // The chain's flag is the truth on whether it's paid; the ledger fills in the rest.
        const state: DepositState = settled ? "settled" : fromLedger && fromLedger !== "settled" ? fromLedger : confirmed ? "settling" : "awaiting-confirmations";
        return {
          index: d.index,
          depositId: d.depositId,
          beneficiary: d.beneficiary,
          usdtAmount: usdtAmount(d.usdtAmount),
          state,
          settleTxHash: settled ? record?.settleTxHash ?? null : null,
          xonAmount: null,
          error: state === "held" || state === "skipped" ? record?.error ?? null : null,
        };
      }));
      return status;
    },

    /// The XON payout for a deposit, from Xode's Settled/ExternalSettled events at or after
    /// `fromBlock` - for when the ledger isn't available to say which tx paid it.
    async findPayout(depositId: string, external: boolean, fromBlock: number): Promise<{ settleTxHash: string; xonAmount: Amount } | null> {
      const head = await xode.provider.getBlockNumber();
      const start = Math.max(fromBlock, head - config.logChunkSize + 1, 0);
      // Xode's bridge rejects null topic wildcards, so filter on topic0 and match the id here. An
      // external deposit is paid by either kind of payout, fixed-rate or market-price.
      const topic0 = external ? [EXTERNAL_SETTLED_TOPIC, EXTERNAL_SWAP_SETTLED_TOPIC] : SETTLED_TOPIC;
      const logs = await xode.provider.getLogs({ address: xode.payTo, topics: [topic0], fromBlock: start, toBlock: head });
      for (const log of logs) {
        if (log.topics[2]?.toLowerCase() !== depositId.toLowerCase()) continue;
        const parsed = vending.interface.parseLog(log);
        if (parsed) return { settleTxHash: log.transactionHash, xonAmount: nativeAmount(parsed.args.xonOut) };
      }
      return null;
    },

    /// Purchase history for an address, from the relayer's ledger (empty if the API can't see it).
    deposits(addressValue: string) {
      const address = parseAddress(addressValue, "address");
      // Purchases over XCM never reach the relayer's ledger; the API keeps its own record of them.
      const overXcm = xcm.history.forBeneficiary(address).map((r) => ({
        sourceChain: "assethub",
        sourceTxHash: r.sourceTxHash,
        index: 0,
        depositId: r.topic,
        usdtAmount: usdtAmount(BigInt(r.usdtAmount)),
        state: r.state as DepositState,
        settleTxHash: null,
        updatedAt: r.time,
      }));
      return {
        address,
        deposits: [...overXcm, ...ledger.forBeneficiary(address).map((r) => ({
          sourceChain: r.sourceChain,
          sourceTxHash: r.sourceTxHash,
          index: r.depositIndex ?? 0,
          depositId: r.depositId,
          usdtAmount: usdtAmount(BigInt(r.usdtAmount)),
          state: LEDGER_STATES[r.status] ?? "settling",
          settleTxHash: r.settleTxHash ?? null,
          updatedAt: r.time,
        }))].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      };
    },
  };
}
