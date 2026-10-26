// Manual test proving the poison-pill fix: a permanently-doomed deposit (here, a zero-amount USDT
// transfer, which reverts with ZeroAmount and can NEVER succeed no matter how many times retried)
// must not block a legitimate deposit that arrives right after it. Before the fix, one bad
// transfer like this would freeze the whole adapter forever.
//
// Needs the same local infra as test/e2e.manual.ts (zombienet + eth-rpc), Xode only for this one.
//
// Usage: npm run test:poison-pill   (CONTRACTS_OUT as in test/e2e.manual.ts)

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, encodeAddress } from "@polkadot/util-crypto";
import { ethers } from "ethers";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { KeyringPair } from "@polkadot/keyring/types";

// This repo, and contracts' `forge build` output (default: a sibling checkout of it).
const REPO = fileURLToPath(new URL("..", import.meta.url));
const CONTRACTS_OUT = process.env.CONTRACTS_OUT ?? path.resolve(REPO, "../contracts/out");

const XODE_WS = "ws://127.0.0.1:9977";
const XODE_ETH_RPC = "http://127.0.0.1:8546";
const UNIT = 1_000_000_000_000n;
const USDT_DECIMALS = 6;

interface ForgeArtifact {
  abi: ethers.InterfaceAbi;
  bytecode: { object: string };
}
function loadArtifact(file: string): ForgeArtifact {
  return JSON.parse(readFileSync(file, "utf8")) as ForgeArtifact;
}

const VendingArtifact = loadArtifact(`${CONTRACTS_OUT}/XonVendingMachine.sol/XonVendingMachine.json`);

function submit(api: ApiPromise, tx: SubmittableExtrinsic<"promise">, signer: KeyringPair): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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
function fallbackSs58(addr: string): string {
  const raw = new Uint8Array(32);
  raw.set(ethers.getBytes(addr), 0);
  raw.fill(0xee, 20);
  return encodeAddress(raw, 42);
}
function precompileAddr(assetId: number): string {
  const bytes = new Uint8Array(20);
  new DataView(bytes.buffer).setUint32(0, assetId, false);
  bytes[16] = 0x01; bytes[17] = 0x20;
  return ethers.getAddress(ethers.hexlify(bytes));
}

async function main(): Promise<void> {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  const alice = keyring.addFromUri("//Alice");

  const xode = await ApiPromise.create({ provider: new WsProvider(XODE_WS) });
  const xodeProvider = new ethers.JsonRpcProvider(XODE_ETH_RPC);

  const deployer = ethers.Wallet.createRandom().connect(xodeProvider);
  const owner = ethers.Wallet.createRandom().connect(xodeProvider);
  const relayer = ethers.Wallet.createRandom().connect(xodeProvider);
  const buyer = ethers.Wallet.createRandom().connect(xodeProvider);
  console.log("buyer:", buyer.address);

  for (const w of [deployer, owner, relayer, buyer]) {
    await submit(xode, xode.tx.balances.transferKeepAlive(fallbackSs58(w.address), 1000n * UNIT), alice);
  }

  const assetId = 1984;
  const existing = await xode.query.assets.asset(assetId);
  if (existing.isEmpty) {
    await submit(xode, xode.tx.assets.create(assetId, alice.address, 1), alice);
    await submit(xode, xode.tx.assets.setMetadata(assetId, "Tether USD", "USDT", USDT_DECIMALS), alice);
  }
  await submit(xode, xode.tx.assets.mint(assetId, fallbackSs58(buyer.address), 1000n * 10n ** BigInt(USDT_DECIMALS)), alice);
  const usdtAddress = precompileAddr(assetId);

  const factory = new ethers.ContractFactory(VendingArtifact.abi, VendingArtifact.bytecode.object, deployer);
  const vending = (await factory.deploy(usdtAddress, owner.address, ethers.parseEther("5"), relayer.address)) as unknown as ethers.Contract;
  await vending.waitForDeployment();
  const vendingAddress = await vending.getAddress();
  console.log("vending:", vendingAddress);
  await (await owner.sendTransaction({ to: vendingAddress, value: ethers.parseEther("100") })).wait();

  // Send BOTH deposits *before* starting the relayer, so a single tick sees the poison pill first
  // (earlier block) and the legitimate deposit right after it, in the same log batch. Capture the
  // block number *before* either deposit lands, and hand it to the relayer as XODE_START_BLOCK -
  // otherwise, with no checkpoint yet, it would default to "current block" at its own startup
  // (which is *after* both deposits), and miss them entirely rather than testing anything.
  const startBlock = (await xodeProvider.getBlockNumber()) + 1;

  const usdt = new ethers.Contract(usdtAddress, ["function transfer(address,uint256) returns (bool)"], buyer);
  console.log("\nSending poison-pill deposit (0 USDT - will revert with ZeroAmount, permanently)...");
  await (await usdt.transfer(vendingAddress, 0n)).wait();

  console.log("Sending legitimate deposit right after it (10 USDT)...");
  const goodReceipt = await (await usdt.transfer(vendingAddress, 10_000_000n)).wait();
  console.log("legitimate deposit tx:", goodReceipt.hash);

  const checkpointDir = mkdtempSync(path.join(tmpdir(), "xon-relayer-test-"));
  console.log("relayer state (checkpoints, ledger):", checkpointDir);
  const relayerProc = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: REPO,
    env: {
      ...process.env,
      // Isolate the run: its own checkpoints and ledger, no HTTP port, and none of a developer .env's
      // production settings (key file, alert webhook, chain IDs, payout caps).
      CHECKPOINT_DIR: checkpointDir, LEDGER_FILE: path.join(checkpointDir, "ledger.jsonl"), HTTP_PORT: "0",
      RELAYER_PRIVATE_KEY_FILE: "", CREDENTIALS_DIRECTORY: "", ALERT_WEBHOOK_URL: "",
      XODE_CHAIN_ID: "", ASSETHUB_CHAIN_ID: "", ETHEREUM_CHAIN_ID: "", MAX_EXTERNAL_DEPOSIT_USDT: "", MAX_EXTERNAL_DAILY_USDT: "",
      XODE_ETH_RPC, VENDING_ADDRESS: vendingAddress, RELAYER_PRIVATE_KEY: relayer.privateKey,
      POLL_INTERVAL_MS: "2000", CONFIRMATIONS: "0", XODE_START_BLOCK: String(startBlock),
      ENABLE_XODE_ADAPTER: "true", ENABLE_ASSETHUB_ADAPTER: "false", ENABLE_ETHEREUM_ADAPTER: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  relayerProc.stdout.on("data", (d: Buffer) => process.stdout.write(`[relayer] ${d}`));
  relayerProc.stderr.on("data", (d: Buffer) => process.stderr.write(`[relayer] ${d}`));

  try {
    console.log("\n=== Waiting for the legitimate deposit to settle despite the poison pill in front of it ===");
    const deadline = Date.now() + 120_000;
    let settled = false;
    while (Date.now() < deadline) {
      settled = await vending.settledDeposits(goodReceipt.hash);
      if (settled) break;
      await new Promise((r) => setTimeout(r, 1500));
    }

    console.log("\n=== Result ===");
    console.log("Legitimate deposit settled:", settled);
    console.log(settled
      ? "\nSUCCESS: the poison pill did not block the real deposit behind it."
      : "\nFAILURE: the real deposit is still stuck - the poison-pill fix did not work.");
    process.exitCode = settled ? 0 : 1;
  } finally {
    relayerProc.kill();
    await xode.disconnect();
  }
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
