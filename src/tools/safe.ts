// Operator command: propose, review, sign and execute transactions from the contracts' Safes (owner
// "ops", "guardian", ...) on Xode, Asset Hub or Ethereum - without Safe's hosted service, which doesn't
// cover the first two. A proposal is a JSON file signers pass around (see src/safe/safeTx.ts).
//
//   npm run safe -- status   --chain <xode|assethub|ethereum> [--safe ops]
//   npm run safe -- propose  <action> --chain <c> [--safe ops] [--nonce n] [--out file]
//        cancels                       (xode) cancel every deposit awaiting a refund, so it can never be paid -
//                                      a refund is only proposed, signed or executed once its deposit is cancelled
//        refunds                       every deposit awaiting a refund on that chain (batched)
//        refund <source tx> [--index n]
//        withdraw <amount> [--asset xon|usdt]   to the treasury (the only place it can go)
//        pause | unpause               (ops)          guardian-pause | cancel-treasury   (guardian)
//        limits --external <perDeposit>,<perDay> | --native <perPurchase>,<perDay>   (Xode, USDT)
//        attester add|remove <address> | threshold <n> | rate <xon per usdt> | address-limit <usdt>   (xode)
//        fixed-rate pause|resume (xode)  |  min-deposit <usdt> | refund-fee <usdt>   (gateways)
//        cancel-change <id>            (guardian) stop a queued change
//        raw --to <address> --data <hex> [--value <wei>]
//     add --queue to queue the calls instead (risky changes - raising limits / the rate / the refund fee,
//     adding an attester, lowering the threshold, a new relayer or keeper - must wait 48h; run the same
//     propose again without --queue once `status` shows them ready)
//   npm run safe -- show       <file>      what it does, who has signed
//   npm run safe -- typed-data <file>      EIP-712 JSON to sign in a wallet (eth_signTypedData_v4)
//   npm run safe -- sign       <file> [--signature <hex>]   key from SAFE_SIGNER_KEY_FILE, or a wallet's signature
//   npm run safe -- execute    <file>      once enough owners signed; gas from SAFE_EXECUTOR_KEY_FILE
//
// SAFE_CONFIG (default safes.json): { "<chain>": { "ops": "0x…", "guardian": "0x…", "treasury": "0x…",
// "multiSendCallOnly": "0x…" } }. RPCs and contract addresses come from the relayer's own settings.

import { ethers } from "ethers";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeProvider } from "../chain.js";
import { config, USDT_DECIMALS } from "../config.js";
import { readLedger } from "../ledger.js";
import {
  bundle, describeCall, packSignatures, reviewCalls, PROPOSAL_FORMAT, safeTx, safeTxHash, serializeTx, signerOf, typedData,
  verifyProposal, type Call, type Proposal,
} from "../safe/safeTx.js";
import { option, runTool } from "./common.js";
import { awaitingRefund, gatewayDeposit, refundTarget, xodeStatus } from "./refundTargets.js";
import GATEWAY_ABI from "../abi/EthUsdtGateway.json" with { type: "json" };
import VENDING_ABI from "../abi/XonVendingMachine.json" with { type: "json" };

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function VERSION() view returns (string)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)",
  "event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)",
  "event ExecutionFailure(bytes32 indexed txHash, uint256 payment)",
];
const CHAINS = ["xode", "assethub", "ethereum"] as const;
type ChainName = (typeof CHAINS)[number];

interface ChainSafes { [role: string]: string | undefined; multiSendCallOnly?: string }

function loadSafeConfig(): Record<string, ChainSafes> {
  const file = process.env.SAFE_CONFIG ?? "safes.json";
  if (!existsSync(file)) throw new Error(`No Safe config at ${file} - set SAFE_CONFIG (see the header of src/tools/safe.ts).`);
  return JSON.parse(readFileSync(file, "utf8"));
}

/// RPC and the contract the Safes govern on each chain, from the relayer's own settings.
function chainTarget(chain: ChainName): { rpc: string; contract: string; kind: "vending" | "gateway"; iface: ethers.Interface } {
  if (chain === "xode") return { rpc: config.xodeEthRpc, contract: config.vendingAddress, kind: "vending", iface: new ethers.Interface(VENDING_ABI) };
  const c = chain === "assethub" ? config.assetHub : config.ethereum;
  if (!c.rpcUrl || !c.gatewayAddress) throw new Error(`No RPC / gateway configured for ${chain}.`);
  return { rpc: c.rpcUrl, contract: c.gatewayAddress, kind: "gateway", iface: new ethers.Interface(GATEWAY_ABI) };
}

function chainOf(value: string | undefined): ChainName {
  if (!CHAINS.includes(value as ChainName)) throw new Error(`--chain must be one of ${CHAINS.join(", ")}.`);
  return value as ChainName;
}

/// A private key from <NAME>_FILE or <NAME> - never from the command line (shell history), never echoed.
function loadKey(name: string): string {
  const file = process.env[`${name}_FILE`];
  const raw = (file ? readFileSync(file, "utf8") : process.env[name] ?? "").trim();
  delete process.env[name];
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`Set ${name}_FILE (or ${name}) to a 32-byte hex private key.`);
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

const usdtUnits = (value: string) => ethers.parseUnits(value, USDT_DECIMALS);

async function context(chain: ChainName, role: string) {
  const safes = loadSafeConfig()[chain] ?? {};
  const safeAddress = safes[role];
  if (!safeAddress) throw new Error(`No "${role}" Safe for ${chain} in the Safe config.`);
  const target = chainTarget(chain);
  const provider = makeProvider(target.rpc, config.rpcTimeoutMs);
  const safe = new ethers.Contract(safeAddress, SAFE_ABI, provider);
  const names: Record<string, string> = { [ethers.getAddress(target.contract)]: target.kind };
  for (const [r, a] of Object.entries(safes)) if (a) names[ethers.getAddress(a)] = r === "multiSendCallOnly" ? "MultiSendCallOnly" : `${r} Safe`;
  return { safes, safeAddress: ethers.getAddress(safeAddress), target, provider, safe, names, multiSend: safes.multiSendCallOnly ?? null };
}

// --- propose ---------------------------------------------------------------------------------------

async function proposeCalls(action: string, args: string[], chain: ChainName, target: ReturnType<typeof chainTarget>): Promise<{ calls: Call[]; description: string }> {
  const call = (fn: string, params: unknown[] = []): Call => ({ to: target.contract, value: 0n, data: target.iface.encodeFunctionData(fn, params) });
  switch (action) {
    case "cancels": {
      if (target.kind !== "vending") throw new Error("Deposits are cancelled on Xode's vending contract (--chain xode).");
      const calls: Call[] = [];
      for (const r of awaitingRefund(readLedger(config.ledgerFile)).filter((x) => x.sourceChain !== "xode")) {
        const label = `${r.sourceChain} ${r.sourceTxHash}${(r.depositIndex ?? 0) > 0 ? ` #${r.depositIndex}` : ""}`;
        try {
          const t = await refundTarget(r);
          if (t.onXode?.paid) { console.warn(`!! ${label} was already PAID on Xode - it must not be refunded.`); continue; }
          if (t.onXode?.cancelled) continue;
          calls.push({ to: t.cancelCall!.to, value: 0n, data: t.cancelCall!.data });
        } catch (err) {
          console.warn(`Leaving out ${label}: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (calls.length === 0) throw new Error("No deposits awaiting a refund that still need cancelling on Xode.");
      return { calls, description: `Cancel ${calls.length} deposit(s) on Xode so they can be refunded on their source chains` };
    }
    case "refunds":
    case "refund": {
      if (target.kind !== "gateway") throw new Error("Refunds are paid from the gateways (assethub / ethereum).");
      let pending = awaitingRefund(readLedger(config.ledgerFile)).filter((r) => r.sourceChain === chain);
      if (action === "refund") {
        const tx = args[0]?.toLowerCase();
        const index = Number(option(args, "--index") ?? 0);
        pending = pending.filter((r) => r.sourceTxHash.toLowerCase() === tx && (r.depositIndex ?? 0) === index);
        if (pending.length === 0) throw new Error(`No deposit ${args[0]} #${index} awaiting a refund on ${chain} (npm run refunds lists them).`);
      }
      const calls: Call[] = [];
      for (const r of pending) {
        try {
          const t = await refundTarget(r);
          if (!t.refundCall) throw new Error("its gateway has no refund() - refund it the old way");
          if (t.onXode?.paid) throw new Error("it was already PAID on Xode - never refund it");
          if (!t.onXode?.cancelled) throw new Error("not cancelled on Xode yet - propose cancels --chain xode, and execute that first");
          calls.push({ to: t.refundCall.to, value: 0n, data: t.refundCall.data });
        } catch (err) {
          // One deposit that can't be resolved (e.g. on a retired gateway) mustn't block the rest.
          if (action === "refund") throw err;
          console.warn(`Leaving out ${r.sourceTxHash}${(r.depositIndex ?? 0) > 0 ? ` #${r.depositIndex}` : ""}: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (calls.length === 0) throw new Error(`No deposits on ${chain} that can be refunded through its gateway.`);
      return { calls, description: `Refund ${calls.length} deposit(s) on ${chain} to their depositors` };
    }
    case "withdraw": {
      const amount = args[0];
      if (!amount) throw new Error("withdraw <amount>");
      if (target.kind === "gateway") return { calls: [call("withdraw", [usdtUnits(amount)])], description: `Withdraw ${amount} USDT to the treasury` };
      const asset = option(args, "--asset");
      if (asset === "xon") return { calls: [call("withdrawXon", [ethers.parseEther(amount)])], description: `Withdraw ${amount} XON to the treasury` };
      if (asset === "usdt") return { calls: [call("withdrawUsdt", [usdtUnits(amount)])], description: `Withdraw ${amount} USDT to the treasury` };
      throw new Error("On Xode, say which: withdraw <amount> --asset xon|usdt");
    }
    case "pause": return { calls: [call("setPaused", [true])], description: `Pause the ${target.kind}` };
    case "unpause": return { calls: [call("setPaused", [false])], description: `Unpause the ${target.kind}` };
    case "guardian-pause": return { calls: [call("guardianPause")], description: `Guardian: pause the ${target.kind}` };
    case "cancel-treasury": return { calls: [call("cancelTreasuryChange")], description: "Cancel the pending treasury change" };
    case "limits": {
      if (target.kind !== "vending") throw new Error("Limits are set on the vending contract (--chain xode).");
      const calls: Call[] = [];
      for (const [flag, fn] of [["--external", "setExternalLimits"], ["--native", "setNativeLimits"]] as const) {
        const v = option(args, flag);
        if (v) { const [per, day] = v.split(","); calls.push(call(fn, [usdtUnits(per), usdtUnits(day)])); }
      }
      if (calls.length === 0) throw new Error("limits --external <perDeposit>,<perDay> and/or --native <perPurchase>,<perDay>");
      return { calls, description: "Change payout limits" };
    }
    case "attester": {
      if (target.kind !== "vending") throw new Error("Attesters are on the vending contract (--chain xode).");
      const [op, who] = args;
      if ((op !== "add" && op !== "remove") || !who || !ethers.isAddress(who)) throw new Error("attester add|remove <address>");
      return { calls: [call(op === "add" ? "addAttester" : "removeAttester", [ethers.getAddress(who)])], description: `${op === "add" ? "Add" : "Remove"} attester ${who}` };
    }
    case "threshold": return { calls: [call("setAttestationThreshold", [BigInt(args[0])])], description: `Attestation threshold ${args[0]}` };
    case "rate": return { calls: [call("setRate", [ethers.parseEther(args[0])])], description: `Fixed rate ${args[0]} XON per USDT` };
    case "address-limit": return { calls: [call("setAddressLimit", [usdtUnits(args[0])])], description: `Per-address daily limit ${args[0]} USDT` };
    case "fixed-rate": {
      if (args[0] !== "pause" && args[0] !== "resume") throw new Error("fixed-rate pause|resume");
      return { calls: [call("setFixedRatePaused", [args[0] === "pause"])], description: `${args[0] === "pause" ? "Pause" : "Resume"} the fixed-rate paths` };
    }
    case "min-deposit": return { calls: [call("setMinDeposit", [usdtUnits(args[0])])], description: `Minimum deposit ${args[0]} USDT` };
    case "refund-fee": return { calls: [call("setRefundFee", [usdtUnits(args[0])])], description: `Refund fee ${args[0]} USDT` };
    case "cancel-change": {
      if (!args[0] || !ethers.isHexString(args[0], 32)) throw new Error("cancel-change <id> (from status)");
      return { calls: [call("cancelChange", [args[0]])], description: `Cancel queued change ${args[0]}` };
    }
    case "raw": {
      const to = option(args, "--to"), data = option(args, "--data") ?? "0x";
      if (!to || !ethers.isAddress(to) || !ethers.isHexString(data)) throw new Error("raw --to <address> --data <hex> [--value <wei>]");
      return { calls: [{ to: ethers.getAddress(to), value: BigInt(option(args, "--value") ?? 0), data }], description: option(args, "--description") ?? "Raw call" };
    }
    default:
      throw new Error(`Unknown action "${action}".`);
  }
}

async function propose(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const chain = chainOf(option(rest, "--chain"));
  const role = option(rest, "--safe") ?? (["guardian-pause", "cancel-treasury", "cancel-change"].includes(action) ? "guardian" : "ops");
  const ctx = await context(chain, role);
  const proposed = await proposeCalls(action, rest.filter((a) => !a.startsWith("--chain") && a !== chain && a !== "--queue"), chain, ctx.target);
  let { calls, description } = proposed;
  if (rest.includes("--queue")) {
    // Each call is queued with its exact calldata; the same propose without --queue runs it in 48h.
    calls = calls.map((c) => ({ to: c.to, value: 0n, data: ctx.target.iface.encodeFunctionData("queueChange", [c.data]) }));
    description = `Queue (runs in 48h unless the guardian cancels): ${description}`;
  }
  const { call, operation } = bundle(calls, ctx.multiSend);
  const nonce = option(rest, "--nonce") !== undefined ? BigInt(option(rest, "--nonce")!) : await ctx.safe.nonce();
  const { chainId } = await ctx.provider.getNetwork();
  const tx = safeTx(call, operation, nonce);
  const hash = safeTxHash(chainId, ctx.safeAddress, tx);
  const onChainHash: string = await ctx.safe.getTransactionHash(tx.to, tx.value, tx.data, tx.operation, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, tx.nonce);
  if (onChainHash !== hash) throw new Error(`The Safe computes ${onChainHash} for this transaction, not ${hash} - wrong chain or not a Safe v1.4.1?`);

  const proposal: Proposal = {
    format: PROPOSAL_FORMAT, chain, chainId: chainId.toString(), safe: ctx.safeAddress, safeRole: role, description,
    calls: calls.map((c) => ({ to: ethers.getAddress(c.to), value: c.value.toString(), data: c.data, decoded: describeCall(c, ctx.names) })),
    tx: serializeTx(tx), safeTxHash: hash, signatures: {},
  };
  const out = option(rest, "--out") ?? path.join(process.env.SAFE_PROPOSALS_DIR ?? "safe-proposals", `${chain}-${role}-${nonce}-${action}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(proposal, null, 2));
  review(proposal, null, null, ctx.names);
  console.log(`\nWrote ${out}. Signers: npm run safe -- sign ${out}`);
}

// --- show / sign / execute ------------------------------------------------------------------------

function load(file: string | undefined): Proposal {
  if (!file || !existsSync(file)) throw new Error("Give the proposal file.");
  return JSON.parse(readFileSync(file, "utf8"));
}

function review(p: Proposal, owners: string[] | null, threshold: bigint | null, names: Record<string, string> = {}): void {
  // The description is the proposer's words; the numbered calls below are decoded from the actual
  // calldata (which verifyProposal ties to the signed transaction) - judge by those.
  console.log(`${p.description}  [proposer's description]\n  chain ${p.chain} (${p.chainId}), ${p.safeRole} Safe ${p.safe}, nonce ${p.tx.nonce}${p.tx.operation === 1 ? ", batched (MultiSendCallOnly, all or nothing)" : ""}`);
  reviewCalls(p, names).forEach((line, i) => console.log(`  ${i + 1}. ${line}`));
  console.log(`  safeTxHash ${p.safeTxHash}`);
  const signed = Object.keys(p.signatures);
  if (owners && threshold !== null) {
    console.log(`  signed by ${signed.length} of ${threshold} needed: ${signed.join(", ") || "nobody yet"}`);
    const outsiders = signed.filter((s) => !owners.includes(s));
    if (outsiders.length) console.log(`  !! not owners any more: ${outsiders.join(", ")}`);
  } else if (signed.length) {
    console.log(`  signed by: ${signed.join(", ")}`);
  }
  if (p.executed) console.log(`  executed in tx ${p.executed.txHash} (block ${p.executed.block})`);
}

/// Loads a proposal and checks it against the file itself and against the live Safe.
async function checked(file: string | undefined) {
  const p = load(file);
  const chain = chainOf(p.chain);
  const ctx = await context(chain, p.safeRole);
  if (ctx.safeAddress !== ethers.getAddress(p.safe)) throw new Error(`The config's ${p.safeRole} Safe on ${chain} is ${ctx.safeAddress}, but the proposal is for ${p.safe}.`);
  const tx = verifyProposal(p, ctx.multiSend);
  const { chainId } = await ctx.provider.getNetwork();
  if (chainId.toString() !== p.chainId) throw new Error(`The RPC is chain ${chainId}, the proposal is for ${p.chainId}.`);
  const onChainHash: string = await ctx.safe.getTransactionHash(tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce);
  if (onChainHash !== p.safeTxHash) throw new Error("The Safe computes a different hash for this transaction - refusing.");
  const [owners, threshold, nonce] = await Promise.all([ctx.safe.getOwners() as Promise<string[]>, ctx.safe.getThreshold() as Promise<bigint>, ctx.safe.nonce() as Promise<bigint>]);
  if (tx.nonce < nonce) throw new Error(`The Safe is already at nonce ${nonce}; this proposal (nonce ${tx.nonce}) is spent or stale.`);
  if (!p.executed) await guardRefunds(p, chain, ctx.provider);
  return { p, tx, ctx, names: ctx.names, owners: owners.map((o) => ethers.getAddress(o)), threshold, nonce };
}

/// No refund goes out - whoever proposed it, however it was built (even `raw`) - unless its deposit
/// is cancelled on Xode, which in turn is only possible while it hasn't been paid there. Checked from
/// the chains themselves at sign time and again at execute time.
async function guardRefunds(p: Proposal, chain: ChainName, provider: ethers.JsonRpcProvider): Promise<void> {
  if (chain === "xode") return;
  const gateway = new ethers.Interface(GATEWAY_ABI);
  for (const c of p.calls) {
    let parsed: ethers.TransactionDescription | null = null;
    try { parsed = gateway.parseTransaction({ data: c.data }); } catch { parsed = null; }
    if (parsed?.name !== "refund") continue;
    const nonce: bigint = parsed.args[0];
    const deposit = await gatewayDeposit(provider, ethers.getAddress(c.to), chain, nonce);
    const { paid, cancelled } = await xodeStatus(deposit.depositId);
    if (paid) throw new Error(`Deposit #${nonce} (${deposit.txHash}) was PAID on Xode - refusing a refund of it.`);
    if (!cancelled) throw new Error(`Deposit #${nonce} (${deposit.txHash}) isn't cancelled on Xode yet - execute the cancel first (propose cancels --chain xode).`);
  }
}

async function sign(args: string[]): Promise<void> {
  const file = args[0];
  const { p, tx, owners, threshold, names } = await checked(file);
  if (p.executed) throw new Error("Already executed.");
  const pasted = option(args, "--signature");
  let signature: string;
  if (pasted) {
    signature = ethers.Signature.from(pasted).serialized;
  } else {
    const wallet = new ethers.Wallet(loadKey("SAFE_SIGNER_KEY"));
    const { domain, types, message } = typedData(BigInt(p.chainId), p.safe, tx);
    signature = await wallet.signTypedData(domain, types, message);
  }
  const signer = signerOf(p.safeTxHash, signature);
  if (!owners.includes(signer)) throw new Error(`${signer} isn't an owner of the ${p.safeRole} Safe.`);
  review(p, owners, threshold, names);
  p.signatures[signer] = signature;
  writeFileSync(file, JSON.stringify(p, null, 2));
  console.log(`\nSigned by ${signer} - ${Object.keys(p.signatures).filter((s) => owners.includes(s)).length} of ${threshold}.`);
}

async function execute(args: string[]): Promise<void> {
  const file = args[0];
  const { p, tx, ctx, owners, threshold, nonce, names } = await checked(file);
  if (p.executed) throw new Error(`Already executed in ${p.executed.txHash}.`);
  if (tx.nonce !== nonce) throw new Error(`The Safe is at nonce ${nonce}; execute the proposal for that nonce first.`);
  const valid = Object.fromEntries(Object.entries(p.signatures).filter(([o]) => owners.includes(ethers.getAddress(o))));
  if (BigInt(Object.keys(valid).length) < threshold) throw new Error(`${Object.keys(valid).length} of ${threshold} owner signatures - not enough yet.`);
  review(p, owners, threshold, names);
  const executor = new ethers.Wallet(loadKey("SAFE_EXECUTOR_KEY"), ctx.provider);
  const safe = ctx.safe.connect(executor) as ethers.Contract;
  const sigs = packSignatures(valid);
  const params = [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, sigs] as const;
  await safe.execTransaction.staticCall(...params); // fails here, before spending gas, if anything's wrong
  const receipt = await (await safe.execTransaction(...params)).wait();
  const events = receipt!.logs.map((l: ethers.Log) => { try { return safe.interface.parseLog(l)?.name; } catch { return null; } });
  if (!events.includes("ExecutionSuccess")) throw new Error(`The Safe ran it but the call failed (ExecutionFailure) - tx ${receipt!.hash}.`);
  p.executed = { txHash: receipt!.hash, block: receipt!.blockNumber };
  writeFileSync(file, JSON.stringify(p, null, 2));
  console.log(`\nExecuted in ${receipt!.hash} (block ${receipt!.blockNumber}).`);
  if (p.description.startsWith("Refund")) console.log(`Record each refund: npm run refunds -- mark <source tx> ${receipt!.hash}`);
}

async function status(args: string[]): Promise<void> {
  const chain = chainOf(option(args, "--chain"));
  const ctx = await context(chain, option(args, "--safe") ?? "ops");
  const [version, owners, threshold, nonce] = await Promise.all([ctx.safe.VERSION(), ctx.safe.getOwners(), ctx.safe.getThreshold(), ctx.safe.nonce()]);
  console.log(`${option(args, "--safe") ?? "ops"} Safe ${ctx.safeAddress} on ${chain}: Safe ${version}, ${threshold}-of-${owners.length}, nonce ${nonce}`);
  for (const o of owners) console.log(`  owner ${o}`);
  const t = new ethers.Contract(ctx.target.contract, ctx.target.iface, ctx.provider);
  const [owner, treasury, guardian, paused] = await Promise.all([t.owner(), t.treasury(), t.guardian(), t.paused()]);
  console.log(`${ctx.target.kind} ${ctx.target.contract}: owner ${ctx.names[ethers.getAddress(owner)] ?? owner}, treasury ${ctx.names[ethers.getAddress(treasury)] ?? treasury}, guardian ${ctx.names[ethers.getAddress(guardian)] ?? guardian}${paused ? ", PAUSED" : ""}`);
  if (ctx.target.kind === "vending") {
    const [count, threshold_, fixedPaused, addressLimit] = await Promise.all([t.attesterCount(), t.attestationThreshold(), t.fixedRatePaused(), t.maxPerAddressPerDay()]);
    console.log(`  attesters: ${threshold_} of ${count} must vote; fixed-rate paths ${fixedPaused ? "PAUSED" : "open"}; per-address limit ${addressLimit === 0n ? "none" : `${ethers.formatUnits(addressLimit, USDT_DECIMALS)} USDT/day`}`);
  } else {
    const [minDeposit, refundFee] = await Promise.all([t.minDeposit(), t.refundFee()]);
    console.log(`  minimum deposit ${ethers.formatUnits(minDeposit, USDT_DECIMALS)} USDT, refund fee ${ethers.formatUnits(refundFee, USDT_DECIMALS)} USDT`);
  }
  // Queued changes still pending: what a compromised owner would have to announce 48h ahead.
  const now = BigInt((await ctx.provider.getBlock("latest"))!.timestamp);
  const queued = await t.queryFilter(t.filters.ChangeQueued(), 0, "latest");
  const seen = new Set<string>();
  for (const e of queued.reverse()) {
    const { id, call } = (e as ethers.EventLog).args;
    if (seen.has(id)) continue;
    seen.add(id);
    const readyAt: bigint = await t.queuedChangeReadyAt(id);
    if (readyAt === 0n) continue;
    const when = readyAt <= now ? "READY" : `ready in ${((readyAt - now) / 3600n).toString()}h`;
    console.log(`  queued ${id}: ${describeCall({ to: ctx.target.contract, value: 0n, data: call }, ctx.names)} - ${when}`);
  }
}

runTool(async () => {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "status": return status(args);
    case "propose": return propose(args);
    case "show": { const p = load(args[0]); verifyProposal(p, (loadSafeConfig()[p.chain] ?? {}).multiSendCallOnly ?? null); return review(p, null, null); }
    case "typed-data": { const p = load(args[0]); const tx = verifyProposal(p, (loadSafeConfig()[p.chain] ?? {}).multiSendCallOnly ?? null); console.log(JSON.stringify(typedData(BigInt(p.chainId), p.safe, tx), (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)); return; }
    case "sign": return sign(args);
    case "execute": return execute(args);
    default: throw new Error("Usage: npm run safe -- <status|propose|show|typed-data|sign|execute> ... (see src/tools/safe.ts)");
  }
});
