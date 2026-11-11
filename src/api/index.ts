// Front-end API: a separate process from the relayer (`npm run api`), and deliberately keyless -
// it never loads the relayer key, so exposing it to browsers puts nothing that can sign at risk.
// It prepares unsigned transactions for the buyer's own wallet, reads balances and deposit
// status, and streams transaction progress. See the README's "Front-end API" section.

import { config, validateConfig } from "../config.js";
import { ApiError, listen, makeHandler, StreamRegistry, type Route } from "./http.js";
import { connectNetworks } from "./networks.js";
import { openApiSpec, swaggerHtml } from "./openapi.js";
import { followTx, makeScanners } from "./scanner.js";
import { makeApiService } from "./service.js";
import { connectXodeDex } from "../xodeDex.js";
import { parseAddress } from "./transactions.js";

/// Most addresses one watch stream may follow.
const MAX_WATCH_ADDRESSES = 20;

function list(value: string | null): string[] | null {
  if (!value) return null;
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

/// The relayer's own /health, if its HTTP server is on - so the UI can tell when payouts are lagging.
async function relayerHealth(): Promise<unknown> {
  if (config.httpPort === 0) return null;
  const host = config.httpHost === "0.0.0.0" || config.httpHost === "::" ? "127.0.0.1" : config.httpHost;
  try {
    const res = await fetch(`http://${host}:${config.httpPort}/health`, { signal: AbortSignal.timeout(2000) });
    return await res.json();
  } catch {
    return { status: "unreachable" };
  }
}

/// The API shares the relayer's settings file, but must never hold a signing key: drop any that
/// ended up in its environment (and say so - they belong in a credential or key file, not there).
function dropSigningKeys(): void {
  for (const name of ["RELAYER_PRIVATE_KEY", "RATE_KEEPER_PRIVATE_KEY"]) {
    if (process.env[name]) {
      console.warn(`[api] ${name} is set in this process's environment - ignoring it. Keys belong in a credential or a *_FILE, not the shared settings file the API also reads.`);
    }
    delete process.env[name];
  }
}

async function main(): Promise<void> {
  dropSigningKeys();
  validateConfig();
  const networks = await connectNetworks(config);
  for (const net of networks.byName.values()) console.log(`[api] ${net.name}: chain ${net.chainId}, USDT ${net.usdtAddress}, pays into ${net.payTo}`);

  // Xode's DEX over Substrate RPC, for market-price quotes - optional (see XODE_SUBSTRATE_RPC).
  const dex = config.xodeSubstrateRpc ? await connectXodeDex(config.xodeSubstrateRpc) : null;
  if (!dex) console.warn("[api] XODE_SUBSTRATE_RPC not set - no market-price quotes; market-price purchases need an explicit minXonOut.");
  const service = makeApiService(config, networks, dex);
  // The XCM route needs Xode's runtime to swap on arrival. Until it does, market price from
  // AssetHub isn't offered at all - there's no silent fallback to the gateway - so say so loudly.
  if ((await service.xcmRouteReady()) === false) {
    console.warn("[api] ASSETHUB_MARKET_ROUTE=xcm, but Xode wouldn't swap a purchase arriving over XCM right now (its runtime doesn't have the XCM exchanger yet, swaps are paused, the pool is pending, or XODE_SUBSTRATE_RPC is missing). Market-price purchases from AssetHub stay hidden until it would. To keep offering them through the gateway meanwhile, set ASSETHUB_MARKET_ROUTE=gateway.");
  }
  const streams = new StreamRegistry(config.apiMaxStreams);
  const scanners = makeScanners(networks, config.apiPollIntervalMs);

  const routes: Route[] = [
    {
      method: "GET", path: "/api/health", handler: async () => {
        const heads = await Promise.all([...networks.byName.values()].map(async (net) => {
          try {
            return [net.name, { chainId: net.chainId, head: await net.provider.getBlockNumber() }];
          } catch {
            return [net.name, { chainId: net.chainId, head: null, error: "unreachable" }];
          }
        }));
        return { status: "ok", networks: Object.fromEntries(heads), openStreams: streams.size, relayer: await relayerHealth() };
      },
    },
    { method: "GET", path: "/api/openapi.json", handler: async () => openApiSpec },
    {
      method: "GET", path: "/api/docs", handler: async ({ res }) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(swaggerHtml);
        return undefined;
      },
    },
    { method: "GET", path: "/api/config", handler: () => service.info() },
    { method: "GET", path: "/api/limits", handler: () => service.limits() },
    { method: "GET", path: "/api/quote", handler: async ({ query }) => service.quote(query.get("amount"), query.get("network"), query.get("slippageBps")) },
    { method: "GET", path: "/api/balances/:address", handler: ({ params, query }) => service.balances(params.address, list(query.get("networks"))) },
    { method: "GET", path: "/api/allowance/:network/:address", handler: ({ params }) => service.allowance(params.network, params.address) },
    { method: "GET", path: "/api/deposits/:address", handler: async ({ params }) => service.deposits(params.address) },

    { method: "POST", path: "/api/tx/approve", handler: ({ body }) => service.prepareApprove(body) },
    { method: "POST", path: "/api/tx/deposit", handler: ({ body }) => service.prepareDeposit(body) },
    { method: "POST", path: "/api/tx/buy", handler: ({ body }) => service.prepareBuy(body) },
    { method: "POST", path: "/api/tx/broadcast", handler: ({ body }) => service.broadcast(body) },
    { method: "GET", path: "/api/tx/:network/:hash", handler: ({ params }) => service.txStatus(params.network, params.hash) },
    {
      method: "GET", path: "/api/tx/:network/:hash/events", handler: async ({ params, res }) => {
        // Fail fast on bad input with a normal JSON error, before switching to a stream.
        service.network(params.network);
        await service.txStatus(params.network, params.hash);
        const stream = streams.start(res);
        void followTx(service, params.network, params.hash, stream, config.apiPollIntervalMs).catch((err: unknown) => {
          console.error(`[api] Tx stream for ${params.hash} failed:`, err);
          stream.close();
        });
        return undefined;
      },
    },
    {
      method: "GET", path: "/api/watch/:address", handler: async ({ params, query, res }) => {
        // One or more addresses: /api/watch/0xA or /api/watch/0xA,0xB
        const addresses = params.address.split(",").map((a, i) => parseAddress(a.trim(), `address #${i + 1}`));
        if (addresses.length > MAX_WATCH_ADDRESSES) throw new ApiError(400, "TooManyAddresses", `Watch at most ${MAX_WATCH_ADDRESSES} addresses per stream.`);
        const selected = (list(query.get("networks")) ?? [...networks.byName.keys()]).map((name) => service.network(name).name);
        const stream = streams.start(res);
        stream.send("subscribed", { addresses, networks: selected });
        for (const name of selected) scanners.get(name)!.subscribe(addresses, stream);
        res.on("close", () => {
          for (const name of selected) scanners.get(name)!.unsubscribe(stream);
        });
        return undefined;
      },
    },
  ];

  const server = await listen(makeHandler(routes, config.apiCorsOrigins), config.apiHost, config.apiPort);
  console.log(`[api] Listening on http://${config.apiHost}:${config.apiPort}` +
    (config.apiCorsOrigins.length ? ` (CORS: ${config.apiCorsOrigins.join(", ")})` : " (no CORS origins allowed - set API_CORS_ORIGINS for browser use)"));

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      console.log(`[api] ${signal} received - closing.`);
      streams.closeAll();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
