// Market-price payouts (gateway depositForSwap -> XonVendingMachine.settleExternalSwap): reading
// SwapDeposited, routing failures through the DEX diagnosis, the ledger, and the API's tx building.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { ethers, type JsonRpcProvider, type Log, type TransactionReceipt } from "ethers";
import { createDepositScanner, type DepositSource } from "../../src/adapters/depositScanner.js";
import { DEPOSITED_TOPIC, GATEWAY_DEPOSIT_TOPICS, gatewayRecordsDeposits, isRefundedOnGateway, parseGatewayDeposit, SWAP_DEPOSITED_TOPIC } from "../../src/adapters/evmGatewayAdapter.js";
import { classifySettleError } from "../../src/errorClassifier.js";
import { makeLedger, readLedger } from "../../src/ledger.js";
import { depositIdAt, externalDepositId } from "../../src/settlement.js";
import { diagnoseSwapFailure, type XodeDex } from "../../src/xodeDex.js";
import { deviationBps, nextRate } from "../../src/rateKeeper.js";
import { makeAccountedTransfers, matchAccountedTransfers } from "../../src/adapters/accountedTransfers.js";
const { refundProven } = await import("../../src/tools/refundTargets.js");
import { fakeContext, quiet, revertError, tmpDir, vending } from "./helpers.js";
import GATEWAY_ABI from "../../src/abi/EthUsdtGateway.json" with { type: "json" };
import ERC20_ABI from "../../src/abi/IERC20.json" with { type: "json" };

process.env.VENDING_ADDRESS ??= "0x00000000000000000000000000000000000000aa";
const { ApiError } = await import("../../src/api/http.js");
const { depositStep, parseSlippageBps, parseXon, purchaseSteps } = await import("../../src/api/transactions.js");
const { depositsInLogs } = await import("../../src/api/service.js");

quiet();

const GATEWAY = ethers.getAddress("0x00000000000000000000000000000000000000cc");
const USDT = ethers.getAddress("0x00000000000000000000000000000000000000aa");
const DEPOSITOR = "0x1111111111111111111111111111111111111111";
const BENEFICIARY = "0x2222222222222222222222222222222222222222";
const gateway = new ethers.Contract(GATEWAY, GATEWAY_ABI);
const assetHub = {
  name: "assethub" as const, chainId: 420420421n, usdt: new ethers.Contract(USDT, ERC20_ABI), usdtAddress: USDT,
  payTo: GATEWAY, gateway, approveResetsToZero: false,
};

/// What Xode's XCM precompile reverts with for any failed XCM program.
function xcmFailure(): Error & { data: string } {
  const data = new ethers.Interface(["error Error(string)"]).encodeErrorResult("Error", ["XCM execute failed: message may be invalid or execution constraints not satisfied"]);
  return Object.assign(new Error("execution reverted"), { data });
}

function gatewayLog(event: "Deposited" | "SwapDeposited", args: unknown[], txHash: string, index: number): Log {
  const { topics, data } = gateway.interface.encodeEventLog(event, args);
  return { address: GATEWAY, topics, data, index, blockNumber: 120, transactionHash: txHash } as unknown as Log;
}

function fakeDex(state: { paused?: boolean; active?: boolean; quote?: bigint | null } = {}): XodeDex {
  return {
    swapsPaused: async () => state.paused ?? false,
    poolActive: async () => state.active ?? true,
    quoteUsdtToXon: async () => (state.quote === undefined ? 10n ** 18n : state.quote),
    spotXonPerUsdt: async () => 2n * 10n ** 17n,
    disconnect: async () => {},
  };
}

// --- reading deposits ---------------------------------------------------------------------------

test("both gateway events are read; only SwapDeposited carries the buyer's minimum", () => {
  assert.notEqual(DEPOSITED_TOPIC, SWAP_DEPOSITED_TOPIC);
  assert.deepEqual(GATEWAY_DEPOSIT_TOPICS, [DEPOSITED_TOPIC, SWAP_DEPOSITED_TOPIC]);

  const fixed = parseGatewayDeposit(gateway.interface, gatewayLog("Deposited", [DEPOSITOR, BENEFICIARY, 5_000_000n, 0n], "0xaa", 0), "ethereum");
  assert.equal(fixed?.usdtAmount, 5_000_000n);
  assert.equal(fixed?.minXonOut, undefined);
  assert.ok(!("minXonOut" in fixed!), "a fixed-rate deposit has no minXonOut key at all");

  const swap = parseGatewayDeposit(gateway.interface, gatewayLog("SwapDeposited", [DEPOSITOR, BENEFICIARY, 2_000_000n, 1n, 3_800_000_000_000_000_000n], "0xbb", 0), "ethereum");
  assert.equal(swap?.buyer, ethers.getAddress(BENEFICIARY));
  assert.equal(swap?.usdtAmount, 2_000_000n);
  assert.equal(swap?.minXonOut, 3_800_000_000_000_000_000n);

  const transfer = { ...gatewayLog("Deposited", [DEPOSITOR, BENEFICIARY, 1n, 0n], "0xcc", 0), topics: [ethers.id("Transfer(address,address,uint256)")] } as unknown as Log;
  assert.equal(parseGatewayDeposit(gateway.interface, transfer, "ethereum"), null);
});

test("the XCM precompile's revert decodes as a plain Error(string), which the adapter diagnoses", () => {
  assert.deepEqual(classifySettleError(vending, xcmFailure()), { kind: "transient", name: "Error" });
  // The contract's own errors keep their names, so they're never re-diagnosed.
  assert.deepEqual(classifySettleError(vending, revertError("InsufficientUsdtInventory")), { kind: "transient", name: "InsufficientUsdtInventory" });
});

// --- diagnosing a failed swap -------------------------------------------------------------------

test("a failed swap is refunded only when the pool can no longer meet the buyer's minimum", async () => {
  const min = 10n ** 18n;
  const cases: [string, XodeDex | null, string, string][] = [
    ["no Substrate RPC", null, "transient", "SwapFailed"],
    ["swaps paused by governance", fakeDex({ paused: true, quote: 1n }), "transient", "SwapsPaused"],
    ["pool still pending approval", fakeDex({ active: false, quote: 1n }), "transient", "PoolNotActive"],
    ["no pool / no liquidity", fakeDex({ quote: null }), "transient", "NoPoolQuote"],
    ["pool below the minimum", fakeDex({ quote: min - 1n }), "permanent", "MinimumNotMet"],
    ["pool meets the minimum (something else)", fakeDex({ quote: min }), "transient", "SwapFailed"],
  ];
  for (const [label, dex, kind, name] of cases) {
    const diagnosis = await diagnoseSwapFailure(dex, 2_000_000n, min);
    assert.deepEqual([diagnosis.kind, diagnosis.name], [kind, name], label);
    assert.ok(diagnosis.detail.length > 0);
  }
});

// --- the scanner applying the diagnosis ---------------------------------------------------------

async function scannerWith(diagnose: DepositSource["diagnose"], failures: Record<string, Error>) {
  const dir = tmpDir();
  const context = fakeContext(dir);
  const logs = [{ blockNumber: 110, transactionHash: "swap" }, { blockNumber: 120, transactionHash: "next" }];
  const source: DepositSource = {
    label: "test", description: "test", logAddress: "0x", topic: GATEWAY_DEPOSIT_TOPICS, confirmations: 0,
    provider: {
      getBlockNumber: async () => 200,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) => logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
    } as unknown as JsonRpcProvider,
    checkpointFile: "test.json", checkpointIdentity: "id", startBlock: 100, startBlockName: "X",
    parse: (log) => ({ buyer: "0x01", usdtAmount: 2_000_000n, sourceChain: "test", sourceTxHash: log.transactionHash, sourceBlock: log.blockNumber, minXonOut: 10n ** 18n }),
    baseDepositId: (tx) => tx,
    isSettled: async () => false,
    async settle(d) {
      const failure = failures[d.sourceTxHash];
      if (failure) throw failure;
      return { hash: `settle-${d.sourceTxHash}`, blockNumber: 999 } as unknown as TransactionReceipt;
    },
    diagnose,
  };
  const scanner = await createDepositScanner(context, source);
  return { scanner, context };
}

test("a swap the pool can't meet is skipped (refund list) and the deposits behind it carry on", async () => {
  const { scanner, context } = await scannerWith(
    async () => ({ kind: "permanent", name: "MinimumNotMet", detail: "below the minimum" }),
    { swap: xcmFailure() },
  );
  assert.equal(await scanner.tick(), 0);
  assert.deepEqual(context.entries.map((e) => [e.sourceTxHash, e.status, e.error]), [["swap", "skipped", "MinimumNotMet"], ["next", "settled", undefined]]);
  assert.equal(context.entries[0].minXonOut, 10n ** 18n, "the ledger keeps the buyer's minimum");
});

test("a swap that fails for a passing reason (paused, pool pending) stalls and is retried", async () => {
  const { scanner, context } = await scannerWith(
    async () => ({ kind: "transient", name: "SwapsPaused", detail: "paused" }),
    { swap: xcmFailure() },
  );
  assert.ok((await scanner.tick()) > 0, "still behind: stalled at the swap");
  assert.deepEqual(context.entries.map((e) => [e.sourceTxHash, e.status, e.error]), [["swap", "failed", "SwapsPaused"]]);
});

test("if the diagnosis itself fails, the deposit is retried, never given up on", async () => {
  const { scanner, context } = await scannerWith(async () => { throw new Error("Substrate RPC down"); }, { swap: xcmFailure() });
  assert.ok((await scanner.tick()) > 0);
  assert.deepEqual(context.entries.map((e) => e.status), ["failed"]);
});

test("permanent and held errors are never second-guessed by the diagnosis", async () => {
  let asked = 0;
  const { scanner, context } = await scannerWith(async () => { asked++; return null; }, { swap: revertError("ZeroAddress") });
  await scanner.tick();
  assert.equal(asked, 0);
  assert.deepEqual(context.entries.map((e) => e.status), ["skipped", "settled"]);
});

// --- ledger ---------------------------------------------------------------------------------------

test("the ledger stores a swap deposit's minimum as a decimal string, and omits it otherwise", () => {
  const file = path.join(tmpDir(), "ledger.jsonl");
  const ledger = makeLedger(file);
  const base = { adapter: "ethereum", buyer: BENEFICIARY, usdtAmount: 2_000_000n, sourceChain: "ethereum", sourceTxHash: "0xaa", depositId: "0x01", sourceBlock: 1 };
  ledger.record({ ...base, status: "skipped", error: "MinimumNotMet", minXonOut: 3_800_000_000_000_000_000n });
  ledger.record({ ...base, status: "settled" });
  const [swap, fixed] = readLedger(file);
  assert.equal(swap.minXonOut, "3800000000000000000");
  assert.equal(fixed.minXonOut, undefined);
  assert.ok(!readFileSync(file, "utf8").split("\n")[1].includes("minXonOut"));
});

// --- API transactions -----------------------------------------------------------------------------

test("a market-price purchase deposits with depositForSwap and the buyer's minimum", () => {
  const steps = purchaseSteps(assetHub, DEPOSITOR, 2_000_000n, BENEFICIARY, 0n, 3_800_000_000_000_000_000n);
  assert.deepEqual(steps.map((s) => s.kind), ["approve", "deposit"]);
  const call = gateway.interface.parseTransaction({ data: steps[1].tx.data })!;
  assert.equal(call.name, "depositForSwap");
  assert.deepEqual([...call.args], [2_000_000n, ethers.getAddress(BENEFICIARY), 3_800_000_000_000_000_000n]);
  assert.match(steps[1].description, /at least 3\.8 XON .* market price, or the USDT is refunded/);

  // Without a minimum it's the fixed-rate deposit, as before.
  assert.equal(gateway.interface.parseTransaction({ data: depositStep(assetHub, DEPOSITOR, 2_000_000n, BENEFICIARY).tx.data })!.name, "deposit");
});

test("XON minimums and slippage are validated", () => {
  assert.equal(parseXon("3.8", "minXonOut"), 3_800_000_000_000_000_000n);
  assert.equal(parseSlippageBps("100"), 100n);
  const code = (fn: () => unknown) => { try { fn(); } catch (err) { return err instanceof ApiError ? err.code : "other"; } return undefined; };
  for (const bad of ["0", "-1", "abc", "1.0000000000000000001", null]) assert.equal(code(() => parseXon(bad, "minXonOut")), "InvalidAmount", String(bad));
  for (const bad of ["0", "5001", "1.5", "-5", "", null]) assert.equal(code(() => parseSlippageBps(bad)), "InvalidSlippage", String(bad));
});

test("the API numbers a tx's deposits across both events, like the relayer", () => {
  const TX = "0x" + "ab".repeat(32);
  const logs = [
    gatewayLog("Deposited", [DEPOSITOR, BENEFICIARY, 1_000_000n, 0n], TX, 0),
    gatewayLog("SwapDeposited", [DEPOSITOR, BENEFICIARY, 2_000_000n, 1n, 1n], TX, 1),
  ];
  const found = depositsInLogs(assetHub, TX, logs);
  const base = externalDepositId("assethub", TX);
  assert.deepEqual(found.map((d) => [d.usdtAmount, d.index, d.depositId]), [[1_000_000n, 0, base], [2_000_000n, 1, depositIdAt(base, 1)]]);
});

test("a settle that errors but landed on-chain is recorded as already settled - never diagnosed, refunded or released", async () => {
  // E.g. Xode's eth-rpc failing to decode the block and losing the receipt after a runtime upgrade:
  // the swap executed, the client only saw an error, and the pool has since moved past the minimum.
  const dir = tmpDir();
  const context = fakeContext(dir);
  const settledOnChain = new Set<string>();
  let diagnosed = 0;
  let released = 0;
  const source: DepositSource = {
    label: "test", description: "test", logAddress: "0x", topic: GATEWAY_DEPOSIT_TOPICS, confirmations: 0,
    provider: {
      getBlockNumber: async () => 200,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) =>
        [{ blockNumber: 110, transactionHash: "landed" }, { blockNumber: 120, transactionHash: "next" }].filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
    } as unknown as JsonRpcProvider,
    checkpointFile: "test.json", checkpointIdentity: "id", startBlock: 100, startBlockName: "X",
    parse: (log) => ({ buyer: "0x01", usdtAmount: 2_000_000n, sourceChain: "test", sourceTxHash: log.transactionHash, sourceBlock: log.blockNumber, minXonOut: 10n ** 18n }),
    baseDepositId: (tx) => tx,
    isSettled: async (d) => settledOnChain.has(d.depositId),
    async settle(d) {
      if (d.sourceTxHash === "landed") {
        settledOnChain.add(d.depositId); // it went through...
        throw xcmFailure(); // ...but the client was told otherwise
      }
      return { hash: `settle-${d.sourceTxHash}`, blockNumber: 999 } as unknown as TransactionReceipt;
    },
    gate: () => ({ action: "settle", release: () => { released++; } }),
    diagnose: async () => { diagnosed++; return { kind: "permanent", name: "MinimumNotMet", detail: "below the minimum" }; },
  };
  const scanner = await createDepositScanner(context, source);
  assert.equal(await scanner.tick(), 0);
  assert.deepEqual(context.entries.map((e) => [e.sourceTxHash, e.status, e.error]), [["landed", "already-settled", "SettledDespiteError"], ["next", "settled", undefined]]);
  assert.equal(diagnosed, 0, "a settled deposit is never diagnosed (and so never sent to the refund list)");
  assert.equal(released, 0, "its payout-cap reservation is kept - it was paid");
});

test("USDT the vending contract pulled in itself (buy, fundUsdtInventory) isn't treated as a deposit", async () => {
  const VENDING = "0x00000000000000000000000000000000000000bb";
  const iface = new ethers.Interface(["event Bought(address indexed buyer, uint256 usdtIn, uint256 xonOut)", "event UsdtInventoryFunded(address indexed from, uint256 amount)", "event Transfer(address indexed from, address indexed to, uint256 value)"]);
  let index = 0;
  const logOf = (tx: string, address: string, event: string, args: unknown[]) => ({ address, transactionHash: tx, index: index++, ...iface.encodeEventLog(event, args) });
  const OTHER = ethers.getAddress("0x00000000000000000000000000000000000000dd");
  const logs = [
    logOf("0xf0", USDT, "Transfer", [DEPOSITOR, VENDING, 5n]), logOf("0xf0", VENDING, "UsdtInventoryFunded", [DEPOSITOR, 5n]),
    logOf("0xb0", USDT, "Transfer", [DEPOSITOR, VENDING, 5n]), logOf("0xb0", VENDING, "Bought", [DEPOSITOR, 5n, 25n]),
    logOf("0xd0", USDT, "Transfer", [DEPOSITOR, VENDING, 5n]),
    // Same event, but from some other contract - doesn't count.
    logOf("0x5f", USDT, "Transfer", [DEPOSITOR, VENDING, 5n]), logOf("0x5f", GATEWAY, "UsdtInventoryFunded", [DEPOSITOR, 5n]),
    // A batch: a plain 7 USDT transfer, then a buy() of 5 - only the buy's own transfer is accounted.
    logOf("0xba", USDT, "Transfer", [DEPOSITOR, VENDING, 7n]), logOf("0xba", USDT, "Transfer", [DEPOSITOR, VENDING, 5n]), logOf("0xba", VENDING, "Bought", [DEPOSITOR, 5n, 25n]),
    // A batch of two same-sized transfers and one buy(): the buy claims the later one, the first is a deposit.
    logOf("0xbb", USDT, "Transfer", [DEPOSITOR, VENDING, 5n]), logOf("0xbb", USDT, "Transfer", [DEPOSITOR, VENDING, 5n]), logOf("0xbb", VENDING, "Bought", [DEPOSITOR, 5n, 25n]),
    // Someone else's transfer batched with a buy() of the same amount isn't the buy's.
    logOf("0xcc", USDT, "Transfer", [OTHER, VENDING, 5n]), logOf("0xcc", VENDING, "Bought", [DEPOSITOR, 5n, 25n]),
  ];
  const transfers = logs.filter((l) => l.address === USDT);
  const accounted = logs.filter((l) => l.address !== USDT);
  const claimed = matchAccountedTransfers(transfers, accounted, VENDING.toUpperCase().replace("0X", "0x"));
  const accountedTransfers = transfers.filter((t) => claimed.has(`${t.transactionHash}:${t.index}`)).map((t) => `${t.transactionHash}#${t.index}`);
  assert.deepEqual(accountedTransfers, ["0xf0#0", "0xb0#2", "0xba#8", "0xbb#11"]);

  // Read through eth_getLogs, by block - no receipts (Xode's eth-rpc can lose those).
  let calls = 0;
  const provider = {
    getLogs: async (filter: { address: string; fromBlock: number }) => {
      calls++;
      if (filter.fromBlock === 2) return []; // a block with no accounted events: one call, done
      return logs.filter((l) => l.address.toLowerCase() === filter.address.toLowerCase());
    },
  };
  const lookup = makeAccountedTransfers(provider as never, USDT, VENDING);
  assert.equal(await lookup.isAccounted(1, "0xba", 8), true);
  assert.equal(await lookup.isAccounted(1, "0xba", 7), false, "the plain transfer batched with a buy() is a deposit");
  assert.equal(await lookup.isAccounted(1, "0xd0", 4), false);
  assert.equal(calls, 2, "a block is looked up once for all its deposits");
  assert.equal(await lookup.isAccounted(2, "0xd0", 4), false);
  assert.equal(calls, 3);
});

// --- rate keeper ------------------------------------------------------------------------------------

test("the rate keeper steps toward the DEX price, within the contract's step and its own deadband", () => {
  const e = (x: string) => ethers.parseEther(x);
  const step = { maxStepBps: 200n, deadbandBps: 50n };
  // Inside the 0.5% deadband: leave it.
  assert.equal(nextRate({ current: e("0.2"), target: e("0.2009"), ...step }), null);
  // Close enough to reach in one step: go straight to the market.
  assert.equal(nextRate({ current: e("0.2"), target: e("0.203"), ...step }), e("0.203"));
  assert.equal(nextRate({ current: e("0.2"), target: e("0.197"), ...step }), e("0.197"));
  // Far off: one 2% step at a time, up or down, never past the target.
  assert.equal(nextRate({ current: e("0.2"), target: e("0.25"), ...step }), e("0.204"));
  assert.equal(nextRate({ current: e("0.2"), target: e("0.1"), ...step }), e("0.196"));
  // The inverted price from earlier (5 XON/USDT vs 0.2) converges in bounded steps, never overshooting.
  let rate = e("5");
  for (let i = 0; i < 500 && rate !== e("0.2"); i++) rate = nextRate({ current: rate, target: e("0.2"), ...step }) ?? rate;
  assert.ok(deviationBps(rate, e("0.2")) <= 50n, `converged to ${ethers.formatEther(rate)}`);
  // Nothing to do without a price, a rate, or any room to step.
  assert.equal(nextRate({ current: 0n, target: e("0.2"), ...step }), null);
  assert.equal(nextRate({ current: e("0.2"), target: 0n, ...step }), null);
  assert.equal(nextRate({ current: e("0.2"), target: e("0.3"), maxStepBps: 0n, deadbandBps: 50n }), null);
  assert.equal(deviationBps(e("0.21"), e("0.2")), 500n);
});

test("a deposit refunded on the gateway is never paid out; older gateways without records are unaffected", async () => {
  const records: Record<string, string> = { "0": ethers.ZeroHash, "1": ethers.id("recorded") };
  const gatewayWithRecords = { depositRecords: async (n: bigint) => records[n.toString()] ?? ethers.ZeroHash };
  assert.equal(await gatewayRecordsDeposits(gatewayWithRecords as never), true);
  assert.equal(await isRefundedOnGateway(gatewayWithRecords as never, 0n, true), true, "record cleared by refund()");
  assert.equal(await isRefundedOnGateway(gatewayWithRecords as never, 1n, true), false, "still recorded");
  assert.equal(await isRefundedOnGateway(gatewayWithRecords as never, undefined, true), false, "no nonce known");
  // An older gateway: the call reverts (no such function) - found out once, at startup.
  const olderGateway = { depositRecords: async () => { throw ethers.makeError("execution reverted", "CALL_EXCEPTION", { action: "call", data: "0x", reason: null, transaction: { to: null, data: "0x" }, invocation: null, revert: null }); } };
  assert.equal(await gatewayRecordsDeposits(olderGateway as never), false);
  assert.equal(await isRefundedOnGateway(olderGateway as never, 0n, false), false);
  // A flaky RPC is NOT an older gateway: it must not read as "not refunded" (and then get paid).
  const flaky = { depositRecords: async () => { throw ethers.makeError("request timeout", "TIMEOUT", { operation: "call", reason: "timeout" }); } };
  await assert.rejects(gatewayRecordsDeposits(flaky as never), /timeout/);
  await assert.rejects(isRefundedOnGateway(flaky as never, 0n, true), /timeout/);

  const parsed = parseGatewayDeposit(gateway.interface, gatewayLog("Deposited", [DEPOSITOR, BENEFICIARY, 5_000_000n, 7n], "0xaa", 0), "ethereum");
  assert.equal(parsed?.gatewayNonce, 7n, "the gateway's own nonce is carried on the deposit");
});

test("a ledger entry carrying any bigint field is written, never thrown on", () => {
  // Regression: gatewayNonce (a bigint) made JSON.stringify throw before the ledger's own error
  // handling, so every poll that recorded a skipped gateway deposit failed and retried forever.
  const file = path.join(tmpDir(), "ledger.jsonl");
  const entry = { adapter: "ethereum", status: "skipped" as const, error: "MinimumNotMet", buyer: BENEFICIARY, usdtAmount: 2_000_000n, minXonOut: 10n ** 24n, gatewayNonce: 7n, sourceChain: "ethereum", sourceTxHash: "0xaa", depositId: "0x01", sourceBlock: 1 };
  assert.doesNotThrow(() => makeLedger(file).record(entry));
  const [r] = readLedger(file);
  assert.deepEqual([r.usdtAmount, r.minXonOut, r.gatewayNonce, r.status], ["2000000", "1000000000000000000000000", "7", "skipped"]);
});

test("a refund is credited to a deposit only when the gateway's Refunded event names that deposit", () => {
  const ev = new ethers.Interface(["event Refunded(uint256 indexed depositNonce, address indexed depositor, uint256 amount)", "event Transfer(address indexed from, address indexed to, uint256 value)"]);
  const refunded = (nonce: bigint, amount: bigint) => ({ address: GATEWAY, ...ev.encodeEventLog("Refunded", [nonce, DEPOSITOR, amount]) });
  const transfer = (amount: bigint) => ({ address: USDT, ...ev.encodeEventLog("Transfer", [GATEWAY, DEPOSITOR, amount]) });
  const target = { payer: DEPOSITOR, usdtAddress: USDT, heldBy: GATEWAY, depositNonce: 3n, recordsDeposits: true };
  // A batch that refunded deposits #2 and #4 of the same payer - plenty of USDT, but not #3.
  const batch = [transfer(2_000_000n), refunded(2n, 2_000_000n), transfer(2_500_000n), refunded(4n, 2_500_000n)];
  assert.equal(refundProven(batch, target, 1_500_000n).ok, false, "regression: the transfer sum alone once let this through");
  assert.equal(refundProven([...batch, transfer(1_500_000n), refunded(3n, 1_500_000n)], target, 1_500_000n).ok, true);
  assert.equal(refundProven([refunded(3n, 1_000_000n)], target, 1_500_000n).ok, false, "less than deposited");
  assert.equal(refundProven([{ ...refunded(3n, 1_500_000n), address: USDT }], target, 1_500_000n).ok, false, "event from another contract");
  // Gateways without deposit records (and Xode) fall back to the amount reaching the payer.
  const older = { ...target, recordsDeposits: false };
  assert.equal(refundProven([transfer(1_500_000n)], older, 1_500_000n).ok, true);
  assert.equal(refundProven([transfer(1_000_000n)], older, 1_500_000n).ok, false);
});

