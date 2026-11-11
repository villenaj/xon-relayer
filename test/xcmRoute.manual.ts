// Manual, live end-to-end test of market-price purchases from AssetHub over XCM (src/xcmSwap.ts):
// the API prepares the one XCM precompile call, a buyer's EVM key signs it on AssetHub, the USDT
// crosses to Xode and is swapped on the DEX on arrival, and the API reads the outcome back.
//
// Not a unit test - it needs the local stack running (zombienet's start.sh: relay + AssetHub +
// Xode on a runtime with the XCM AssetExchanger, both eth-rpc bridges) and the contracts from
// `npm run setup` (setup.out.env), plus an approved XON/USDT pool with liquidity on Xode.
//
// It opens the AssetHub <-> Xode HRMP channels itself if they're missing (relay sudo, //Alice).
//
// Usage: npm run test:xcm

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, encodeAddress } from "@polkadot/util-crypto";
import { parse as parseEnv } from "dotenv";
import { ethers } from "ethers";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { KeyringPair } from "@polkadot/keyring/types";
import { encodeExecuteCall, encodeXcmSwap, fallbackAccount, newTopic, XCM_PRECOMPILE, xcmPrecompile } from "../src/xcmSwap.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const RELAY_WS = process.env.RELAY_WS ?? "ws://127.0.0.1:9911";
const XODE_WS = process.env.XODE_WS ?? "ws://127.0.0.1:9977";
const ASSETHUB_WS = process.env.ASSETHUB_WS ?? "ws://127.0.0.1:9955";
const API_PORT = process.env.TEST_API_PORT ?? "18080";
const API = `http://127.0.0.1:${API_PORT}`;
const XODE_PARA = 3417;
const ASSET_HUB_PARA = 1000;
const ASSET_ID = 1984;
/// Where Xode's XCM weight trader sends the fees it takes (runtime: xcm_config/weight_trader.rs).
const XODE_FEE_COLLECTOR = "5Fqc6tG16FcR4QLwknqs5sb9Pc6pqsNwtwcPh7fNKCaP4DJT";
const USDT = (whole: string) => ethers.parseUnits(whole, 6);

function submit(api: ApiPromise, tx: SubmittableExtrinsic<"promise">, signer: KeyringPair): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.signAndSend(signer, (r) => {
      if (r.dispatchError) {
        reject(new Error(r.dispatchError.isModule ? api.registry.findMetaError(r.dispatchError.asModule).name : r.dispatchError.toString()));
      } else if (r.status.isInBlock || r.status.isFinalized) {
        // A sudo call reports its inner failure as an event, not a dispatch error.
        const sudid = r.events.find(({ event }) => event.section === "sudo" && event.method === "Sudid");
        const inner = sudid?.event.data[0] as unknown as { isErr: boolean; asErr: { toString(): string } } | undefined;
        if (inner?.isErr) reject(new Error(`sudo call failed: ${inner.asErr.toString()}`));
        else resolve();
      }
    }).catch(reject);
  });
}

function ss58Of(account: string): string {
  return encodeAddress(ethers.getBytes(account), 42);
}

/// The account a sibling parachain's assets are held in ("sibl" + para id, little-endian).
function siblingAccount(paraId: number): string {
  const raw = new Uint8Array(32);
  raw.set(new TextEncoder().encode("sibl"), 0);
  new DataView(raw.buffer).setUint32(4, paraId, true);
  return ethers.hexlify(raw);
}

async function get(pathname: string): Promise<any> {
  const res = await fetch(API + pathname);
  const body = await res.json();
  if (!res.ok) throw new Error(`GET ${pathname}: ${res.status} ${JSON.stringify(body)}`);
  return body;
}
async function post(pathname: string, payload: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(API + pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return { status: res.status, body: await res.json() };
}

async function waitFor<T>(what: string, check: () => Promise<T | null>, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function main(): Promise<void> {
  await cryptoWaitReady();
  const alice = new Keyring({ type: "sr25519" }).addFromUri("//Alice");
  const relay = await ApiPromise.create({ provider: new WsProvider(RELAY_WS), noInitWarn: true });
  const xode = await ApiPromise.create({ provider: new WsProvider(XODE_WS), noInitWarn: true });
  const assetHub = await ApiPromise.create({ provider: new WsProvider(ASSETHUB_WS), noInitWarn: true });
  const setup = parseEnv(readFileSync(path.join(REPO, process.env.SETUP_OUTPUT ?? "setup.out.env")));
  const ahProvider = new ethers.JsonRpcProvider(setup.ASSETHUB_EVM_RPC);
  const xodeProvider = new ethers.JsonRpcProvider(setup.XODE_ETH_RPC);
  console.log(`Xode runtime spec ${xode.runtimeVersion.specVersion}, AssetHub ${assetHub.runtimeVersion.specName} ${assetHub.runtimeVersion.specVersion}`);

  // --- HRMP channels AssetHub <-> Xode -------------------------------------------------------
  const channelOpen = async (sender: number, recipient: number) => (await relay.query.hrmp.hrmpChannels({ sender, recipient })).isEmpty === false;
  for (const [sender, recipient] of [[ASSET_HUB_PARA, XODE_PARA], [XODE_PARA, ASSET_HUB_PARA]]) {
    if (await channelOpen(sender, recipient)) continue;
    console.log(`Opening HRMP channel ${sender} -> ${recipient} (relay sudo)...`);
    const cfg = (await relay.query.configuration.activeConfig()).toJSON() as { hrmpChannelMaxCapacity: number; hrmpChannelMaxMessageSize: number };
    await submit(relay, relay.tx.sudo.sudo(relay.tx.hrmp.forceOpenHrmpChannel(sender, recipient, cfg.hrmpChannelMaxCapacity, cfg.hrmpChannelMaxMessageSize)), alice);
    await submit(relay, relay.tx.sudo.sudo(relay.tx.hrmp.forceProcessHrmpOpen(2)), alice);
    await waitFor(`channel ${sender} -> ${recipient}`, async () => ((await channelOpen(sender, recipient)) ? true : null));
  }
  console.log("HRMP channels open.");

  // --- Accounts --------------------------------------------------------------------------------
  const buyer = ethers.Wallet.createRandom().connect(ahProvider);
  const buyerAccount = fallbackAccount(buyer.address);
  console.log("buyer:", buyer.address);
  const ahUnit = 10n ** BigInt(assetHub.registry.chainDecimals[0]);
  // Xode's reserve account on AssetHub has to exist to hold the USDT (not a sufficient asset here).
  await submit(assetHub, assetHub.tx.utility.batchAll([
    assetHub.tx.balances.transferKeepAlive(ss58Of(siblingAccount(XODE_PARA)), 10n * ahUnit),
    assetHub.tx.balances.transferKeepAlive(ss58Of(buyerAccount), 100n * ahUnit),
    assetHub.tx.assets.mint(ASSET_ID, ss58Of(buyerAccount), USDT("50")),
  ]), alice);

  // Xode pays its XCM execution fee (taken from the USDT) to a fixed collector account. Where USDT
  // isn't a sufficient asset - this dev chain; on mainnet it is - that account has to exist already,
  // or every USDT-paid message fails at BuyExecution and its assets are trapped.
  const collector = await xode.query.system.account(XODE_FEE_COLLECTOR);
  if ((collector as unknown as { data: { free: { isZero(): boolean } } }).data.free.isZero()) {
    console.log("Funding Xode's XCM fee collector so it can receive USDT...");
    await submit(xode, xode.tx.balances.transferKeepAlive(XODE_FEE_COLLECTOR, 10n ** BigInt(xode.registry.chainDecimals[0])), alice);
  }

  // --- The API ---------------------------------------------------------------------------------
  const stateDir = mkdtempSync(path.join(tmpdir(), "xon-xcm-test-"));
  const apiProc = spawn(process.execPath, ["--import", "tsx", "src/api/index.ts"], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      XODE_ETH_RPC: setup.XODE_ETH_RPC, VENDING_ADDRESS: setup.VENDING_ADDRESS,
      ASSETHUB_EVM_RPC: setup.ASSETHUB_EVM_RPC, ASSETHUB_GATEWAY_ADDRESS: setup.ASSETHUB_GATEWAY_ADDRESS,
      // Isolate the run from a developer .env: no Ethereum leg, no keys, no chain IDs.
      ETHEREUM_RPC: "", ETH_GATEWAY_ADDRESS: "", ENABLE_ETHEREUM_ADAPTER: "false", RELAYER_PRIVATE_KEY: "", RATE_KEEPER_PRIVATE_KEY: "",
      XODE_CHAIN_ID: "", ASSETHUB_CHAIN_ID: "", ETHEREUM_CHAIN_ID: "", API_HOST: "127.0.0.1", API_CORS_ORIGINS: "",
      ASSETHUB_CONFIRMATIONS: "0", CONFIRMATIONS: "0",
      XODE_SUBSTRATE_RPC: XODE_WS, ASSETHUB_MARKET_ROUTE: "xcm",
      API_PORT, CHECKPOINT_DIR: stateDir, LEDGER_FILE: path.join(stateDir, "ledger.jsonl"), XCM_PURCHASES_FILE: path.join(stateDir, "xcm-purchases.jsonl"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  apiProc.stdout.on("data", (d: Buffer) => process.stdout.write(`[api] ${d}`));
  apiProc.stderr.on("data", (d: Buffer) => process.stderr.write(`[api] ${d}`));
  let failed = false;
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "PASS" : "FAIL"}: ${what}`);
    if (!ok) failed = true;
  };

  try {
    await waitFor("the API", async () => { if (apiProc.exitCode !== null) throw new Error("the API exited"); return fetch(`${API}/api/health`).then((r) => (r.ok ? true : null), () => null); }, 60_000);

    // --- 1. A purchase that swaps ---------------------------------------------------------------
    const config = await get("/api/config");
    const ah = config.networks.find((n: { name: string }) => n.name === "assethub");
    check(ah?.marketRoute === "xcm", `the API offers AssetHub market price over XCM (marketRoute=${ah?.marketRoute})`);

    const quote = await get("/api/quote?amount=2&network=assethub&slippageBps=100");
    check(quote.swap?.route === "xcm", `quote: 2 USDT -> ${quote.swap?.xonAmount?.formatted} XON, minimum ${quote.swap?.minXonOut?.formatted}`);

    const prepared = await post("/api/tx/buy", { network: "assethub", from: buyer.address, amount: "2", slippageBps: 100 });
    check(prepared.status === 200 && prepared.body.steps?.length === 1 && prepared.body.steps[0].kind === "swap", `prepared one swap step (${prepared.status}${prepared.status === 200 ? "" : ` ${JSON.stringify(prepared.body)}`})`);
    const step = prepared.body.steps[0].tx;
    // Read from Substrate: the EVM RPC reports an account's balance less the existential deposit.
    const freeXon = async () => ((await xode.query.system.account(buyerAccount)) as unknown as { data: { free: { toBigInt(): bigint } } }).data.free.toBigInt() * 1_000_000n;
    const xonBefore = await freeXon();
    const sent = await buyer.sendTransaction({ to: step.to, data: step.data });
    const receipt = await sent.wait();
    console.log("AssetHub tx:", sent.hash, "status", receipt?.status);

    const settled = await waitFor("the purchase to settle on Xode", async () => {
      const status = await get(`/api/tx/assethub/${sent.hash}`);
      const state = status.deposits?.[0]?.state;
      console.log("  state:", state ?? "(no deposit)");
      return state && state !== "settling" && state !== "awaiting-confirmations" ? status.deposits[0] : null;
    });
    const xonAfter = await freeXon();
    check(settled.state === "settled", `status is settled (${settled.state}${settled.error ? `: ${settled.error}` : ""})`);
    check(settled.state === "settled" && xonAfter - xonBefore === BigInt(settled.xonAmount.raw), `buyer received exactly the reported ${settled.xonAmount?.formatted} XON on Xode (balance +${ethers.formatEther(xonAfter - xonBefore)})`);
    check(xonAfter - xonBefore >= BigInt(prepared.body.minXonOut.raw), "that is at least the minimum");

    const history = await get(`/api/deposits/${buyer.address}`);
    check(history.deposits.some((d: { sourceTxHash: string; state: string }) => d.sourceTxHash === sent.hash && d.state === "settled"), "the purchase is in the buyer's history");

    // --- 2. The API refuses a purchase the pool can't meet -----------------------------------------
    const tooMuch = await post("/api/tx/buy", { network: "assethub", from: buyer.address, amount: "2", minXonOut: "1000000" });
    check(tooMuch.status === 422, `a minimum the pool can't meet is refused before signing (${tooMuch.status} ${tooMuch.body?.error ?? ""})`);

    // --- 3. A swap that fails on Xode leaves the USDT with the buyer there -------------------------
    // Built by hand (the API wouldn't prepare it): same program, impossible minimum.
    const usdtOnXode = new ethers.Contract(config.networks.find((n: { name: string }) => n.name === "xode").usdtAddress, ["function balanceOf(address) view returns (uint256)"], xodeProvider);
    const usdtBefore: bigint = await usdtOnXode.balanceOf(buyer.address);
    const params = { usdtAmount: USDT("3"), minXonPlanck: 10n ** 24n, beneficiaryAccount: buyerAccount, topic: newTopic(), paraId: XODE_PARA };
    const message = encodeXcmSwap(params);
    const [refTime, proofSize] = xcmPrecompile.decodeFunctionResult("weighMessage", await ahProvider.call({ to: XCM_PRECOMPILE, data: xcmPrecompile.encodeFunctionData("weighMessage", [message]) }))[0] as [bigint, bigint];
    const failing = await buyer.sendTransaction({ to: XCM_PRECOMPILE, data: encodeExecuteCall(message, { refTime, proofSize }) });
    await failing.wait();
    console.log("AssetHub tx (unmeetable minimum):", failing.hash);
    const returned = await waitFor("the failed swap's outcome on Xode", async () => {
      const status = await get(`/api/tx/assethub/${failing.hash}`);
      const state = status.deposits?.[0]?.state;
      console.log("  state:", state ?? "(no deposit)");
      return state && state !== "settling" && state !== "awaiting-confirmations" ? status.deposits[0] : null;
    });
    const usdtAfter: bigint = await usdtOnXode.balanceOf(buyer.address);
    check(returned.state === "refunded", `status is refunded (${returned.state}: ${returned.error ?? ""})`);
    check(usdtAfter - usdtBefore > 0n && usdtAfter - usdtBefore < USDT("3"), `buyer holds the USDT on Xode, less Xode's fee (+${ethers.formatUnits(usdtAfter - usdtBefore, 6)} USDT)`);

    console.log(failed ? "\nFAILURE" : "\nSUCCESS: market-price purchases from AssetHub over XCM work end to end.");
    process.exitCode = failed ? 1 : 0;
  } finally {
    apiProc.kill();
    await Promise.all([relay.disconnect(), xode.disconnect(), assetHub.disconnect()]);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
