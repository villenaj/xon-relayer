// Front-end API: a separate process from the relayer (`npm run api`), and deliberately keyless -
// it never loads the relayer key, so exposing it to browsers puts nothing that can sign at risk.
// It prepares unsigned transactions for the buyer's own wallet, reads balances and deposit
// status, and streams transaction progress. See the README's "Front-end API" section.

import { config, validateConfig } from "../config.js";
import { ApiError, listen, makeHandler, StreamRegistry, type Route } from "./http.js";
import { connectNetworks } from "./networks.js";
import { followTx, makeScanners } from "./scanner.js";
import { makeApiService } from "./service.js";
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

async function main(): Promise<void> {
  validateConfig();
  const networks = await connectNetworks(config);
  for (const net of networks.byName.values()) console.log(`[api] ${net.name}: chain ${net.chainId}, USDT ${net.usdtAddress}, pays into ${net.payTo}`);

  const service = makeApiService(config, networks);
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
    { method: "GET", path: "/api/config", handler: () => service.info() },
    { method: "GET", path: "/api/limits", handler: () => service.limits() },
    { method: "GET", path: "/api/quote", handler: async ({ query }) => service.quote(query.get("amount"), query.get("network")) },
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
