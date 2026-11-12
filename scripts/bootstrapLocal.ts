// Brings a freshly started local stack (zombienet's `start.sh --clean`) to the state the relayer,
// the API and the live tests need. The local Xode node starts on its built-in genesis runtime,
// with no USDT asset, no DEX pool and no channel to AssetHub. In order, each step skipped if done:
//
//   1. upgrade   Xode's runtime to the given wasm, through the technical committee (the chain has
//                no sudo): whitelist `system.authorizeUpgrade`, dispatch it, apply the code.
//   2. pool      create the XON/USDT pool (needs the USDT asset - run `npm run setup` first),
//                approve it with two committee members, and add liquidity.
//   2b. unpause the DEX's swap calls, which genesis pauses (technical committee).
//   3. channels  open the AssetHub <-> Xode HRMP channels (relay sudo).
//   4. collector fund Xode's XCM fee collector, so it can receive USDT fees (USDT isn't a
//                sufficient asset on the dev chain; on mainnet it is).
//
// Dev keys only (//Alice, //Bob, //Charlie): it refuses a chain whose committee isn't made of them.
//
// Usage:
//   npm run bootstrap -- upgrade            # then: npm run setup
//   npm run bootstrap                       # pool, channels, collector (after npm run setup)
// Env: XODE_WS, ASSETHUB_WS, RELAY_WS, XODE_RUNTIME_WASM, POOL_XON (default 2000), POOL_USDT (default 10000)

import { ApiPromise, WsProvider } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import { Keyring } from "@polkadot/keyring";
import type { KeyringPair } from "@polkadot/keyring/types";
import { blake2AsHex, cryptoWaitReady } from "@polkadot/util-crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const XODE_WS = process.env.XODE_WS ?? "ws://127.0.0.1:9977";
const RELAY_WS = process.env.RELAY_WS ?? "ws://127.0.0.1:9911";
const WASM = process.env.XODE_RUNTIME_WASM
  ?? path.resolve(REPO, "../../villenaj/xode-blockchain/target/release/wbuild/xode-runtime/xode_runtime.compact.compressed.wasm");
const XODE_PARA = 3417;
const ASSET_HUB_PARA = 1000;
const USDT_ID = 1984;
const POOL_XON = BigInt(process.env.POOL_XON ?? "2000");
const POOL_USDT = BigInt(process.env.POOL_USDT ?? "10000");
/// Where Xode's XCM weight trader sends the fees it takes (runtime: xcm_config/weight_trader.rs).
const XODE_FEE_COLLECTOR = "5Fqc6tG16FcR4QLwknqs5sb9Pc6pqsNwtwcPh7fNKCaP4DJT";
// How the DEX keys the two assets (runtime: xcm_config/asset_exchanger.rs).
const XON = { parents: 1, interior: "Here" };
const USDT = { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: USDT_ID }] } };

type Tx = SubmittableExtrinsic<"promise">;

/// Submits and waits for inclusion; rejects on a dispatch error. Returns the block's events.
function submit(api: ApiPromise, tx: Tx, signer: KeyringPair): Promise<{ section: string; method: string; data: unknown[] }[]> {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, { nonce: -1 }, (r) => {
      if (r.dispatchError) {
        reject(new Error(r.dispatchError.isModule ? `${api.registry.findMetaError(r.dispatchError.asModule).section}.${api.registry.findMetaError(r.dispatchError.asModule).name}` : r.dispatchError.toString()));
      } else if (r.status.isInBlock || r.status.isFinalized) {
        const events = r.events.map(({ event }) => ({ section: event.section, method: event.method, data: [...event.data] as unknown[] }));
        const sudid = r.events.find(({ event }) => event.section === "sudo" && event.method === "Sudid");
        const inner = sudid?.event.data[0] as unknown as { isErr: boolean; asErr: { toString(): string } } | undefined;
        if (inner?.isErr) reject(new Error(`sudo call failed: ${inner.asErr.toString()}`));
        else resolve(events);
      }
    }).catch(reject);
  });
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 6000));
  }
}

/// Passes `call` through the technical committee: proposed by the first member, approved by all,
/// closed (which executes it). Fails if the motion itself was not approved or its call failed.
async function committeeMotion(api: ApiPromise, members: KeyringPair[], call: Tx, what: string): Promise<void> {
  const length = call.method.encodedLength + 4;
  const events = await submit(api, api.tx.technicalCommittee.propose(members.length, call, length), members[0]);
  const proposed = events.find((e) => e.section === "technicalCommittee" && e.method === "Proposed");
  if (!proposed) throw new Error(`${what}: the motion wasn't proposed.`);
  const index = proposed.data[1] as { toString(): string };
  const hash = proposed.data[2] as { toHex(): string };
  for (const member of members) {
    await submit(api, api.tx.technicalCommittee.vote(hash.toHex(), index.toString(), true), member).catch((err: Error) => {
      if (!/DuplicateVote/.test(err.message)) throw err;
    });
  }
  const closed = await submit(api, api.tx.technicalCommittee.close(hash.toHex(), index.toString(), { refTime: 100_000_000_000n, proofSize: 1_000_000n }, length), members[0]);
  const executed = closed.find((e) => e.section === "technicalCommittee" && e.method === "Executed");
  const result = executed?.data[1] as { isErr: boolean; asErr: { toString(): string } } | undefined;
  if (!executed || result?.isErr) throw new Error(`${what}: the motion ${executed ? `failed (${result!.asErr.toString()})` : "wasn't executed"}.`);
  console.log(`[xode] committee motion passed: ${what}`);
}

async function upgrade(xode: ApiPromise, members: KeyringPair[]): Promise<void> {
  if (!existsSync(WASM)) throw new Error(`No runtime wasm at ${WASM} - build it (cargo build --release -p xode-runtime) or set XODE_RUNTIME_WASM.`);
  const wasm = readFileSync(WASM);
  const codeHash = blake2AsHex(wasm, 256);
  const before = xode.runtimeVersion.specVersion.toNumber();
  console.log(`[xode] runtime spec ${before}; upgrading to ${path.basename(WASM)} (${wasm.length} bytes, hash ${codeHash})`);

  // Root, the committee's way: whitelist the call's hash, then dispatch the whitelisted call.
  const authorize = xode.tx.system.authorizeUpgrade(codeHash);
  await committeeMotion(xode, members, xode.tx.whitelist.whitelistCall(authorize.method.hash), "whitelist system.authorizeUpgrade");
  await committeeMotion(xode, members, xode.tx.whitelist.dispatchWhitelistedCallWithPreimage(authorize.method), "dispatch system.authorizeUpgrade");
  await submit(xode, xode.tx.system.applyAuthorizedUpgrade(`0x${wasm.toString("hex")}`), members[0]);
  console.log("[xode] new code submitted; waiting for the relay chain to enact it (a few minutes)...");
  await waitFor("the runtime upgrade", async () => (await xode.rpc.state.getRuntimeVersion()).specVersion.toNumber() !== before, 15 * 60_000);
  console.log(`[xode] runtime is now spec ${(await xode.rpc.state.getRuntimeVersion()).specVersion.toNumber()}`);
}

async function pool(xode: ApiPromise, members: KeyringPair[]): Promise<void> {
  const [alice, bob, charlie] = members;
  if ((await xode.query.assets.asset(USDT_ID)).isEmpty) throw new Error("Xode has no USDT asset yet - run `npm run setup` first.");
  const xonUnit = 10n ** BigInt(xode.registry.chainDecimals[0]);
  const details = (await xode.query.assetWaiting.poolDetailsById([XON, USDT])).toJSON() as { status: string } | null;
  if (!details) {
    await submit(xode, xode.tx.assetWaiting.createPool(XON, USDT), alice);
    console.log("[xode] XON/USDT pool created (pending approval)");
  }
  if (details?.status !== "Active") {
    for (const member of [bob, charlie]) {
      await submit(xode, xode.tx.assetWaiting.approvePool(XON, USDT), member).catch((err: Error) => {
        if (!/AlreadyApproved|PoolNotPending/.test(err.message)) throw err;
      });
    }
    console.log("[xode] pool approved by two committee members");
  }
  const reserves = (await xode.call.assetConversionApi.getReserves(XON, USDT)).toJSON() as [string | number, string | number] | null;
  if (!reserves || BigInt(reserves[0]) === 0n) {
    const usdt = POOL_USDT * 1_000_000n;
    // Alice issues the dev USDT (setup creates the asset with her as owner).
    await submit(xode, xode.tx.utility.batchAll([
      // A little more than goes into the pool: adding liquidity may not empty her USDT account.
      xode.tx.assets.mint(USDT_ID, alice.address, usdt + 1_000_000n),
      xode.tx.assetConversion.addLiquidity(XON, USDT, POOL_XON * xonUnit, usdt, 1, 1, alice.address),
    ]), alice);
    console.log(`[xode] liquidity added: ${POOL_XON} XON + ${POOL_USDT} USDT (${Number(POOL_XON) / Number(POOL_USDT)} XON per USDT)`);
  } else {
    console.log("[xode] pool already has liquidity");
  }
}

/// Genesis pauses the DEX's swap calls (TxPause); the technical committee lifts that.
async function unpauseSwaps(xode: ApiPromise, members: KeyringPair[]): Promise<void> {
  for (const call of ["swap_exact_tokens_for_tokens", "swap_tokens_for_exact_tokens"]) {
    const name = ["AssetConversion", call];
    if ((await xode.query.txPause.pausedCalls(name)).isEmpty) continue;
    await committeeMotion(xode, members, xode.tx.txPause.unpause(name), `unpause AssetConversion.${call}`);
  }
}

async function channels(relay: ApiPromise, alice: KeyringPair): Promise<void> {
  const open = async (sender: number, recipient: number) => !(await relay.query.hrmp.hrmpChannels({ sender, recipient })).isEmpty;
  for (const [sender, recipient] of [[ASSET_HUB_PARA, XODE_PARA], [XODE_PARA, ASSET_HUB_PARA]]) {
    if (await open(sender, recipient)) continue;
    const cfg = (await relay.query.configuration.activeConfig()).toJSON() as { hrmpChannelMaxCapacity: number; hrmpChannelMaxMessageSize: number };
    await submit(relay, relay.tx.sudo.sudo(relay.tx.hrmp.forceOpenHrmpChannel(sender, recipient, cfg.hrmpChannelMaxCapacity, cfg.hrmpChannelMaxMessageSize)), alice);
    await submit(relay, relay.tx.sudo.sudo(relay.tx.hrmp.forceProcessHrmpOpen(2)), alice);
    await waitFor(`HRMP channel ${sender} -> ${recipient}`, () => open(sender, recipient), 10 * 60_000);
    console.log(`[relay] HRMP channel ${sender} -> ${recipient} open`);
  }
}

async function collector(xode: ApiPromise, alice: KeyringPair): Promise<void> {
  const account = (await xode.query.system.account(XODE_FEE_COLLECTOR)) as unknown as { data: { free: { isZero(): boolean } } };
  if (!account.data.free.isZero()) return;
  await submit(xode, xode.tx.balances.transferKeepAlive(XODE_FEE_COLLECTOR, 10n ** BigInt(xode.registry.chainDecimals[0])), alice);
  console.log("[xode] XCM fee collector funded");
}

async function main(): Promise<void> {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  const members = ["//Alice", "//Bob", "//Charlie"].map((uri) => keyring.addFromUri(uri));
  const xode = await ApiPromise.create({ provider: new WsProvider(XODE_WS), noInitWarn: true });
  try {
    const committee = ((await xode.query.technicalCommittee.members()).toJSON() as string[]).map((a) => keyring.encodeAddress(a, 42)).sort();
    if (committee.join() !== members.map((m) => keyring.encodeAddress(m.address, 42)).sort().join()) {
      throw new Error("This chain's technical committee isn't //Alice, //Bob and //Charlie - this script is for the local dev chain only.");
    }
    if (process.argv[2] === "upgrade") {
      await upgrade(xode, members);
      return;
    }
    await pool(xode, members);
    await unpauseSwaps(xode, members);
    await collector(xode, members[0]);
    const relay = await ApiPromise.create({ provider: new WsProvider(RELAY_WS), noInitWarn: true });
    try {
      await channels(relay, members[0]);
    } finally {
      await relay.disconnect();
    }
    console.log("Done.");
  } finally {
    await xode.disconnect();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
