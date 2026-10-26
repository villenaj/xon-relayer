import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { ethers, type Log } from "ethers";
import { DEPOSITED_TOPIC, TRANSFER_TOPIC } from "../../src/tools/common.js";
import { depositIdAt, externalDepositId } from "../../src/settlement.js";
import ERC20_ABI from "../../src/abi/IERC20.json" with { type: "json" };
import GATEWAY_ABI from "../../src/abi/EthUsdtGateway.json" with { type: "json" };

// The API modules read USDT_DECIMALS from config.js, which needs VENDING_ADDRESS set to load.
process.env.VENDING_ADDRESS ??= "0x00000000000000000000000000000000000000aa";
const { ApiError, listen, makeHandler, StreamRegistry } = await import("../../src/api/http.js");
const { parseUsdt, purchaseSteps, approveSteps } = await import("../../src/api/transactions.js");
const { depositsInLogs } = await import("../../src/api/service.js");

const USDT = ethers.getAddress("0x00000000000000000000000000000000000000aa");
const VENDING = ethers.getAddress("0x00000000000000000000000000000000000000bb");
const GATEWAY = ethers.getAddress("0x00000000000000000000000000000000000000cc");
const BUYER = "0x1111111111111111111111111111111111111111";
const BENEFICIARY = "0x2222222222222222222222222222222222222222";

const usdt = new ethers.Contract(USDT, ERC20_ABI);
const gateway = new ethers.Contract(GATEWAY, GATEWAY_ABI);
const xode = { name: "xode" as const, chainId: 3417n, usdt, usdtAddress: USDT, payTo: VENDING, gateway: null, approveResetsToZero: false };
const assetHub = { ...xode, name: "assethub" as const, chainId: 420420421n, payTo: GATEWAY, gateway };
const ethereum = { ...assetHub, name: "ethereum" as const, chainId: 1n, approveResetsToZero: true };

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof ApiError ? err.code : "not an ApiError";
  }
  return undefined;
}

test("USDT amounts parse to raw units and reject junk, zero and extra decimals", () => {
  assert.equal(parseUsdt("12.5"), 12_500_000n);
  assert.equal(parseUsdt(3), 3_000_000n);
  for (const bad of ["0", "-1", "abc", "1.0000001", null, undefined, {}]) {
    assert.equal(errorCode(() => parseUsdt(bad)), "InvalidAmount", `rejects ${JSON.stringify(bad)}`);
  }
});

test("a Xode purchase is one USDT transfer into the vending contract, paid to the sender only", () => {
  const [step, ...rest] = purchaseSteps(xode, BUYER, 5_000_000n, BUYER, 0n);
  assert.equal(rest.length, 0);
  assert.equal(step.kind, "transfer");
  assert.equal(step.tx.to, USDT);
  assert.equal(step.tx.chainId, "0xd59");
  assert.deepEqual([...usdt.interface.decodeFunctionData("transfer", step.tx.data)], [VENDING, 5_000_000n]);
  assert.equal(errorCode(() => purchaseSteps(xode, BUYER, 5_000_000n, BENEFICIARY, 0n)), "BeneficiaryNotSupported");
});

test("a gateway purchase approves only what's missing, then deposits for the beneficiary", () => {
  const steps = purchaseSteps(assetHub, BUYER, 5_000_000n, BENEFICIARY, 0n);
  assert.deepEqual(steps.map((s) => s.kind), ["approve", "deposit"]);
  assert.equal(steps[0].tx.to, USDT);
  assert.deepEqual([...usdt.interface.decodeFunctionData("approve", steps[0].tx.data)], [GATEWAY, 5_000_000n]);
  assert.equal(steps[1].tx.to, GATEWAY);
  assert.deepEqual([...gateway.interface.decodeFunctionData("deposit", steps[1].tx.data)], [5_000_000n, BENEFICIARY]);

  const approved = purchaseSteps(assetHub, BUYER, 5_000_000n, BENEFICIARY, 5_000_000n);
  assert.deepEqual(approved.map((s) => s.kind), ["deposit"], "enough allowance already - no approve");
});

test("on Ethereum a non-zero allowance is reset to 0 before raising it (USDT requires it)", () => {
  const steps = approveSteps(ethereum, BUYER, 5_000_000n, 1_000_000n);
  assert.deepEqual(steps.map((s) => usdt.interface.decodeFunctionData("approve", s.tx.data)[1]), [0n, 5_000_000n]);
  assert.equal(approveSteps(ethereum, BUYER, 5_000_000n, 0n).length, 1, "nothing to reset from 0");
  assert.equal(approveSteps(assetHub, BUYER, 5_000_000n, 1_000_000n).length, 1, "only Ethereum needs the reset");
  assert.equal(errorCode(() => approveSteps(xode, BUYER, 1n, 0n)), "NoApprovalNeeded");
});

function log(address: string, topics: string[], data: string, index: number): Log {
  return { address, topics, data, index, transactionHash: "0x" + "ab".repeat(32), blockNumber: 7 } as unknown as Log;
}
const pad = (address: string) => ethers.zeroPadValue(address, 32);
const TX = "0x" + "ab".repeat(32);

test("deposits are read from a tx's logs in log order, with the relayer's deposit ids", () => {
  const amount = (n: bigint) => ethers.toBeHex(n, 32);
  const xodeLogs = [
    log(USDT, [TRANSFER_TOPIC, pad(BUYER), pad(VENDING)], amount(2_000_000n), 5),
    log(USDT, [TRANSFER_TOPIC, pad(BUYER), pad(BENEFICIARY)], amount(9n), 2), // not to the vending contract
    log(USDT, [TRANSFER_TOPIC, pad(BUYER), pad(VENDING)], amount(1_000_000n), 1),
  ];
  const fromXode = depositsInLogs(xode, TX, xodeLogs);
  assert.deepEqual(fromXode.map((d) => [d.usdtAmount, d.depositId]), [[1_000_000n, TX], [2_000_000n, depositIdAt(TX, 1)]]);
  assert.equal(fromXode[0].beneficiary, BUYER);

  const deposited = gateway.interface.encodeEventLog("Deposited", [BUYER, BENEFICIARY, 3_000_000n, 1n]);
  const fromEthereum = depositsInLogs(ethereum, TX, [log(GATEWAY, deposited.topics, deposited.data, 0), log(USDT, [DEPOSITED_TOPIC], "0x", 1)]);
  assert.equal(fromEthereum.length, 1, "Deposited events only count from the gateway");
  assert.equal(fromEthereum[0].beneficiary, BENEFICIARY);
  assert.equal(fromEthereum[0].depositId, externalDepositId("ethereum", TX));
});

async function serve(routes: Parameters<typeof makeHandler>[0], cors: string[] = []) {
  const server = await listen(makeHandler(routes, cors), "127.0.0.1", 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

test("the router matches params, returns JSON with bigints as strings, and maps errors", async (t) => {
  const { base, close } = await serve([
    { method: "GET", path: "/api/thing/:id", handler: async ({ params, query }) => ({ id: params.id, big: 2n ** 70n, q: query.get("q") }) },
    { method: "POST", path: "/api/echo", handler: async ({ body }) => body },
    { method: "GET", path: "/api/fail", handler: async () => { throw new ApiError(422, "Nope", "no"); } },
    { method: "GET", path: "/api/crash", handler: async () => { throw new Error("rpc secret detail"); } },
  ]);
  t.after(close);
  t.mock.method(console, "error", () => {});

  assert.deepEqual(await (await fetch(`${base}/api/thing/0xAb?q=1`)).json(), { id: "0xAb", big: (2n ** 70n).toString(), q: "1" });
  const echoed = await fetch(`${base}/api/echo`, { method: "POST", body: JSON.stringify({ a: 1 }) });
  assert.deepEqual(await echoed.json(), { a: 1 });

  const fail = await fetch(`${base}/api/fail`);
  assert.equal(fail.status, 422);
  assert.deepEqual(await fail.json(), { error: "Nope", message: "no" });
  const crash = await fetch(`${base}/api/crash`);
  assert.equal(crash.status, 502);
  assert.doesNotMatch(await crash.text(), /secret/, "internal errors aren't leaked to the client");

  assert.equal((await fetch(`${base}/api/missing`)).status, 404);
  assert.equal((await fetch(`${base}/api/echo`)).status, 405);
  assert.equal((await fetch(`${base}/api/echo`, { method: "POST", body: "{not json" })).status, 400);
  assert.equal((await fetch(`${base}/api/echo`, { method: "POST", body: "x".repeat(70_000) })).status, 413);
});

test("CORS headers go only to allowed origins, and preflights are answered", async (t) => {
  const { base, close } = await serve([{ method: "GET", path: "/api/x", handler: async () => ({}) }], ["https://app.example"]);
  t.after(close);
  const allowed = await fetch(`${base}/api/x`, { headers: { Origin: "https://app.example" } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.example");
  const other = await fetch(`${base}/api/x`, { headers: { Origin: "https://evil.example" } });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
  const preflight = await fetch(`${base}/api/x`, { method: "OPTIONS", headers: { Origin: "https://app.example" } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /POST/);
});

test("event streams send SSE events and are capped", async (t) => {
  const registry = new StreamRegistry(1);
  const { base, close } = await serve([{
    method: "GET", path: "/api/stream", handler: async ({ res }) => {
      const stream = registry.start(res);
      stream.send("hello", { n: 1n });
      return undefined;
    },
  }]);
  t.after(close);

  const first = await fetch(`${base}/api/stream`);
  assert.equal(first.headers.get("content-type"), "text/event-stream");
  const reader = first.body!.getReader();
  let text = "";
  while (!text.includes("event: hello")) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /event: hello\ndata: \{"n":"1"\}\n\n/);

  assert.equal((await fetch(`${base}/api/stream`)).status, 503, "over the cap");
  assert.equal(registry.size, 1);
  await reader.cancel();
  for (let i = 0; i < 50 && registry.size > 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(registry.size, 0, "a client disconnecting frees its slot");
});
