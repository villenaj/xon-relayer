// What the front-end API reads from the chains and the relayer's ledger. Read-only: nothing here
// signs. Every deposit status comes from the chain first (the deposit tx's own logs, the vending
// contract's settled flags); the ledger only adds what the chain can't say - held/skipped/refunded,
// and which Xode tx paid it.

import { statSync } from "node:fs";
import { ethers, type Log, type TransactionReceipt } from "ethers";
import { getSafeHead } from "../chain.js";
import { USDT_DECIMALS, type Config } from "../config.js";
import { readLedger, type LedgerRecord, type LedgerStatus } from "../ledger.js";
import { depositIdAt, externalDepositId } from "../settlement.js";
import { DEPOSITED_TOPIC, TRANSFER_TOPIC } from "../tools/common.js";
import { ApiError } from "./http.js";
import type { Network, NetworkName, Networks } from "./networks.js";
import { approveSteps, depositStep, parseAddress, parseUsdt, purchaseSteps, type TxStep } from "./transactions.js";

export const SETTLED_TOPIC = ethers.id("Settled(address,bytes32,uint256,uint256)");
export const EXTERNAL_SETTLED_TOPIC = ethers.id("ExternalSettled(address,string,bytes32,uint256,uint256)");
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
/// `Deposited` events elsewhere.
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
      if (log.address.toLowerCase() !== payTo || log.topics[0] !== DEPOSITED_TOPIC) continue;
      const parsed = network.gateway.interface.parseLog(log);
      if (parsed) found.push({ beneficiary: parsed.args.xodeBeneficiary, usdtAmount: parsed.args.usdtAmount });
    }
  }
  const baseId = network.gateway ? externalDepositId(network.name, txHash) : txHash;
  return found.map((d, index) => ({ ...d, index, depositId: depositIdAt(baseId, index) }));
}

/// The ledger, re-read only when the file changes. Missing (the API runs on another host than the
/// relayer) just means no ledger detail.
function makeLedgerView(file: string) {
  let stamp = "";
  let byDepositId = new Map<string, LedgerRecord>();
  let all: LedgerRecord[] = [];

  function refresh(): void {
    let current = "";
    try {
      const stat = statSync(file);
      current = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      current = "missing";
    }
    if (current === stamp) return;
    stamp = current;
    all = current === "missing" ? [] : readLedger(file);
    byDepositId = new Map();
    // Later lines win: the last word on a deposit is its current state. A "failed" retry after
    // it was held doesn't un-hold it, so only let "failed" through when there's nothing else.
    for (const record of all) {
      const key = record.depositId.toLowerCase();
      const previous = byDepositId.get(key);
      if (record.status === "failed" && previous && previous.status !== "failed") continue;
      byDepositId.set(key, record);
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

export function makeApiService(config: Config, networks: Networks) {
  const { xode, vending } = networks;
  const ledger = makeLedgerView(config.ledgerFile);

  function network(name: string): Network {
    const found = networks.byName.get(name as NetworkName);
    if (!found) throw new ApiError(404, "UnknownNetwork", `Unknown or unconfigured network "${name}" - one of: ${[...networks.byName.keys()].join(", ")}.`);
    return found;
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
  async function purchaseChecks(net: Network, amount: bigint): Promise<{ xon: bigint; warnings: string[] }> {
    const [xon, reserve, limits]: [bigint, bigint, Awaited<ReturnType<typeof externalLimits>>] = await Promise.all([
      vending.quote(amount),
      xode.provider.getBalance(xode.payTo),
      net.gateway ? externalLimits() : Promise.resolve(null),
    ]);
    if (xon === 0n) throw new ApiError(422, "AmountTooSmall", "That amount rounds down to 0 XON - it would never be paid out. Send more USDT.");
    const warnings: string[] = [];
    if (reserve < xon) warnings.push("The vending contract's XON reserve is currently below this payout - it will be paid once the reserve is topped up.");
    if (net.gateway) {
      const relayerCap = config.payoutLimits.maxPerDeposit;
      if (limits && (limits.maxPerDeposit === 0n || limits.maxPerDay === 0n)) {
        warnings.push(`Payouts for ${net.name} deposits are currently switched off - the deposit will be held until an operator enables them.`);
      } else if ((relayerCap !== null && amount > relayerCap) || (limits && amount > limits.maxPerDeposit)) {
        warnings.push("This amount is over the automatic payout limit - the deposit will be held for manual review before XON is paid.");
      } else if (limits && amount > limits.available) {
        warnings.push("Today's payout allowance is nearly used up - XON for this deposit may be delayed until it refills.");
      }
    }
    return { xon, warnings };
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

  return {
    network,

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
          confirmations: net.confirmations,
        })),
        externalLimits: limits && { maxPerDeposit: usdtAmount(limits.maxPerDeposit), maxPerDay: usdtAmount(limits.maxPerDay) },
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

    async quote(amountValue: unknown, networkName: string | null) {
      const amount = parseUsdt(amountValue);
      const net = network(networkName ?? "xode");
      const { xon, warnings } = await purchaseChecks(net, amount);
      return { network: net.name, usdtAmount: usdtAmount(amount), xonAmount: nativeAmount(xon), warnings };
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
      const step = depositStep(net, from, amount, beneficiary);
      const [allowance] = await Promise.all([allowanceOf(net, from), requireUsdtBalance(net, from, amount)]);
      if (allowance < amount) {
        throw new ApiError(422, "InsufficientAllowance", `The gateway may take ${ethers.formatUnits(allowance, USDT_DECIMALS)} USDT from ${from} - approve at least ${ethers.formatUnits(amount, USDT_DECIMALS)} first (POST /api/tx/approve).`);
      }
      const { xon, warnings } = await purchaseChecks(net, amount);
      return prepared(net, from, amount, [step], { beneficiary, xonAmount: nativeAmount(xon), warnings });
    },

    /// The whole purchase: every transaction needed, in order.
    async prepareBuy(body: Record<string, unknown>) {
      const net = network(String(body.network ?? ""));
      const from = parseAddress(body.from, "from");
      const beneficiary = body.beneficiary === undefined ? from : parseAddress(body.beneficiary, "beneficiary");
      const amount = parseUsdt(body.amount);
      const [allowance] = await Promise.all([allowanceOf(net, from), requireUsdtBalance(net, from, amount)]);
      const steps = purchaseSteps(net, from, amount, beneficiary, allowance);
      const { xon, warnings } = await purchaseChecks(net, amount);
      return prepared(net, from, amount, steps, { beneficiary, xonAmount: nativeAmount(xon), warnings });
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
      const allowedTo = [net.usdtAddress, net.payTo].map((a) => a.toLowerCase());
      if (!tx.to || !allowedTo.includes(tx.to.toLowerCase())) throw new ApiError(400, "UnsupportedTransaction", "Only USDT and purchase transactions can be broadcast through this API.");
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
      // Xode's bridge rejects null topic wildcards, so filter on topic0 and match the id here.
      const logs = await xode.provider.getLogs({ address: xode.payTo, topics: [external ? EXTERNAL_SETTLED_TOPIC : SETTLED_TOPIC], fromBlock: start, toBlock: head });
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
      return {
        address,
        deposits: ledger.forBeneficiary(address).map((r) => ({
          sourceChain: r.sourceChain,
          sourceTxHash: r.sourceTxHash,
          index: r.depositIndex ?? 0,
          depositId: r.depositId,
          usdtAmount: usdtAmount(BigInt(r.usdtAmount)),
          state: LEDGER_STATES[r.status] ?? "settling",
          settleTxHash: r.settleTxHash ?? null,
          updatedAt: r.time,
        })),
      };
    },
  };
}
