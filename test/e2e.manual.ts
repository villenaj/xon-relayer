// Manual, live end-to-end test exercising all three adapters at once: a Xode-native deposit, and
// two UsdtGateway-contract deposits - one on Ethereum (or anvil, for local testing), one on
// AssetHub (now that it runs pallet-revive) - all three settling to XON on Xode through the one
// relayer process.
//
// Not a unit test - it needs real infrastructure running first:
//   - A local Xode zombienet + eth-rpc bridge (see xode-blockchain/zombienet/launch-ubuntu.sh)
//   - AssetHub's own Substrate RPC *and* its own pallet-revive-eth-rpc bridge (a separate eth-rpc
//     instance from Xode's, pointed at AssetHub's node) - set ASSETHUB_WS / ASSETHUB_EVM_RPC below
//     if these aren't on the defaults. This assumes a dev/test AssetHub where the Alice dev key can
//     create and mint a test USDT asset, same as the Xode side - against a real governed AssetHub
//     you don't control, swap this section for funding a depositor from an account you actually
//     have USDT on.
//   - An anvil instance standing in for Ethereum: `anvil --port 8546`
//   - `forge build` run in xode-blockchain/contracts, so the compiled artifacts this script reads
//     (XonVendingMachine, EthUsdtGateway, MockUSDT) exist
//
// Usage: npx tsx test/e2e.manual.ts

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, encodeAddress } from "@polkadot/util-crypto";
import { ethers } from "ethers";
import { readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { KeyringPair } from "@polkadot/keyring/types";
import { externalDepositId } from "../src/settlement.js";

const XODE_WS = "ws://127.0.0.1:9977";
const XODE_ETH_RPC = "http://127.0.0.1:8545";
const ASSETHUB_WS = process.env.ASSETHUB_WS ?? "ws://127.0.0.1:9955";
const ASSETHUB_EVM_RPC = process.env.ASSETHUB_EVM_RPC ?? "http://127.0.0.1:8547";
const ANVIL_RPC = "http://127.0.0.1:8546";
const UNIT = 1_000_000_000_000n;
const USDT_DECIMALS = 6;

interface ForgeArtifact {
  abi: ethers.InterfaceAbi;
  bytecode: { object: string };
}
function loadArtifact(file: string): ForgeArtifact {
  return JSON.parse(readFileSync(file, "utf8")) as ForgeArtifact;
}

const VendingArtifact = loadArtifact("/home/jowel/Documents/GitHub/villenaj/xode-blockchain/contracts/out/XonVendingMachine.sol/XonVendingMachine.json");
const GatewayArtifact = loadArtifact("/home/jowel/Documents/GitHub/villenaj/xode-blockchain/contracts/out/EthUsdtGateway.sol/EthUsdtGateway.json");
const MockUsdtArtifact = loadArtifact("/home/jowel/Documents/GitHub/villenaj/xode-blockchain/contracts/out/MockUSDT.sol/MockUSDT.json");

const ANVIL_DEFAULT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

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
// `pallet_assets_precompiles::ERC20<Self, InlineIdConfig<0x0120>, TrustBackedAssetsInstance>`'s
// address convention - assumed to match on AssetHub too (same polkadot-sdk crate/pattern). If
// AssetHub's actual deployment uses a different prefix, adjust `prefix` accordingly.
function precompileAddr(assetId: number, prefix = 0x0120): string {
  const bytes = new Uint8Array(20);
  new DataView(bytes.buffer).setUint32(0, assetId, false);
  bytes[16] = (prefix >> 8) & 0xff;
  bytes[17] = prefix & 0xff;
  return ethers.getAddress(ethers.hexlify(bytes));
}

async function main(): Promise<void> {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  const alice = keyring.addFromUri("//Alice");

  const xode = await ApiPromise.create({ provider: new WsProvider(XODE_WS) });
  const assetHub = await ApiPromise.create({ provider: new WsProvider(ASSETHUB_WS) });
  const xodeProvider = new ethers.JsonRpcProvider(XODE_ETH_RPC);
  const anvilProvider = new ethers.JsonRpcProvider(ANVIL_RPC);
  const assetHubProvider = new ethers.JsonRpcProvider(ASSETHUB_EVM_RPC);

  // --- Xode side: deploy XonVendingMachine, register local USDT, fund test signers ---
  const deployer = ethers.Wallet.createRandom().connect(xodeProvider);
  const owner = ethers.Wallet.createRandom().connect(xodeProvider);
  const relayer = ethers.Wallet.createRandom().connect(xodeProvider);
  const nativeBuyer = ethers.Wallet.createRandom().connect(xodeProvider); // Xode-native path
  const assetHubBeneficiary = ethers.Wallet.createRandom().connect(xodeProvider); // receives XON for an AssetHub deposit
  const ethBeneficiary = ethers.Wallet.createRandom().connect(xodeProvider); // receives XON for an Ethereum deposit

  console.log("relayer:", relayer.address);
  console.log("nativeBuyer:", nativeBuyer.address);
  console.log("assetHubBeneficiary:", assetHubBeneficiary.address);
  console.log("ethBeneficiary:", ethBeneficiary.address);

  for (const w of [deployer, owner, relayer, nativeBuyer]) {
    await submit(xode, xode.tx.balances.transferKeepAlive(fallbackSs58(w.address), 1000n * UNIT), alice);
  }

  const assetId = 1984;
  const existing = await xode.query.assets.asset(assetId);
  if (existing.isEmpty) {
    await submit(xode, xode.tx.assets.create(assetId, alice.address, 1), alice);
    await submit(xode, xode.tx.assets.setMetadata(assetId, "Tether USD", "USDT", USDT_DECIMALS), alice);
  }
  await submit(xode, xode.tx.assets.mint(assetId, fallbackSs58(nativeBuyer.address), 1000n * 10n ** BigInt(USDT_DECIMALS)), alice);
  const xodeUsdtAddress = precompileAddr(assetId);

  const factory = new ethers.ContractFactory(VendingArtifact.abi, VendingArtifact.bytecode.object, deployer);
  const vending = (await factory.deploy(xodeUsdtAddress, owner.address, ethers.parseEther("5"), relayer.address)) as unknown as ethers.Contract;
  await vending.waitForDeployment();
  const vendingAddress = await vending.getAddress();
  console.log("vending:", vendingAddress);
  // 10 + 20 + 15 USDT at 5 XON/USDT = 225 XON needed across all three deposits - seed comfortably above that.
  await (await owner.sendTransaction({ to: vendingAddress, value: ethers.parseEther("500") })).wait();

  // --- Ethereum (anvil) side: deploy MockUSDT + UsdtGateway ---
  // NonceManager avoids a real ethers v6 gotcha: a plain Wallet re-queries the "pending" nonce on
  // every send, which can race against instant-mining local nodes (anvil) when sending several
  // transactions back to back from the same signer. NonceManager has no synchronous `.address`,
  // so keep a plain Wallet around too, just for reading its address.
  const ethSignerWallet = new ethers.Wallet(ANVIL_DEFAULT_KEY, anvilProvider);
  const ethSigner = new ethers.NonceManager(ethSignerWallet);
  const ethSignerAddress = ethSignerWallet.address;
  const mockUsdtFactory = new ethers.ContractFactory(MockUsdtArtifact.abi, MockUsdtArtifact.bytecode.object, ethSigner);
  const mockUsdt = (await mockUsdtFactory.deploy()) as unknown as ethers.Contract;
  await mockUsdt.waitForDeployment();
  const mockUsdtAddress = await mockUsdt.getAddress();

  const ethGatewayFactory = new ethers.ContractFactory(GatewayArtifact.abi, GatewayArtifact.bytecode.object, ethSigner);
  const ethGateway = (await ethGatewayFactory.deploy(mockUsdtAddress, ethSignerAddress)) as unknown as ethers.Contract;
  await ethGateway.waitForDeployment();
  const ethGatewayAddress = await ethGateway.getAddress();
  console.log("gateway (Ethereum):", ethGatewayAddress);

  await (await mockUsdt.mint(ethSignerAddress, 1_000_000_000n)).wait();

  // --- AssetHub side: deploy UsdtGateway there too (pallet-revive is live on AssetHub now) ---
  const ahDepositor = ethers.Wallet.createRandom().connect(assetHubProvider);
  const ahOwner = ethers.Wallet.createRandom().connect(assetHubProvider);
  await submit(assetHub, assetHub.tx.balances.transferKeepAlive(fallbackSs58(ahDepositor.address), 1000n * UNIT), alice);
  await submit(assetHub, assetHub.tx.balances.transferKeepAlive(fallbackSs58(ahOwner.address), 1000n * UNIT), alice);

  const ahExisting = await assetHub.query.assets.asset(assetId);
  if (ahExisting.isEmpty) {
    await submit(assetHub, assetHub.tx.assets.create(assetId, alice.address, 1), alice);
    await submit(assetHub, assetHub.tx.assets.setMetadata(assetId, "Tether USD", "USDT", USDT_DECIMALS), alice);
  }
  await submit(assetHub, assetHub.tx.assets.mint(assetId, fallbackSs58(ahDepositor.address), 1_000_000_000n), alice);
  const assetHubUsdtAddress = precompileAddr(assetId);

  const ahGatewayFactory = new ethers.ContractFactory(GatewayArtifact.abi, GatewayArtifact.bytecode.object, ahOwner);
  const ahGateway = (await ahGatewayFactory.deploy(assetHubUsdtAddress, ahOwner.address)) as unknown as ethers.Contract;
  await ahGateway.waitForDeployment();
  const ahGatewayAddress = await ahGateway.getAddress();
  console.log("gateway (AssetHub):", ahGatewayAddress);

  // --- Start the relayer with all three adapters ---
  rmSync("/home/jowel/Documents/GitHub/villenaj/xon-relayer/.checkpoints", { recursive: true, force: true });
  const relayerProc = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: "/home/jowel/Documents/GitHub/villenaj/xon-relayer",
    env: {
      ...process.env,
      XODE_ETH_RPC, VENDING_ADDRESS: vendingAddress, RELAYER_PRIVATE_KEY: relayer.privateKey,
      POLL_INTERVAL_MS: "2000", CONFIRMATIONS: "0", ETHEREUM_CONFIRMATIONS: "0", ASSETHUB_CONFIRMATIONS: "0",
      ENABLE_XODE_ADAPTER: "true", ENABLE_ASSETHUB_ADAPTER: "true", ENABLE_ETHEREUM_ADAPTER: "true",
      ASSETHUB_EVM_RPC, ASSETHUB_GATEWAY_ADDRESS: ahGatewayAddress,
      ETHEREUM_RPC: ANVIL_RPC, ETH_GATEWAY_ADDRESS: ethGatewayAddress,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  relayerProc.stdout.on("data", (d: Buffer) => process.stdout.write(`[relayer] ${d}`));
  relayerProc.stderr.on("data", (d: Buffer) => process.stderr.write(`[relayer] ${d}`));

  await new Promise((r) => setTimeout(r, 5000)); // let all three adapters finish connecting

  try {
    console.log("\n=== Depositing on all three chains ===");

    // 1. Xode-native
    const xodeUsdt = new ethers.Contract(xodeUsdtAddress, ["function transfer(address,uint256) returns (bool)"], nativeBuyer);
    const nativeReceipt = await (await xodeUsdt.transfer(vendingAddress, 10_000_000n)).wait();
    console.log("Xode-native deposit sent (10 USDT), tx:", nativeReceipt.hash);

    // 2. Ethereum (anvil) via UsdtGateway
    await (await mockUsdt.approve(ethGatewayAddress, 20_000_000n)).wait();
    const ethReceipt = await (await ethGateway.deposit(20_000_000n, ethBeneficiary.address)).wait();
    console.log("Ethereum deposit sent (20 USDT), tx:", ethReceipt.hash);

    // 3. AssetHub via UsdtGateway
    const ahUsdt = new ethers.Contract(assetHubUsdtAddress, ["function approve(address,uint256) returns (bool)"], ahDepositor);
    await (await ahUsdt.approve(ahGatewayAddress, 15_000_000n)).wait();
    const ahGatewayAsDepositor = ahGateway.connect(ahDepositor) as ethers.Contract;
    const ahReceipt = await (await ahGatewayAsDepositor.deposit(15_000_000n, assetHubBeneficiary.address)).wait();
    console.log("AssetHub deposit sent (15 USDT), tx:", ahReceipt.hash);

    const nativeDepositId = nativeReceipt.hash;
    const ethDepositId = externalDepositId("ethereum", ethReceipt.hash);
    const assetHubDepositId = externalDepositId("assethub", ahReceipt.hash);

    console.log("\n=== Waiting for all three to settle (checking on-chain settlement flags) ===");
    const deadline = Date.now() + 90_000;
    let results = { native: false, eth: false, ah: false };
    while (Date.now() < deadline && !(results.native && results.eth && results.ah)) {
      results.native = await vending.settledDeposits(nativeDepositId);
      results.eth = await vending.externalSettledDeposits(ethDepositId);
      results.ah = await vending.externalSettledDeposits(assetHubDepositId);
      if (!(results.native && results.eth && results.ah)) {
        console.log(`  ... still waiting (native=${results.native}, eth=${results.eth}, assethub=${results.ah})`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    console.log("\n=== Results ===");
    console.log("Xode-native settled:", results.native, "- buyer XON balance:", ethers.formatEther(await xodeProvider.getBalance(nativeBuyer.address)));
    console.log("Ethereum settled:   ", results.eth, "- beneficiary XON balance:", ethers.formatEther(await xodeProvider.getBalance(ethBeneficiary.address)));
    console.log("AssetHub settled:   ", results.ah, "- beneficiary XON balance:", ethers.formatEther(await xodeProvider.getBalance(assetHubBeneficiary.address)));

    const allOk = results.native && results.eth && results.ah;
    console.log(allOk ? "\nSUCCESS: all three adapters settled correctly." : "\nFAILURE: not all deposits settled.");
    process.exitCode = allOk ? 0 : 1;
  } finally {
    relayerProc.kill();
    await xode.disconnect();
    await assetHub.disconnect();
  }
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });

// Xode
// 1. Transfer USDT to the vending machine contract to get XON

// AssetHub
// 1. Approve the UsdtGateway contract to spend your USDT
// 2. Call deposit on the UsdtGateway contract, specifying the amount and your Xode address as beneficiary

// Ethereum
// 1. Approve the UsdtGateway contract to spend your USDT
// 2. Call deposit on the UsdtGateway contract, specifying the amount and your Xode address as beneficiary