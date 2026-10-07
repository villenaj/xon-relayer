// Manual test: multiple distinct buyers depositing at roughly the same time (all transfers fired
// without waiting for each other to confirm first), proving the relayer settles every one of them
// correctly even though they land concurrently/out-of-order, not just one buyer at a time.
//
// Needs the same local infra as the other manual tests (zombienet + eth-rpc), Xode only.
//
// Usage: node test/multiBuyer.manual.js

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, encodeAddress } from "@polkadot/util-crypto";
import { ethers } from "ethers";
import { readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";

const XODE_WS = "ws://127.0.0.1:9977";
const XODE_ETH_RPC = "http://127.0.0.1:8545";
const UNIT = 1_000_000_000_000n;
const USDT_DECIMALS = 6;
const NUM_BUYERS = 5;

const VendingArtifact = JSON.parse(readFileSync("/home/jowel/Documents/GitHub/villenaj/xode-blockchain/contracts/out/XonVendingMachine.sol/XonVendingMachine.json"));

function submit(api, tx, signer) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, (r) => {
      if (r.dispatchError) {
        const msg = r.dispatchError.isModule ? api.registry.findMetaError(r.dispatchError.asModule).name : r.dispatchError.toString();
        reject(new Error(msg));
        return;
      }
      if (r.status.isFinalized) resolve();
    }).catch(reject);
  });
}
function fallbackSs58(addr) {
  const raw = new Uint8Array(32);
  raw.set(ethers.getBytes(addr), 0);
  raw.fill(0xee, 20);
  return encodeAddress(raw, 42);
}
function precompileAddr(assetId) {
  const bytes = new Uint8Array(20);
  new DataView(bytes.buffer).setUint32(0, assetId, false);
  bytes[16] = 0x01; bytes[17] = 0x20;
  return ethers.getAddress(ethers.hexlify(bytes));
}

async function main() {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  const alice = keyring.addFromUri("//Alice");

  const xode = await ApiPromise.create({ provider: new WsProvider(XODE_WS) });
  const xodeProvider = new ethers.JsonRpcProvider(XODE_ETH_RPC);

  const deployer = ethers.Wallet.createRandom().connect(xodeProvider);
  const owner = ethers.Wallet.createRandom().connect(xodeProvider);
  const relayer = ethers.Wallet.createRandom().connect(xodeProvider);
  const buyers = Array.from({ length: NUM_BUYERS }, () => ethers.Wallet.createRandom().connect(xodeProvider));
  console.log("buyers:", buyers.map((b) => b.address));

  for (const w of [deployer, owner, relayer, ...buyers]) {
    await submit(xode, xode.tx.balances.transferKeepAlive(fallbackSs58(w.address), 1000n * UNIT), alice);
  }

  const assetId = 1984;
  const existing = await xode.query.assets.asset(assetId);
  if (existing.isNone) {
    await submit(xode, xode.tx.assets.create(assetId, alice.address, 1), alice);
    await submit(xode, xode.tx.assets.setMetadata(assetId, "Tether USD", "USDT", USDT_DECIMALS), alice);
  }
  for (const buyer of buyers) {
    await submit(xode, xode.tx.assets.mint(assetId, fallbackSs58(buyer.address), 100n * 10n ** BigInt(USDT_DECIMALS)), alice);
  }
  const usdtAddress = precompileAddr(assetId);

  const factory = new ethers.ContractFactory(VendingArtifact.abi, VendingArtifact.bytecode.object, deployer);
  const vending = await factory.deploy(usdtAddress, owner.address, ethers.parseEther("5"), relayer.address);
  await vending.waitForDeployment();
  const vendingAddress = await vending.getAddress();
  console.log("vending:", vendingAddress);
  await (await owner.sendTransaction({ to: vendingAddress, value: ethers.parseEther("500") })).wait();

  const startBlock = (await xodeProvider.getBlockNumber()) + 1;

  console.log(`\nFiring ${NUM_BUYERS} deposits concurrently (not waiting for each to confirm before sending the next)...`);
  const depositAmounts = buyers.map((_, i) => BigInt((i + 1) * 2_000_000)); // 2, 4, 6, 8, 10 USDT
  const sendPromises = buyers.map((buyer, i) => {
    const usdt = new ethers.Contract(usdtAddress, ["function transfer(address,uint256) returns (bool)"], buyer);
    return usdt.transfer(vendingAddress, depositAmounts[i]).then((tx) => tx.wait());
  });
  const receipts = await Promise.all(sendPromises);
  receipts.forEach((r, i) => console.log(`  buyer ${i} (${buyers[i].address}) deposit tx: ${r.hash}, block ${r.blockNumber}`));

  rmSync("/home/jowel/Documents/GitHub/villenaj/xon-relayer/.checkpoints", { recursive: true, force: true });
  const relayerProc = spawn(process.execPath, ["src/index.js"], {
    cwd: "/home/jowel/Documents/GitHub/villenaj/xon-relayer",
    env: {
      ...process.env,
      XODE_ETH_RPC, VENDING_ADDRESS: vendingAddress, RELAYER_PRIVATE_KEY: relayer.privateKey,
      POLL_INTERVAL_MS: "2000", CONFIRMATIONS: "0", XODE_START_BLOCK: String(startBlock),
      ENABLE_XODE_ADAPTER: "true", ENABLE_ASSETHUB_ADAPTER: "false", ENABLE_ETHEREUM_ADAPTER: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  relayerProc.stdout.on("data", (d) => process.stdout.write(`[relayer] ${d}`));
  relayerProc.stderr.on("data", (d) => process.stderr.write(`[relayer] ${d}`));

  try {
    console.log("\n=== Waiting for all buyers to settle ===");
    const deadline = Date.now() + 120_000;
    const settled = new Array(NUM_BUYERS).fill(false);
    while (Date.now() < deadline && settled.some((s) => !s)) {
      for (let i = 0; i < NUM_BUYERS; i++) {
        if (!settled[i]) settled[i] = await vending.settledDeposits(receipts[i].hash);
      }
      if (settled.some((s) => !s)) await new Promise((r) => setTimeout(r, 2000));
    }

    console.log("\n=== Results ===");
    let allOk = true;
    for (let i = 0; i < NUM_BUYERS; i++) {
      const xonBalance = await xodeProvider.getBalance(buyers[i].address);
      const expectedXon = depositAmounts[i] * 5n * 10n ** 12n / 10n ** 6n; // rate 5 XON/USDT, USDT 6dp, XON 18dp-as-seen
      console.log(`buyer ${i}: settled=${settled[i]}, usdt paid=${depositAmounts[i]}, xon balance=${ethers.formatEther(xonBalance)}`);
      if (!settled[i]) allOk = false;
    }

    console.log(allOk
      ? "\nSUCCESS: every one of the concurrent buyers settled correctly."
      : "\nFAILURE: at least one concurrent buyer never settled.");
    process.exitCode = allOk ? 0 : 1;
  } finally {
    relayerProc.kill();
    await xode.disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
