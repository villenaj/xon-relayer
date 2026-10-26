// One-shot setup for a dev/test environment: creates the USDT asset on Xode and AssetHub, deploys
// XonVendingMachine (Xode) and EthUsdtGateway (AssetHub and Ethereum), and funds every account and
// contract the relayer needs. Writes the resulting relayer settings to an env file.
//
// Two keys run everything:
//   - ASSET_OWNER_SURI: one Substrate (sr25519) account, used on both Xode and AssetHub. It creates
//     and mints the USDT asset and pays the native tokens (gas, the XON reserve) to the EVM accounts.
//   - CONTRACT_OWNER_KEY: one EVM key that deploys and owns all three contracts.
// The relayer key defaults to the contract owner's (fine for dev/test - see README for production).
//
// Safe to re-run: the asset is only created if missing, balances are topped up to their targets
// rather than sent again, and contracts named in VENDING_ADDRESS / ASSETHUB_GATEWAY_ADDRESS /
// ETH_GATEWAY_ADDRESS are reused instead of redeployed.
//
// Settings come from the environment, or from setup.env (see setup.env.example). Every one has a
// default that matches the local zombienet + anvil setup in test/e2e.manual.ts.
//
// Usage: npm run setup   (needs `forge build` run in contracts - CONTRACTS_OUT as in test/e2e.manual.ts)

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import { config as loadEnv } from "dotenv";
import { ethers } from "ethers";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { KeyringPair } from "@polkadot/keyring/types";

const REPO = fileURLToPath(new URL("..", import.meta.url));
loadEnv({ path: path.resolve(REPO, process.env.SETUP_ENV_FILE ?? "setup.env"), quiet: true });

const env = (name: string, fallback: string): string => process.env[name] || fallback;
const flag = (name: string, fallback: boolean): boolean => (process.env[name] ? process.env[name] !== "false" : fallback);

const CONTRACTS_OUT = env("CONTRACTS_OUT", path.resolve(REPO, "../contracts/out"));
const OUTPUT_ENV = path.resolve(REPO, env("SETUP_OUTPUT", "setup.out.env"));

const XODE_WS = env("XODE_WS", "ws://127.0.0.1:9977");
const XODE_ETH_RPC = env("XODE_ETH_RPC", "http://127.0.0.1:8546");
const ASSETHUB_WS = env("ASSETHUB_WS", "ws://127.0.0.1:9966");
const ASSETHUB_EVM_RPC = env("ASSETHUB_EVM_RPC", "http://127.0.0.1:8547");
const ETHEREUM_RPC = env("ETHEREUM_RPC", "http://127.0.0.1:8545");
const SETUP_ASSETHUB = flag("SETUP_ASSETHUB", true);
const SETUP_ETHEREUM = flag("SETUP_ETHEREUM", true);

const ASSET_ID = Number(env("ASSET_ID", "1984"));
const USDT_DECIMALS = 6;
const usdt = (whole: string): bigint => ethers.parseUnits(whole, USDT_DECIMALS);
const USDT_MINT = usdt(env("USDT_MINT", "10000"));
// Extra EVM addresses (comma-separated) to mint test USDT to on every chain, e.g. test buyers.
const USDT_RECIPIENTS = env("USDT_RECIPIENTS", "").split(",").map((a) => a.trim()).filter(Boolean).map((a) => ethers.getAddress(a));

const XON_RATE = ethers.parseEther(env("XON_RATE", "5")); // XON per 1 USDT
const VENDING_RESERVE_XON = ethers.parseEther(env("VENDING_RESERVE_XON", "500"));
const GAS_BUFFER = env("GAS_BUFFER", "100"); // whole native tokens each EVM account keeps for gas
const MAX_PER_DEPOSIT = usdt(env("EXTERNAL_MAX_PER_DEPOSIT_USDT", "100"));
const MAX_PER_DAY = usdt(env("EXTERNAL_MAX_PER_DAY_USDT", "1000"));

const ANVIL_CHAIN_ID = 31337n;
const ANVIL_DEFAULT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

interface ForgeArtifact {
  abi: ethers.InterfaceAbi;
  bytecode: { object: string };
}
function loadArtifact(file: string): ForgeArtifact {
  const full = path.join(CONTRACTS_OUT, file);
  if (!existsSync(full)) throw new Error(`${full} not found - run \`forge build\` in contracts, or set CONTRACTS_OUT.`);
  return JSON.parse(readFileSync(full, "utf8")) as ForgeArtifact;
}

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
/// Submits all calls in one `utility.batchAll` (one finalization wait) when the chain has it.
async function submitAll(api: ApiPromise, calls: SubmittableExtrinsic<"promise">[], signer: KeyringPair): Promise<void> {
  if (calls.length === 0) return;
  if (api.tx.utility?.batchAll) return submit(api, api.tx.utility.batchAll(calls), signer);
  for (const call of calls) await submit(api, call, signer);
}

/// The Substrate account pallet-revive maps an EVM address to (the address followed by 0xEE bytes).
function fallbackSs58(addr: string): string {
  const raw = new Uint8Array(32);
  raw.set(ethers.getBytes(addr), 0);
  raw.fill(0xee, 20);
  return encodeAddress(raw, 42);
}
/// The ERC20 precompile address of a pallet-assets asset (see test/e2e.manual.ts).
function precompileAddr(assetId: number, prefix = 0x0120): string {
  const bytes = new Uint8Array(20);
  new DataView(bytes.buffer).setUint32(0, assetId, false);
  bytes[16] = (prefix >> 8) & 0xff;
  bytes[17] = prefix & 0xff;
  return ethers.getAddress(ethers.hexlify(bytes));
}
const sameAccount = (a: string, b: string): boolean => encodeAddress(decodeAddress(a)) === encodeAddress(decodeAddress(b));

interface SubstrateFunding {
  evmAddress: string;
  /// Native balance to top up to, in 18-decimal EVM units.
  target: bigint;
}

/// Creates the USDT asset if missing, tops up the native balance of each funded EVM account, and
/// mints `USDT_MINT` to each recipient - all from the asset owner, in one batch.
async function setUpSubstrateChain(
  name: string,
  api: ApiPromise,
  assetOwner: KeyringPair,
  usdtRecipients: string[],
  funding: SubstrateFunding[],
): Promise<void> {
  const decimals = api.registry.chainDecimals[0];
  const symbol = api.registry.chainTokens[0];
  // pallet-revive scales the native balance up to 18 decimals at the EVM boundary.
  const toPlanck = (evm: bigint): bigint => evm / 10n ** BigInt(18 - decimals);
  const calls: SubmittableExtrinsic<"promise">[] = [];

  const asset = await api.query.assets.asset(ASSET_ID);
  if (asset.isEmpty) {
    console.log(`[${name}] creating asset ${ASSET_ID} (USDT)`);
    calls.push(api.tx.assets.create(ASSET_ID, assetOwner.address, 1));
    calls.push(api.tx.assets.setMetadata(ASSET_ID, "Tether USD", "USDT", USDT_DECIMALS));
  } else {
    const issuer = (asset as any).unwrap().issuer.toString() as string;
    if (!sameAccount(issuer, assetOwner.address)) {
      throw new Error(`[${name}] asset ${ASSET_ID} already exists with issuer ${issuer}, not the asset owner ${assetOwner.address} - set ASSET_ID to a free id, or ASSET_OWNER_SURI to its issuer.`);
    }
    console.log(`[${name}] asset ${ASSET_ID} exists, issued by the asset owner`);
  }
  // Fund before minting: USDT isn't a sufficient asset, so an account with no native balance
  // doesn't exist yet and can't be minted to.
  for (const { evmAddress, target } of funding) {
    const account = fallbackSs58(evmAddress);
    const free = ((await api.query.system.account(account)) as any).data.free.toBigInt() as bigint;
    const want = toPlanck(target);
    if (free >= want) continue;
    calls.push(api.tx.balances.transferKeepAlive(account, want - free));
    console.log(`[${name}] funding ${evmAddress} with ${ethers.formatUnits(want - free, decimals)} ${symbol}`);
  }
  for (const to of usdtRecipients) {
    calls.push(api.tx.assets.mint(ASSET_ID, fallbackSs58(to), USDT_MINT));
    console.log(`[${name}] minting ${ethers.formatUnits(USDT_MINT, USDT_DECIMALS)} USDT to ${to}`);
  }
  await submitAll(api, calls, assetOwner);
}

/// Returns the contract at `existing` if it has code there, otherwise deploys a new one.
async function deployOrReuse(
  name: string,
  artifact: ForgeArtifact,
  signer: ethers.Signer,
  existing: string | undefined,
  args: unknown[],
): Promise<{ contract: ethers.Contract; address: string; deployBlock?: number }> {
  if (existing && (await signer.provider!.getCode(existing)) !== "0x") {
    console.log(`[${name}] reusing ${existing}`);
    return { contract: new ethers.Contract(existing, artifact.abi, signer), address: existing };
  }
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, signer);
  const contract = (await factory.deploy(...args)) as unknown as ethers.Contract;
  const receipt = await contract.deploymentTransaction()!.wait();
  const address = await contract.getAddress();
  console.log(`[${name}] deployed at ${address} (block ${receipt!.blockNumber})`);
  return { contract, address, deployBlock: receipt!.blockNumber };
}

async function requireOwner(name: string, contract: ethers.Contract, owner: string): Promise<void> {
  const onChain: string = await contract.owner();
  if (onChain !== owner) throw new Error(`[${name}] ${await contract.getAddress()} is owned by ${onChain}, not the contract owner ${owner}.`);
}

async function main(): Promise<void> {
  await cryptoWaitReady();
  const assetOwner = new Keyring({ type: "sr25519", ss58Format: 42 }).addFromUri(env("ASSET_OWNER_SURI", "//Alice"));

  const generatedOwner = !process.env.CONTRACT_OWNER_KEY;
  const ownerKey = process.env.CONTRACT_OWNER_KEY || ethers.Wallet.createRandom().privateKey;
  const owner = new ethers.Wallet(ownerKey);
  const relayerKey = process.env.RELAYER_PRIVATE_KEY || ownerKey;
  const relayer = new ethers.Wallet(relayerKey);
  const relayerIsOwner = relayer.address === owner.address;

  console.log("asset owner (Xode + AssetHub):", assetOwner.address);
  console.log("contract owner:", owner.address, generatedOwner ? "(generated - saved to the output file)" : "");
  console.log("relayer:", relayer.address, relayerIsOwner ? "(same key as the contract owner)" : "");

  const gas = ethers.parseEther(GAS_BUFFER);
  const usdtRecipients = [owner.address, ...USDT_RECIPIENTS];
  // Test buyers need native balance too: to exist (so they can hold USDT) and to pay gas.
  const buyerFunding: SubstrateFunding[] = USDT_RECIPIENTS.filter((a) => a !== owner.address && a !== relayer.address)
    .map((evmAddress) => ({ evmAddress, target: gas }));
  const out: Record<string, string> = { XODE_ETH_RPC, RELAYER_PRIVATE_KEY: relayerKey };

  // --- Xode: USDT asset, funding, XonVendingMachine ---
  const xode = await ApiPromise.create({ provider: new WsProvider(XODE_WS), noInitWarn: true });
  try {
    const xodeFunding: SubstrateFunding[] = [{ evmAddress: owner.address, target: VENDING_RESERVE_XON + gas }];
    if (!relayerIsOwner) xodeFunding.push({ evmAddress: relayer.address, target: gas });
    xodeFunding.push(...buyerFunding);
    await setUpSubstrateChain("xode", xode, assetOwner, usdtRecipients, xodeFunding);
  } finally {
    await xode.disconnect();
  }

  // NonceManager: a plain Wallet re-reads the pending nonce on every send, which races when
  // several transactions go out back to back (see test/e2e.manual.ts).
  const xodeProvider = new ethers.JsonRpcProvider(XODE_ETH_RPC);
  const xodeOwner = new ethers.NonceManager(owner.connect(xodeProvider));
  const xodeUsdt = precompileAddr(ASSET_ID);
  const vending = await deployOrReuse("xode: XonVendingMachine", loadArtifact("XonVendingMachine.sol/XonVendingMachine.json"), xodeOwner,
    process.env.VENDING_ADDRESS, [xodeUsdt, owner.address, XON_RATE, relayer.address]);
  await requireOwner("xode", vending.contract, owner.address);
  if ((await vending.contract.relayer()) !== relayer.address) {
    await (await vending.contract.setRelayer(relayer.address)).wait();
    console.log(`[xode] relayer set to ${relayer.address}`);
  }
  const reserve = await xodeProvider.getBalance(vending.address);
  if (reserve < VENDING_RESERVE_XON) {
    await (await xodeOwner.sendTransaction({ to: vending.address, value: VENDING_RESERVE_XON - reserve })).wait();
    console.log(`[xode] XON reserve topped up to ${ethers.formatEther(VENDING_RESERVE_XON)}`);
  }
  if ((await vending.contract.maxExternalPerDeposit()) !== MAX_PER_DEPOSIT || (await vending.contract.maxExternalPerDay()) !== MAX_PER_DAY) {
    await (await vending.contract.setExternalLimits(MAX_PER_DEPOSIT, MAX_PER_DAY)).wait();
    console.log(`[xode] external limits set: ${ethers.formatUnits(MAX_PER_DEPOSIT, 6)} USDT/deposit, ${ethers.formatUnits(MAX_PER_DAY, 6)} USDT/day`);
  }
  Object.assign(out, {
    VENDING_ADDRESS: vending.address,
    MAX_EXTERNAL_DEPOSIT_USDT: ethers.formatUnits(MAX_PER_DEPOSIT, 6),
    MAX_EXTERNAL_DAILY_USDT: ethers.formatUnits(MAX_PER_DAY, 6),
  });
  if (vending.deployBlock !== undefined) out.XODE_START_BLOCK = String(vending.deployBlock);

  const gatewayArtifact = loadArtifact("EthUsdtGateway.sol/EthUsdtGateway.json");

  // --- AssetHub: USDT asset, funding, EthUsdtGateway ---
  out.ENABLE_ASSETHUB_ADAPTER = String(SETUP_ASSETHUB);
  if (SETUP_ASSETHUB) {
    const assetHub = await ApiPromise.create({ provider: new WsProvider(ASSETHUB_WS), noInitWarn: true });
    try {
      await setUpSubstrateChain("assethub", assetHub, assetOwner, usdtRecipients, [{ evmAddress: owner.address, target: gas }, ...buyerFunding]);
    } finally {
      await assetHub.disconnect();
    }
    const ahOwner = new ethers.NonceManager(owner.connect(new ethers.JsonRpcProvider(ASSETHUB_EVM_RPC)));
    const gateway = await deployOrReuse("assethub: EthUsdtGateway", gatewayArtifact, ahOwner,
      process.env.ASSETHUB_GATEWAY_ADDRESS, [precompileAddr(ASSET_ID), owner.address]);
    await requireOwner("assethub", gateway.contract, owner.address);
    Object.assign(out, { ASSETHUB_EVM_RPC, ASSETHUB_GATEWAY_ADDRESS: gateway.address });
    if (gateway.deployBlock !== undefined) out.ASSETHUB_START_BLOCK = String(gateway.deployBlock);
  }

  // --- Ethereum: gas for the owner, a mock USDT (unless ETHEREUM_USDT_ADDRESS is set), EthUsdtGateway ---
  out.ENABLE_ETHEREUM_ADAPTER = String(SETUP_ETHEREUM);
  if (SETUP_ETHEREUM) {
    const ethProvider = new ethers.JsonRpcProvider(ETHEREUM_RPC);
    const { chainId } = await ethProvider.getNetwork();
    const ethOwner = new ethers.NonceManager(owner.connect(ethProvider));
    const ownerBalance = await ethProvider.getBalance(owner.address);
    if (ownerBalance < gas) {
      const funderKey = process.env.ETHEREUM_FUNDER_KEY || (chainId === ANVIL_CHAIN_ID ? ANVIL_DEFAULT_KEY : undefined);
      if (!funderKey) throw new Error(`[ethereum] the contract owner ${owner.address} needs gas on chain ${chainId} - fund it, or set ETHEREUM_FUNDER_KEY.`);
      const funder = new ethers.Wallet(funderKey, ethProvider);
      await (await funder.sendTransaction({ to: owner.address, value: gas - ownerBalance })).wait();
      console.log(`[ethereum] funded ${owner.address} with ${ethers.formatEther(gas - ownerBalance)} ETH`);
    }

    let ethUsdt = process.env.ETHEREUM_USDT_ADDRESS;
    if (!ethUsdt) {
      if (chainId === 1n) throw new Error("[ethereum] this is mainnet - set ETHEREUM_USDT_ADDRESS to real USDT instead of deploying a mock.");
      const mock = await deployOrReuse("ethereum: mock USDT", loadArtifact("MockUSDT.sol/MyToken.json"), ethOwner,
        process.env.ETHEREUM_MOCK_USDT_ADDRESS, ["Tether USD", "USDT", USDT_DECIMALS]);
      ethUsdt = mock.address;
      for (const to of usdtRecipients) {
        await (await mock.contract.mint(to, USDT_MINT)).wait();
        console.log(`[ethereum] minted ${ethers.formatUnits(USDT_MINT, USDT_DECIMALS)} mock USDT to ${to}`);
      }
      out.ETHEREUM_MOCK_USDT_ADDRESS = ethUsdt;
    }
    const gateway = await deployOrReuse("ethereum: EthUsdtGateway", gatewayArtifact, ethOwner,
      process.env.ETH_GATEWAY_ADDRESS, [ethUsdt, owner.address]);
    await requireOwner("ethereum", gateway.contract, owner.address);
    Object.assign(out, { ETHEREUM_RPC, ETH_GATEWAY_ADDRESS: gateway.address });
    if (gateway.deployBlock !== undefined) out.ETHEREUM_START_BLOCK = String(gateway.deployBlock);
  }

  // --- Output ---
  const lines = [
    `# Written by scripts/setup.ts on ${new Date().toISOString()}. Copy what you need into .env.`,
    `# Asset owner (Xode + AssetHub): ${assetOwner.address}, USDT asset id ${ASSET_ID}, precompile ${xodeUsdt}`,
    `# Contract owner: ${owner.address}`,
    `CONTRACT_OWNER_KEY=${ownerKey}`,
    "",
    "# --- Relayer settings ---",
    ...Object.entries(out).map(([k, v]) => `${k}=${v}`),
    "",
  ];
  writeFileSync(OUTPUT_ENV, lines.join("\n"), { mode: 0o600 });
  console.log(`\nDone. Relayer settings written to ${OUTPUT_ENV}`);
  if (relayerIsOwner) console.log("Note: the relayer is using the contract owner's key - fine for dev/test, use a separate relayer key in production.");
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
