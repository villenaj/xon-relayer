import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ethers } from "ethers";
import {
  accountToAddress,
  compact,
  decodeExecuteCall,
  decodeXcmSwap,
  encodeExecuteCall,
  encodeXcmSwap,
  encodeXcmSwapOnXode,
  fallbackAccount,
  minXonToPlanck,
  XCM_PRECOMPILE,
  XCM_SWAP_FEE,
  type XcmSwapParams,
} from "../../src/xcmSwap.js";
import { outcomeInEvents, type XodeDex } from "../../src/xodeDex.js";
import ERC20_ABI from "../../src/abi/IERC20.json" with { type: "json" };
import GATEWAY_ABI from "../../src/abi/EthUsdtGateway.json" with { type: "json" };

process.env.VENDING_ADDRESS ??= "0x00000000000000000000000000000000000000aa";
const { ApiError } = await import("../../src/api/http.js");
const { swapInCall, swapStep } = await import("../../src/api/transactions.js");
const { makeApiService } = await import("../../src/api/service.js");
const { config } = await import("../../src/config.js");

// --- The message ---------------------------------------------------------------------------------

// Captured from Polkadot AssetHub (statemint 2005002): its XCM precompile, called from
// 0x5a68...5813 with this program for 2 USDT / minimum 1 planck / topic 0x11..11, dry-ran fine and
// forwarded FORWARDED to para 3417. The runtime's tests (asset_exchanger.rs) run FORWARDED on Xode.
const BUYER = ethers.getAddress("0x5a6836c6d4d293f6e5377e6c28054f4171915813");
const VECTOR: XcmSwapParams = { usdtAmount: 2_000_000n, minXonPlanck: 1n, beneficiaryAccount: fallbackAccount(BUYER), topic: "0x" + "11".repeat(32), paraId: 3417 };
const LOCAL = "0x05082b0105040002043205011f0002127a0001010065351013010300a10f043205011f0002127a000016040d010208000101005a6836c6d4d293f6e5377e6c28054f4171915813eeeeeeeeeeeeeeeeeeeeeeee0f0101010300a10f043205011f000400000004012c1111111111111111111111111111111111111111111111111111111111111111";
const FORWARDED = "0x05180104010300a10f043205011f0002127a000a13010300a10f043205011f0002127a000016040d010208000101005a6836c6d4d293f6e5377e6c28054f4171915813eeeeeeeeeeeeeeeeeeeeeeee0f0101010300a10f043205011f000400000004012c1111111111111111111111111111111111111111111111111111111111111111";

test("the swap program encodes byte for byte as AssetHub produced it, on both chains", () => {
  assert.equal(encodeXcmSwap(VECTOR), LOCAL);
  assert.equal(encodeXcmSwapOnXode(VECTOR), FORWARDED);
  assert.deepEqual(decodeXcmSwap(LOCAL), VECTOR);
});

test("SCALE compact integers match the reference encoding at every width", () => {
  const cases: [bigint, string][] = [[0n, "00"], [1n, "04"], [63n, "fc"], [64n, "0101"], [1984n, "011f"], [3417n, "6535"], [16383n, "fdff"], [16384n, "02000100"], [2_000_000n, "02127a00"], [(1n << 30n) - 1n, "feffffff"], [1n << 30n, "0300000040"], [(1n << 128n) - 1n, "33" + "ff".repeat(16)]];
  for (const [value, hex] of cases) assert.equal(compact(value), hex, `compact(${value})`);
  assert.throws(() => compact(1n << 128n));
  assert.throws(() => compact(-1n));
});

test("decoding round-trips any parameters, and refuses anything that isn't exactly the program", () => {
  const params: XcmSwapParams = { usdtAmount: 123_456_789n, minXonPlanck: 98_765_432_101_234n, beneficiaryAccount: "0x" + "ab".repeat(32), topic: "0x" + "cd".repeat(32), paraId: 2034 };
  assert.deepEqual(decodeXcmSwap(encodeXcmSwap(params)), params);

  // Any one-byte change either fails to decode, or decodes to different parameters that encode
  // back to exactly those bytes: nothing in the message escapes the parameters.
  const bytes = ethers.getBytes(LOCAL);
  for (let i = 0; i < bytes.length; i++) {
    for (const flip of [0x01, 0x80, 0xff]) {
      const mutated = Uint8Array.from(bytes);
      mutated[i] ^= flip;
      const hex = ethers.hexlify(mutated);
      const decoded = decodeXcmSwap(hex);
      if (decoded) {
        assert.notDeepEqual(decoded, VECTOR);
        assert.equal(encodeXcmSwap(decoded), hex, `byte ${i} ^ ${flip}`);
      }
    }
  }
  assert.equal(decodeXcmSwap(LOCAL + "00"), null, "trailing byte");
  assert.equal(decodeXcmSwap(LOCAL.slice(0, -2)), null, "truncated");
  assert.equal(decodeXcmSwap(FORWARDED), null, "the Xode-side message isn't the call's program");
  assert.equal(decodeXcmSwap("0x"), null);
  assert.equal(decodeXcmSwap("not hex"), null);
  // A non-canonical compact (2 written in 2-byte mode) would be a second encoding of the same params.
  assert.equal(decodeXcmSwap(LOCAL.replace("0002043205011f0002127a00", "0002043205011f0003" + "00127a0000")), null);
});

test("the precompile call carries the program and weight and nothing else", () => {
  const data = encodeExecuteCall(LOCAL, { refTime: 625_692_000n, proofSize: 9_604n });
  assert.deepEqual(decodeExecuteCall(data), { message: LOCAL, weight: { refTime: 625_692_000n, proofSize: 9_604n } });
  assert.equal(decodeExecuteCall(data + "00"), null, "trailing calldata");
  assert.equal(decodeExecuteCall("0x12345678"), null);
  assert.deepEqual(swapInCall(data)?.params, VECTOR);
  const other = encodeExecuteCall("0x05040a", { refTime: 1n, proofSize: 1n }); // [ClearOrigin]
  assert.equal(swapInCall(other), null, "an execute of some other XCM isn't a purchase");
});

test("accounts follow pallet-revive's mapper: 0xEE fallback for EVM keys, keccak for Substrate ones", () => {
  assert.equal(fallbackAccount(BUYER), "0x5a6836c6d4d293f6e5377e6c28054f4171915813" + "ee".repeat(12));
  assert.equal(accountToAddress(fallbackAccount(BUYER)), ethers.getAddress(BUYER));
  const substrate = "0x" + "42".repeat(32);
  assert.equal(accountToAddress(substrate), ethers.getAddress(ethers.dataSlice(ethers.keccak256(substrate), 12)));
});

test("an XON minimum in 18 decimals rounds up to planck, never accepting less than asked", () => {
  assert.equal(minXonToPlanck(1_000_000n), 1n);
  assert.equal(minXonToPlanck(1_000_001n), 2n);
  assert.equal(minXonToPlanck(1n), 1n);
  assert.equal(minXonToPlanck(ethers.parseEther("3.5")), 3_500_000_000_000n);
});

// --- Reading the outcome on Xode -------------------------------------------------------------------

const TOPIC = "0x" + "11".repeat(32);
const WHO = fallbackAccount(BUYER);
const v = (s: string) => ({ toString: () => s, toHex: () => s });
const ev = (section: string, method: string, ...data: string[]) => ({ event: { section, method, data: Object.assign(data.map(v), { toJSON: () => data }) } });
const processed = (id: string) => ev("messageQueue", "Processed", id, "{}", "{}", "true");

// An AssetsTrapped event as polkadot-js gives it: [hash, origin, VersionedAssets].
const USDT_ID = { parents: 1, interior: { x3: [{ parachain: 1000 }, { palletInstance: 50 }, { generalIndex: 1984 }] } };
const trapOf = (id: unknown, fungible: number | string) => ({ event: { section: "polkadotXcm", method: "AssetsTrapped", data: Object.assign([v("0x00"), v("{}"), v("{}")], { toJSON: () => ["0x00", { parents: 1, interior: { x1: [{ parachain: 1000 }] } }, { v5: [{ id, fun: { fungible } }] }] }) } });

test("a purchase's outcome is read from its own events only, and only if the amounts add up", () => {
  const AMOUNT = 2_000_000n;
  const POOL = "0x" + "99".repeat(32);
  const swapped = [ev("assets", "Issued", "1984", "0xfee", "10070"), ev("assets", "Deposited", "1984", POOL, "1989930"), ev("assetConversion", "SwapCreditExecuted", "1989930", "19453649435800"), ev("balances", "Minted", WHO, "19453649435800")];
  const block = [
    ev("balances", "Minted", WHO, "999"), // someone else's message, before ours
    processed("0x" + "22".repeat(32)),
    ...swapped,
    processed(TOPIC),
    ev("balances", "Minted", WHO, "5"), // after ours
  ];
  assert.deepEqual(outcomeInEvents(block, TOPIC, WHO, 1984, AMOUNT), { kind: "swapped", xonPlanck: 19_453_649_435_800n, error: null });
  assert.equal(outcomeInEvents(block, "0x" + "33".repeat(32), WHO, 1984, AMOUNT), null, "not in this block");

  const returned = [ev("assets", "Issued", "1984", "0xfee", "10070"), ev("polkadotXcm", "ProcessXcmError", "{}", "NoDeal", TOPIC), ev("assets", "Issued", "1984", WHO, "1989930"), processed(TOPIC)];
  assert.deepEqual(outcomeInEvents(returned, TOPIC, WHO, 1984, AMOUNT), { kind: "returned", usdtAmount: 1_989_930n, error: "NoDeal" });

  assert.deepEqual(outcomeInEvents([ev("polkadotXcm", "ProcessXcmError", "{}", "TooExpensive", TOPIC), trapOf(USDT_ID, 2000000), processed(TOPIC)], TOPIC, WHO, 1984, AMOUNT), { kind: "lost", trapped: true, error: "TooExpensive" });
  // Trapped after Xode took its fee: fee + trap is the whole purchase.
  assert.deepEqual(outcomeInEvents([ev("assets", "Issued", "1984", "0xfee", "10070"), trapOf(USDT_ID, "0x1e5d2a"), processed(TOPIC)], TOPIC, WHO, 1984, AMOUNT), { kind: "lost", trapped: true, error: null });
});

test("someone else's message reusing the topic can't stand in for the purchase", () => {
  const AMOUNT = 2_000_000n;
  // A 0.1 USDT message with the victim's topic, paying someone else, processed first.
  const spoof = [ev("assets", "Issued", "1984", "0xfee", "10070"), ev("assets", "Issued", "1984", "0xattacker", "89930"), processed(TOPIC)];
  // On its own it's only a provisional "lost" - never "swapped"/"returned", and never "trapped".
  const unaccounted = { kind: "lost", trapped: false, error: null };
  assert.deepEqual(outcomeInEvents(spoof, TOPIC, WHO, 1984, AMOUNT), unaccounted);
  // Same amount, but paying someone else.
  const otherPayee = [ev("assets", "Issued", "1984", "0xfee", "10070"), ev("assets", "Issued", "1984", "0xattacker", "1989930"), processed(TOPIC)];
  assert.deepEqual(outcomeInEvents(otherPayee, TOPIC, WHO, 1984, AMOUNT), unaccounted);
  // A trap of another amount isn't this purchase's.
  assert.deepEqual(outcomeInEvents([trapOf(USDT_ID, 5000), processed(TOPIC)], TOPIC, WHO, 1984, AMOUNT), unaccounted);
  // Nor is a trap of the same number of another asset, or of an amount that merely starts the same.
  const DOT_ID = { parents: 1, interior: "Here" };
  assert.deepEqual(outcomeInEvents([trapOf(DOT_ID, 2000000), processed(TOPIC)], TOPIC, WHO, 1984, AMOUNT), unaccounted);
  assert.deepEqual(outcomeInEvents([trapOf(USDT_ID, 20000005), processed(TOPIC)], TOPIC, WHO, 1984, AMOUNT), unaccounted);
  // A planted trap before the real purchase, in the same block: the real one wins.
  assert.equal(outcomeInEvents([trapOf(USDT_ID, 2000000), processed(TOPIC), ...[ev("assets", "Issued", "1984", "0xfee", "10070"), ev("assets", "Issued", "1984", WHO, "1989930"), processed(TOPIC)]], TOPIC, WHO, 1984, AMOUNT)?.kind, "returned");
  // The real one, after the spoof in the same block, is still found.
  const real = [ev("assets", "Issued", "1984", "0xfee", "10070"), ev("assets", "Issued", "1984", WHO, "1989930"), processed(TOPIC)];
  assert.equal(outcomeInEvents([...spoof, ...real], TOPIC, WHO, 1984, AMOUNT)?.kind, "returned");
  // A Minted to the beneficiary from an extrinsic (another phase) isn't counted.
  const phased = (r: ReturnType<typeof ev>, phase: string) => ({ ...r, phase: { toString: () => phase } });
  const mixed = [phased(ev("balances", "Minted", WHO, "7"), "ApplyExtrinsic(1)"), ...[ev("assets", "Issued", "1984", "0xfee", "10070"), ev("assets", "Issued", "1984", WHO, "1989930"), processed(TOPIC)].map((r) => phased(r, "Finalization"))];
  assert.equal(outcomeInEvents(mixed, TOPIC, WHO, 1984, AMOUNT)?.kind, "returned");
});

// --- The API ---------------------------------------------------------------------------------------

const USDT = ethers.getAddress("0x00000000000000000000000000000000000000aa");
const GATEWAY = ethers.getAddress("0x00000000000000000000000000000000000000cc");
const WEIGHT: [bigint, bigint] = [625_692_000n, 9_604n];
const XON_PER_USDT = 195n * 10n ** 18n;
const precompile = new ethers.Interface(["function weighMessage(bytes message) view returns ((uint64 refTime, uint64 proofSize) weight)"]);

interface Harness {
  dryRuns: string[];
  estimates: { from?: string; data?: string }[];
  dex: XodeDex;
  service: ReturnType<typeof makeApiService>;
}

function harness(opts: { usdtBalance?: bigint; dryRun?: boolean; estimateFails?: boolean; mapped?: string; paused?: boolean; outcome?: Awaited<ReturnType<XodeDex["findXcmSwapOutcome"]>>; tx?: { data: string } } = {}): Harness {
  const dryRuns: string[] = [];
  const estimates: { from?: string; data?: string }[] = [];
  const dex: XodeDex = {
    quoteUsdtToXon: async (usdt) => (usdt * XON_PER_USDT) / 1_000_000n,
    spotXonPerUsdt: async () => XON_PER_USDT,
    swapsPaused: async () => opts.paused ?? false,
    poolActive: async () => true,
    accountOf: async (address) => opts.mapped ?? fallbackAccount(address),
    existentialDeposit: () => 1_000_000_000n,
    dryRunFromAssetHub: async (message) => {
      dryRuns.push(message);
      return opts.dryRun === false ? { complete: false, error: "NoDeal" } : { complete: true, error: null };
    },
    finalizedHead: async () => 1_000,
    blockAtOrBefore: async () => 900,
    findXcmSwapOutcome: async () => opts.outcome ?? null,
    disconnect: async () => {},
  };
  const provider = {
    call: async (tx: { data: string }) => {
      assert.equal(tx.data.slice(0, 10), precompile.getFunction("weighMessage")!.selector);
      return precompile.encodeFunctionResult("weighMessage", [WEIGHT]);
    },
    estimateGas: async (tx: { from?: string; data?: string }) => {
      estimates.push(tx);
      if (opts.estimateFails) throw Object.assign(new Error("reverted"), { shortMessage: "execution reverted" });
      return 3_105n;
    },
    getTransactionReceipt: async (hash: string) => ({ hash, blockNumber: 50, blockHash: "0xbb", status: 1, to: XCM_PRECOMPILE, from: BUYER, logs: [], contractAddress: null, gasUsed: 1n, gasPrice: 1n }),
    getTransaction: async () => opts.tx ?? null,
    getBlockNumber: async () => 60,
    getBlock: async (tag: unknown) => (tag === "finalized" ? { number: 55 } : { number: 50, timestamp: 1_700_000_000 }),
  };
  const usdt = Object.assign(new ethers.Contract(USDT, ERC20_ABI), { balanceOf: async () => opts.usdtBalance ?? 10_000_000n });
  const assethub = {
    name: "assethub" as const,
    chainId: 420420419n,
    provider,
    nativeSymbol: "DOT",
    confirmations: "finalized" as const,
    usdt,
    usdtAddress: USDT,
    payTo: GATEWAY,
    gateway: new ethers.Contract(GATEWAY, GATEWAY_ABI),
    approveResetsToZero: false,
    xcmSwap: { paraId: 3417 },
  };
  const networks = { xode: { ...assethub, name: "xode" as const, gateway: null, xcmSwap: null }, vending: {}, byName: new Map([["assethub", assethub]]) };
  const cfg = { ...config, xcmPurchasesFile: path.join(mkdtempSync(path.join(tmpdir(), "xcm-")), "xcm.jsonl"), ledgerFile: "/nonexistent/ledger.jsonl" };
  // Only what the XCM paths touch is real; the rest is never reached by these tests.
  const service = makeApiService(cfg, networks as never, dex);
  return { dryRuns, estimates, dex, service };
}

async function apiError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof ApiError ? err.code : `not an ApiError: ${(err as Error).message}`;
  }
  return "no error";
}

const BENEFICIARY = "0x2222222222222222222222222222222222222222";

test("a market-price purchase from AssetHub is one checked XCM call, with no approval", async () => {
  const h = harness();
  const prepared = (await h.service.prepareBuy({ network: "assethub", from: BUYER, amount: "2", beneficiary: BENEFICIARY, minXonOut: "300" })) as Record<string, any>;

  assert.equal(prepared.payout, "swap");
  assert.equal(prepared.route, "xcm");
  assert.deepEqual(prepared.steps.map((s: { kind: string }) => s.kind), ["swap"]);
  const { tx } = prepared.steps[0];
  assert.equal(tx.to, XCM_PRECOMPILE);
  assert.equal(tx.value, "0x0");
  assert.equal(tx.chainId, ethers.toQuantity(420420419n));

  const swap = swapInCall(tx.data)!;
  assert.equal(swap.params.usdtAmount, 2_000_000n);
  assert.equal(swap.params.minXonPlanck, 300_000_000_000_000n);
  assert.equal(swap.params.beneficiaryAccount, fallbackAccount(BENEFICIARY));
  assert.equal(swap.params.paraId, 3417);
  assert.deepEqual(swap.weight, { refTime: WEIGHT[0], proofSize: WEIGHT[1] });
  assert.deepEqual(prepared.xcm, { beneficiaryAccount: swap.params.beneficiaryAccount, topic: swap.params.topic, paraId: 3417, minXonPlanck: "300000000000000" });
  assert.equal(prepared.refundFee.raw, XCM_SWAP_FEE);

  // Checked on both chains with exactly what's handed out.
  assert.deepEqual(h.dryRuns, [encodeXcmSwapOnXode(swap.params)]);
  assert.equal(h.estimates[0].data, tx.data);
  assert.equal(h.estimates[0].from, BUYER);

  // A fresh topic per purchase, so each can be found on Xode.
  const again = (await h.service.prepareBuy({ network: "assethub", from: BUYER, amount: "2", beneficiary: BENEFICIARY, minXonOut: "300" })) as Record<string, any>;
  assert.notEqual(swapInCall(again.steps[0].tx.data)!.params.topic, swap.params.topic);
});

test("the quote and the slippage minimum are for the USDT left after Xode's fee", async () => {
  const h = harness();
  const prepared = (await h.service.prepareBuy({ network: "assethub", from: BUYER, amount: "2", slippageBps: 100 })) as Record<string, any>;
  const quoted = ((2_000_000n - XCM_SWAP_FEE) * XON_PER_USDT) / 1_000_000n;
  assert.equal(prepared.xonAmount.raw, quoted);
  assert.equal(prepared.minXonOut.raw, (quoted * 9_900n) / 10_000n);
  assert.equal(prepared.beneficiary, BUYER, "defaults to the sender");
});

test("a Substrate account mapped on Xode is paid directly; a mapping that isn't the address's is refused", async () => {
  const substrate = "0x" + "42".repeat(32);
  const owner = accountToAddress(substrate);
  const ok = (await harness({ mapped: substrate }).service.prepareBuy({ network: "assethub", from: BUYER, amount: "2", beneficiary: owner, minXonOut: "1" })) as Record<string, any>;
  assert.equal(ok.xcm.beneficiaryAccount, substrate);

  await assert.rejects(harness({ mapped: substrate }).service.prepareBuy({ network: "assethub", from: BUYER, amount: "2", beneficiary: BENEFICIARY, minXonOut: "1" }), /isn't that address's account/);
});

test("purchases that could strand funds, or wouldn't go through, are refused before signing", async () => {
  const buy = (h: Harness, body: Record<string, unknown>) => h.service.prepareBuy({ network: "assethub", from: BUYER, amount: "2", minXonOut: "1", ...body });
  assert.equal(await apiError(buy(harness(), { amount: "0.09" })), "BelowMinimumDeposit", "a failed swap's leftover must stay above USDT's minimum balance");
  assert.equal(await apiError(buy(harness(), { minXonOut: "0.0009" })), "MinimumTooSmall", "below XON's existential deposit");
  assert.equal(await apiError(buy(harness({ dryRun: false }), {})), "SwapUnavailable");
  assert.equal(await apiError(buy(harness({ dryRun: false, paused: true }), {})), "SwapUnavailable");
  assert.equal(await apiError(buy(harness({ estimateFails: true }), {})), "SwapRejected");
  assert.equal(await apiError(buy(harness({ usdtBalance: 1n }), {})), "InsufficientUsdt");
  assert.equal(await apiError(harness().service.prepareDeposit({ network: "assethub", from: BUYER, amount: "2", minXonOut: "1" })), "UseBuy", "no gateway depositForSwap on the XCM route");
});

test("only the purchase program goes to the precompile through broadcast", async () => {
  const h = harness();
  const wallet = ethers.Wallet.createRandom();
  const sign = (data: string) => wallet.signTransaction({ to: XCM_PRECOMPILE, data, chainId: 420420419n, nonce: 0, gasLimit: 100_000n, gasPrice: 1n });
  const other = encodeExecuteCall("0x05040a", { refTime: 1n, proofSize: 1n });
  assert.equal(await apiError(h.service.broadcast({ network: "assethub", signedTx: await sign(other) })), "UnsupportedTransaction");
  const wrongPara = encodeExecuteCall(encodeXcmSwap({ ...VECTOR, paraId: 2034 }), { refTime: 1n, proofSize: 1n });
  assert.equal(await apiError(h.service.broadcast({ network: "assethub", signedTx: await sign(wrongPara) })), "UnsupportedTransaction");
});

test("an XCM purchase's status comes from Xode, and settled ones join the address's history", async () => {
  const data = encodeExecuteCall(encodeXcmSwap({ ...VECTOR, beneficiaryAccount: fallbackAccount(BENEFICIARY) }), { refTime: 1n, proofSize: 1n });
  const hash = "0x" + "ab".repeat(32);

  const pending = await harness({ tx: { data } }).service.txStatus("assethub", hash);
  assert.equal(pending.deposits[0].state, "settling");
  assert.equal(pending.deposits[0].beneficiary, ethers.getAddress(BENEFICIARY));
  assert.equal(pending.deposits[0].depositId, VECTOR.topic);

  const settled = harness({ tx: { data }, outcome: { kind: "swapped", xonPlanck: 19_453_649_435_800n, error: null, blockNumber: 950, blockHash: "0xcc" } });
  const status = await settled.service.txStatus("assethub", hash);
  assert.equal(status.deposits[0].state, "settled");
  assert.equal(status.deposits[0].xonAmount?.raw, 19_453_649_435_800n * 1_000_000n);
  const history = settled.service.deposits(BENEFICIARY).deposits;
  assert.equal(history.length, 1);
  assert.equal(history[0].sourceTxHash, hash);
  assert.equal(history[0].state, "settled");

  const returned = await harness({ tx: { data }, outcome: { kind: "returned", usdtAmount: 1_989_930n, error: "NoDeal", blockNumber: 950, blockHash: "0xcc" } }).service.txStatus("assethub", hash);
  assert.equal(returned.deposits[0].state, "refunded");
  assert.match(returned.deposits[0].error ?? "", /1\.98993 USDT .* on Xode/);

  // "Lost" is only believed once the blocks after it show nothing better: found at 940 with 900-949
  // searched, it's still "settling"; after 950-999 as well, it's reported.
  const lost = harness({ tx: { data }, outcome: { kind: "lost", trapped: true, error: "TooExpensive", blockNumber: 940, blockHash: "0xdd" } });
  const lostHash = "0x" + "ac".repeat(32);
  assert.equal((await lost.service.txStatus("assethub", lostHash)).deposits[0].state, "settling");
  const reported = await lost.service.txStatus("assethub", lostHash);
  assert.equal(reported.deposits[0].state, "skipped");
  assert.match(reported.deposits[0].error ?? "", /asset trap/);

  // Someone else's XCM through the precompile isn't a purchase.
  const foreign = await harness({ tx: { data: encodeExecuteCall("0x05040a", { refTime: 1n, proofSize: 1n }) } }).service.txStatus("assethub", hash);
  assert.deepEqual(foreign.deposits, []);
});

test("swapStep refuses a program built for another para", () => {
  const net = { name: "assethub" as const, chainId: 1n, usdt: new ethers.Contract(USDT, ERC20_ABI), usdtAddress: USDT, payTo: GATEWAY, gateway: null, approveResetsToZero: false, xcmSwap: { paraId: 3417 } };
  assert.throws(() => swapStep(net, BUYER, { ...VECTOR, paraId: 2034 }, { refTime: 1n, proofSize: 1n }, BUYER));
  assert.throws(() => swapStep({ ...net, xcmSwap: null }, BUYER, VECTOR, { refTime: 1n, proofSize: 1n }, BUYER));
});
