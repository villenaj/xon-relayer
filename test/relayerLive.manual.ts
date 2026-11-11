// Manual, live test of how the relayer behaves around a deposit that can't be paid yet, with two
// attesters each running their own instance (the contracts from `npm run setup` with ATTESTERS=3,
// threshold 2 - setup.out.env):
//
//   1. the rate keeper pauses the fixed-rate paths;
//   2. a fixed-rate AssetHub deposit arrives (can't be paid while paused), then a market-price one;
//   3. the market-price deposit must be paid although the one before it is waiting;
//   4. the keeper lifts the pause, and the fixed-rate deposit must be paid without anyone releasing it;
//   6. a deposit whose own minimum can't be met is cancelled by the attesters' votes and refunded
//      with their signatures by a stranger - no owner transaction - and the gateway never lets
//      USDT it still owes depositors be withdrawn;
//   5. each instance's ledger must account for both payouts (one executed it, the other records it
//      as paid elsewhere), and `reconcile` must not call the other attester's payouts unrecorded.
//
// Needs the local stack (zombienet's start.sh) and setup.out.env. Usage: npm run test:live

import { ApiPromise, WsProvider } from "@polkadot/api";
import { parse as parseEnv } from "dotenv";
import { ethers } from "ethers";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectRefundSignatures } from "../src/adapters/attestedRefund.js";
import { readLedger } from "../src/ledger.js";
import { externalDepositId } from "../src/settlement.js";
import VENDING_ABI from "../src/abi/XonVendingMachine.json" with { type: "json" };
import GATEWAY_ABI from "../src/abi/EthUsdtGateway.json" with { type: "json" };

const REPO = fileURLToPath(new URL("..", import.meta.url));
const XODE_WS = process.env.XODE_WS ?? "ws://127.0.0.1:9977";
const USDT = (whole: string) => ethers.parseUnits(whole, 6);

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`  timed out waiting for ${what}`);
  return false;
}

/// Sends a transaction and waits for it, failing loudly (rather than hanging) if it isn't mined.
async function mined(what: string, send: Promise<ethers.TransactionResponse>, timeoutMs = 180_000): Promise<ethers.TransactionReceipt> {
  const tx = await send;
  const receipt = await Promise.race([tx.wait(), new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
  if (!receipt) throw new Error(`${what}: tx ${tx.hash} (nonce ${tx.nonce}) wasn't mined within ${timeoutMs / 1000}s`);
  return receipt;
}

async function main(): Promise<void> {
  const setup = parseEnv(readFileSync(path.join(REPO, process.env.SETUP_OUTPUT ?? "setup.out.env")));
  const xode = new ethers.JsonRpcProvider(setup.XODE_ETH_RPC);
  const assetHub = new ethers.JsonRpcProvider(setup.ASSETHUB_EVM_RPC);
  const vending = new ethers.Contract(setup.VENDING_ADDRESS, VENDING_ABI, xode);
  const keeper = new ethers.Wallet(setup.RATE_KEEPER_PRIVATE_KEY, xode);
  const depositor = new ethers.Wallet(setup.CONTRACT_OWNER_KEY, assetHub); // holds the test USDT on AssetHub
  const gateway = new ethers.Contract(setup.ASSETHUB_GATEWAY_ADDRESS, GATEWAY_ABI, depositor);
  const usdt = new ethers.Contract(await gateway.usdt(), ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], depositor);
  const threshold: bigint = await vending.attestationThreshold();
  console.log(`Vending ${setup.VENDING_ADDRESS}: ${await vending.attesterCount()} attesters, threshold ${threshold}`);
  if (threshold !== 2n) throw new Error("This test expects a 2-of-n attester setup (npm run setup with ATTESTERS=3).");

  let failed = false;
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "PASS" : "FAIL"}: ${what}`);
    if (!ok) failed = true;
  };

  // --- Two attester instances, each with its own state, starting at the current heads -----------
  const chainIds = { XODE_CHAIN_ID: String((await xode.getNetwork()).chainId), ASSETHUB_CHAIN_ID: String((await assetHub.getNetwork()).chainId) };
  const startBlocks = { XODE_START_BLOCK: String(await xode.getBlockNumber()), ASSETHUB_START_BLOCK: String(await assetHub.getBlockNumber()) };
  const instances = [setup.RELAYER_PRIVATE_KEY, setup.ATTESTER_2_PRIVATE_KEY].map((key, i) => {
    const dir = mkdtempSync(path.join(tmpdir(), `xon-attester-${i + 1}-`));
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME,
      XODE_ETH_RPC: setup.XODE_ETH_RPC, VENDING_ADDRESS: setup.VENDING_ADDRESS, XODE_SUBSTRATE_RPC: XODE_WS,
      ASSETHUB_EVM_RPC: setup.ASSETHUB_EVM_RPC, ASSETHUB_GATEWAY_ADDRESS: setup.ASSETHUB_GATEWAY_ADDRESS,
      ENABLE_XODE_ADAPTER: "false", ENABLE_ASSETHUB_ADAPTER: "true", ENABLE_ETHEREUM_ADAPTER: "false", ETHEREUM_RPC: "", ETH_GATEWAY_ADDRESS: "",
      ...chainIds, ...startBlocks, ETHEREUM_CHAIN_ID: "",
      RELAYER_PRIVATE_KEY: key, RELAYER_PRIVATE_KEY_FILE: "", CREDENTIALS_DIRECTORY: "", RATE_KEEPER_PRIVATE_KEY: "", ALERT_WEBHOOK_URL: "",
      CHECKPOINT_DIR: dir, LEDGER_FILE: path.join(dir, "ledger.jsonl"), HTTP_PORT: "0",
      // Finalized, not a block count: AssetHub's head is reorged routinely, and its eth-rpc stops
      // returning a block's logs from shortly after it's built until it's final (about 30s) - a
      // scan a few blocks behind the head silently misses deposits.
      POLL_INTERVAL_MS: "2000", ASSETHUB_CONFIRMATIONS: "finalized", XODE_CONFIRMATIONS: "0", SETTLE_JITTER_MS: "0",
      MAX_EXTERNAL_DEPOSIT_USDT: setup.MAX_EXTERNAL_DEPOSIT_USDT, MAX_EXTERNAL_DAILY_USDT: setup.MAX_EXTERNAL_DAILY_USDT,
    };
    const proc: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
    const tag = `[attester ${i + 1}] `;
    const show = (d: Buffer) => process.stdout.write(String(d).split("\n").filter(Boolean).map((l) => tag + l).join("\n") + "\n");
    proc.stdout!.on("data", show);
    proc.stderr!.on("data", show);
    return { dir, env, proc, ledger: path.join(dir, "ledger.jsonl") };
  });
  await new Promise((r) => setTimeout(r, 15_000)); // let both connect

  const api = await ApiPromise.create({ provider: new WsProvider(XODE_WS), noInitWarn: true });
  let paused = false;
  try {
    if (instances.some((i) => i.proc.exitCode !== null)) throw new Error("a relayer instance exited at startup");

    // --- 1. Pause the fixed-rate paths ---------------------------------------------------------
    await (await (vending.connect(keeper) as ethers.Contract).keeperPauseFixedRate(true)).wait();
    paused = true;
    check(await vending.fixedRatePaused(), "the rate keeper paused the fixed-rate paths");

    // --- 2. A fixed-rate deposit, then a market-price one --------------------------------------
    const fixedBeneficiary = ethers.Wallet.createRandom().address;
    const swapBeneficiary = ethers.Wallet.createRandom().address;
    await (await usdt.approve(await gateway.getAddress(), USDT("5"))).wait();
    const fixedTx = await (await gateway.deposit(USDT("2"), fixedBeneficiary, 1n)).wait();
    const quoted = await api.call.assetConversionApi.quotePriceExactTokensForTokens(
      { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: 1984 }] } }, { parents: 1, interior: "Here" }, USDT("3"), true);
    const minXonOut = (BigInt(quoted.toString()) * 1_000_000n * 90n) / 100n; // 10% under the quote
    const swapTx = await (await gateway.depositForSwap(USDT("3"), swapBeneficiary, minXonOut)).wait();
    const fixedId = externalDepositId("assethub", fixedTx.hash);
    const swapId = externalDepositId("assethub", swapTx.hash);
    console.log(`fixed-rate deposit ${fixedTx.hash} (block ${fixedTx.blockNumber}), market-price deposit ${swapTx.hash} (block ${swapTx.blockNumber})`);

    // --- 3. The later deposit is paid while the earlier one waits ------------------------------
    const swapPaid = await waitFor("the market-price deposit", () => vending.externalSettledDeposits(swapId), 180_000);
    check(swapPaid, "the market-price deposit was paid...");
    check(!(await vending.externalSettledDeposits(fixedId)), "...while the fixed-rate deposit before it is still waiting on the pause");
    check((await xode.getBalance(swapBeneficiary)) > 0n, `its beneficiary holds XON (${ethers.formatEther(await xode.getBalance(swapBeneficiary))} spendable)`);

    // --- 4. Lifting the pause pays the waiting deposit, with nobody releasing it --------------
    await (await (vending.connect(keeper) as ethers.Contract).keeperPauseFixedRate(false)).wait();
    paused = false;
    const fixedPaid = await waitFor("the fixed-rate deposit", () => vending.externalSettledDeposits(fixedId), 420_000);
    check(fixedPaid, "after the pause lifted, the fixed-rate deposit was paid automatically");

    // --- 5. Both instances account for both payouts -------------------------------------------
    // A relayer writes its ledger line once its own RPC confirms the settle, which can trail the
    // chain by a while - wait until both instances have recorded both payouts.
    const recordedBoth = (file: string) => [swapId, fixedId].every((id) => readLedger(file).some((r) => r.depositId.toLowerCase() === id.toLowerCase() && (r.status === "settled" || r.status === "already-settled")));
    await waitFor("both ledgers to record both payouts", async () => instances.every((i) => recordedBoth(i.ledger)), 180_000);
    for (const [i, instance] of instances.entries()) {
      const records = readLedger(instance.ledger);
      for (const [name, id] of [["market-price", swapId], ["fixed-rate", fixedId]] as const) {
        const mine = records.filter((r) => r.depositId.toLowerCase() === id.toLowerCase() && (r.status === "settled" || r.status === "already-settled"));
        check(mine.length > 0, `attester ${i + 1}'s ledger has the ${name} payout (${mine.map((r) => `${r.status}${r.error ? `/${r.error}` : ""}`).join(", ") || "nothing"})`);
      }
      check(!records.some((r) => r.status === "held"), `attester ${i + 1} held nothing for an operator`);
    }
    const executed = (id: string) => instances.filter((inst) => readLedger(inst.ledger).some((r) => r.depositId.toLowerCase() === id.toLowerCase() && r.status === "settled")).length;
    check(executed(swapId) === 1 && executed(fixedId) === 1, "each payout was executed by exactly one instance");

    // --- 6. A deposit that can't be paid is cancelled and refunded by the attesters alone ------
    // A fixed-rate deposit whose own minimum the rate can't meet (as if the rate had been cut
    // after it was made). No owner transaction on either chain from here on.
    await (await usdt.approve(await gateway.getAddress(), USDT("4"))).wait();
    const doomedTx = await (await gateway.deposit(USDT("4"), fixedBeneficiary, ethers.parseEther("1000000"))).wait();
    const doomedId = externalDepositId("assethub", doomedTx.hash);
    const doomed = doomedTx.logs.map((l: ethers.Log) => gateway.interface.parseLog(l)).find((e: ethers.LogDescription | null) => e?.name === "Deposited")!;
    const nonce: bigint = doomed.args.depositNonce;
    console.log(`unpayable deposit ${doomedTx.hash} (gateway nonce ${nonce})`);
    const balanceAfterDeposit: bigint = await usdt.balanceOf(depositor.address);

    // The gateway's reserve: every unpaid deposit is owed, and nothing owed can be withdrawn.
    const [owed, held]: bigint[] = await Promise.all([gateway.owed(), usdt.balanceOf(await gateway.getAddress())]);
    const free: bigint = await gateway.withdrawable();
    check(free === held - owed && owed >= USDT("4"), `the gateway holds ${ethers.formatUnits(held, 6)} USDT and owes depositors ${ethers.formatUnits(owed, 6)} of it - only ${ethers.formatUnits(free, 6)} (refund fees) is withdrawable`);
    const withdrawRefused = await gateway.withdraw.staticCall(free + 1n).then(() => false, (e: { data?: string }) => gateway.interface.parseError(e.data ?? "0x")?.name === "OwedToDepositors");
    check(withdrawRefused, "the owner can't withdraw any of what's owed (OwedToDepositors)");

    const cancelled = await waitFor("the attesters to cancel it", () => vending.externalCancelled(doomedId), 300_000);
    check(cancelled, "the attesters cancelled the deposit on Xode by vote");
    check(!(await vending.externalSettledDeposits(doomedId)), "it was not paid");
    check(await vending.cancelChargesFee(doomedId), "their vote fixed the refund fee (its own minimum wasn't met)");

    const digest: string = await gateway.refundDigest(nonce, depositor.address, USDT("4"), true);
    let signatures: { signer: string; signature: string }[] = [];
    const signed = await waitFor("two refund signatures", async () => {
      const logs = await xode.getLogs({ address: setup.VENDING_ADDRESS, topics: [vending.interface.getEvent("RefundSigned")!.topicHash, doomedId], fromBlock: Number(startBlocks.XODE_START_BLOCK), toBlock: "latest" });
      signatures = await collectRefundSignatures(logs, vending.interface, digest, (a) => gateway.isAttester(a));
      return signatures.length >= 2;
    }, 300_000);
    check(signed, `${signatures.length} attesters published refund signatures on Xode`);

    // Anyone can submit them: a fresh account that is neither owner nor attester.
    const anyone = ethers.Wallet.createRandom().connect(assetHub);
    await mined("funding the stranger", depositor.sendTransaction({ to: anyone.address, value: ethers.parseEther("5") }));
    const refundFee: bigint = await gateway.refundFee();
    await mined("the stranger's refund", (gateway.connect(anyone) as ethers.Contract).refundAttested(nonce, depositor.address, USDT("4"), true, signatures.slice(0, 2).map((s) => s.signature)));
    const refunded: bigint = (await usdt.balanceOf(depositor.address)) - balanceAfterDeposit;
    check(refunded === USDT("4") - refundFee, `a stranger submitted the refund: the depositor got ${ethers.formatUnits(refunded, 6)} USDT back (4 less the ${ethers.formatUnits(refundFee, 6)} fee)`);
    check((await gateway.owed()) === owed - USDT("4") && (await gateway.withdrawable()) === free + refundFee, "the deposit is no longer owed; only its fee became withdrawable");
    const again = await (gateway.connect(anyone) as ethers.Contract).refundAttested.staticCall(nonce, depositor.address, USDT("4"), true, signatures.slice(0, 2).map((s) => s.signature)).then(() => false, () => true);
    check(again, "the same signatures can't refund it twice");

    for (const instance of instances) instance.proc.kill();
    await new Promise((r) => setTimeout(r, 3000));
    for (const [i, instance] of instances.entries()) {
      const out = spawnSync(process.execPath, ["--import", "tsx", "src/tools/reconcile.ts"], { cwd: REPO, env: instance.env, encoding: "utf8" });
      const text = `${out.stdout}${out.stderr}`;
      const lines = text.split("\n").filter((l) => /!!|No problems|PROBLEMS|Payouts \(|Deposits on/.test(l));
      console.log(`reconcile (attester ${i + 1}):\n${lines.map((l) => `    ${l.trim().slice(0, 300)}`).join("\n")}`);
      check(!/UNRECORDED PAYOUT/.test(text), `attester ${i + 1}'s reconcile reports no unrecorded payout`);
      check(!/MISSED DEPOSIT|MISMATCH/.test(text), `attester ${i + 1}'s reconcile reports no missed deposit or mismatch`);
    }

    console.log(failed ? "\nFAILURE" : "\nSUCCESS");
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (paused) await (await (vending.connect(keeper) as ethers.Contract).keeperPauseFixedRate(false)).wait().catch(() => undefined);
    for (const instance of instances) instance.proc.kill();
    await api.disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
