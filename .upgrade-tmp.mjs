// Runtime upgrade of the LOCAL Xode test chain through its own governance:
//   1. Technical Committee motion (all 3 members: Alice, Bob, Charlie - dev keys) that whitelists
//      and dispatches, as Root, system.authorize_upgrade(blake2_256(wasm)).
//   2. Anyone calls system.apply_authorized_upgrade(wasm); the relay chain then enacts it.
// Usage: node runtime-upgrade.mjs <ws url> <wasm path> [--no-wait-enact]
// Refuses anything but a local endpoint. Run from a dir with @polkadot/api + @polkadot/keyring.
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { blake2AsHex, cryptoWaitReady } from "@polkadot/util-crypto";
import { readFileSync } from "node:fs";

const [url, wasmPath, flag] = process.argv.slice(2);
if (!/^wss?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url ?? "")) throw new Error(`Local endpoints only (got ${url}).`);
const waitEnact = flag !== "--no-wait-enact";

await cryptoWaitReady();
const keyring = new Keyring({ type: "sr25519" });
const [alice, bob, charlie] = ["//Alice", "//Bob", "//Charlie"].map((uri) => keyring.addFromUri(uri));
const api = await ApiPromise.create({ provider: new WsProvider(url), noInitWarn: true });
const code = `0x${readFileSync(wasmPath).toString("hex")}`;
const codeHash = blake2AsHex(code, 256);
console.log(`${(await api.rpc.system.chain()).toString()} at ${url}: spec ${api.runtimeVersion.specVersion.toNumber()}, block ${(await api.rpc.chain.getHeader()).number.toNumber()}`);
console.log(`new runtime: ${wasmPath} (${(code.length - 2) / 2} bytes), blake2_256 ${codeHash}`);

const members = (await api.query.technicalCommittee.members()).map((m) => m.toHex());
for (const k of [alice, bob, charlie]) {
  if (!members.includes(api.createType("AccountId", k.address).toHex())) throw new Error(`${k.meta.name ?? k.address} isn't on the Technical Committee here.`);
}

// Sends a tx and waits for its block; throws on a dispatch error. Returns the block's events for it.
async function send(tx, signer, label) {
  // The nonce from the latest block's state: the RPC's next-index can lag right after a block.
  const { nonce } = await api.query.system.account(signer.address);
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, { nonce }, ({ status, events, dispatchError }) => {
      if (dispatchError) {
        const msg = dispatchError.isModule ? (({ section, name }) => `${section}.${name}`)(api.registry.findMetaError(dispatchError.asModule)) : dispatchError.toString();
        reject(new Error(`${label} failed: ${msg}`));
      } else if (status.isInBlock) {
        console.log(`  ${label}: in block ${status.asInBlock.toHex().slice(0, 12)}…`);
        resolve(events.map(({ event }) => event));
      }
    }).catch(reject);
  });
}
const names = (events) => events.map((e) => `${e.section}.${e.method}`).join(", ");

// --- 1. Authorize -----------------------------------------------------------------------------
const authorize = api.tx.system.authorizeUpgrade(codeHash);
const motion = api.tx.utility.batchAll([
  api.tx.whitelist.whitelistCall(authorize.method.hash),
  api.tx.whitelist.dispatchWhitelistedCallWithPreimage(authorize.method),
]);
const lengthBound = motion.method.encodedLength;
const threshold = members.length; // "more than 2/3" of 3 members is all 3
console.log(`1. Technical Committee motion (threshold ${threshold}/${members.length}): whitelist + dispatch system.authorize_upgrade`);
const proposed = await send(api.tx.technicalCommittee.propose(threshold, motion.method, lengthBound), alice, "Alice proposes");
const p = proposed.find((e) => e.section === "technicalCommittee" && e.method === "Proposed");
if (!p) throw new Error(`no Proposed event: ${names(proposed)}`);
const [, index, proposalHash] = p.data;
// Alice's proposal doesn't count as her vote in pallet-collective; everyone votes.
for (const [who, name] of [[alice, "Alice"], [bob, "Bob"], [charlie, "Charlie"]]) {
  await send(api.tx.technicalCommittee.vote(proposalHash, index, true), who, `${name} votes aye`);
}
const weightBound = { refTime: 10_000_000_000n, proofSize: 1_000_000n };
const closed = await send(api.tx.technicalCommittee.close(proposalHash, index, weightBound, lengthBound), alice, "close motion");
console.log(`   events: ${names(closed)}`);
const executed = closed.find((e) => e.section === "technicalCommittee" && e.method === "Executed");
if (!executed || !executed.data[1].isOk) throw new Error(`motion didn't execute cleanly: ${executed?.data[1]?.toString() ?? names(closed)}`);
const authorized = (await api.query.system.authorizedUpgrade()).toJSON();
if (authorized?.codeHash !== codeHash) throw new Error(`upgrade not authorized: ${JSON.stringify(authorized)}`);
console.log(`   authorized: ${JSON.stringify(authorized)}`);

// --- 2. Apply -----------------------------------------------------------------------------------
console.log("2. apply_authorized_upgrade");
const applied = await send(api.tx.system.applyAuthorizedUpgrade(code), alice, "apply_authorized_upgrade");
console.log(`   events: ${names(applied)}`);
if (!waitEnact) { await api.disconnect(); process.exit(0); }

// --- 3. Wait for the relay chain to let the parachain switch ---------------------------------
console.log("3. waiting for the relay chain to enact it...");
const startSpec = api.runtimeVersion.specVersion.toNumber();
const deadline = Date.now() + 15 * 60_000;
while (Date.now() < deadline) {
  const spec = (await api.rpc.state.getRuntimeVersion()).specVersion.toNumber();
  if (spec !== startSpec) {
    console.log(`   runtime is now spec ${spec} at block ${(await api.rpc.chain.getHeader()).number.toNumber()}`);
    await api.disconnect(); process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 6000));
}
throw new Error("timed out waiting for the new runtime to be enacted");
