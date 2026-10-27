// OpenAPI 3 description of the front-end API, served at /api/openapi.json, with a Swagger UI page
// at /api/docs. Keep it in step with the routes in index.ts and the response shapes in service.ts.

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (name: string) => ({ type: "object", allOf: [ref(name)], nullable: true });
const json = (schema: object, description = "OK") => ({ description, content: { "application/json": { schema } } });
const errors = (...statuses: number[]) => Object.fromEntries(statuses.map((s) => [s, { $ref: `#/components/responses/E${s}` }]));
const address = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", example: "0xD6a09242a9e6F1Fa5A4E7136dE5E4c578DCc3d8c" };
const hash = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$", example: "0x9c0770a98f5442a21c0447e8205b0830358968dc75c00295598a391ba9be9fda" };
const bigint = (example: string, description?: string) => ({ type: "string", pattern: "^[0-9]+$", example, ...(description ? { description } : {}) });
const networkName = { type: "string", enum: ["xode", "assethub", "ethereum"], description: "Only networks configured on this server are accepted - see GET /api/config." };
const usdtInput = { type: "string", example: "25", description: "USDT amount, up to 6 decimals, e.g. \"10\" or \"12.5\"." };
const sse = (description: string) => ({ description, content: { "text/event-stream": { schema: { type: "string" } } } });

const pathParam = (name: string, schema: object, description?: string) => ({ name, in: "path", required: true, schema, ...(description ? { description } : {}) });
const networkParam = pathParam("network", networkName);
const addressParam = pathParam("address", address);
const prepareBody = (required: string[], extra: Record<string, object> = {}) => ({
  required: true,
  content: {
    "application/json": {
      schema: {
        type: "object",
        required,
        properties: {
          network: networkName,
          from: { ...address, description: "The buyer's wallet address - the account that will sign." },
          amount: usdtInput,
          ...extra,
        },
      },
    },
  },
});
const beneficiary = { ...address, description: "Who receives the XON on Xode. Defaults to `from`. On Xode it must equal `from`." };

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "XON Relayer front-end API",
    version: "1.0.0",
    description: [
      "Buy XON on Xode with USDT paid on Xode, AssetHub or Ethereum.",
      "",
      "The API is **keyless**: it never signs. The `tx/*` endpoints return unsigned transactions; pass each step's `tx` to the wallet",
      "(`eth_sendTransaction`) in order, after switching it to `chainId` (`wallet_switchEthereumChain`), waiting for each to be mined.",
      "",
      "Amounts in responses are `{ raw, formatted }`: `raw` in the token's smallest unit as a decimal string (USDT has 6 decimals,",
      "XON and native tokens 18), `formatted` human-readable. All big numbers are decimal strings.",
      "",
      "The two `events` / `watch` endpoints are Server-Sent Events streams - read them with a browser `EventSource`;",
      "Swagger's \"Try it out\" can't display them.",
    ].join("\n"),
  },
  servers: [{ url: "/", description: "This server" }],
  // No authentication: everything is public chain data or unsigned transactions.
  security: [],
  tags: [
    { name: "Info", description: "Configuration, limits and health" },
    { name: "Account", description: "Balances, allowances and purchase history" },
    { name: "Transactions", description: "Unsigned transactions for the wallet to sign, and broadcasting" },
    { name: "Status", description: "Transaction and deposit progress, including live streams" },
  ],
  paths: {
    "/api/health": {
      get: { operationId: "getHealth", tags: ["Info"], summary: "Chain heads, open streams and the relayer's health", responses: { 200: json(ref("Health")) } },
    },
    "/api/config": {
      get: { operationId: "getConfig", tags: ["Info"], summary: "Networks, contract addresses and the XON rate", description: "Call once at startup.", responses: { 200: json(ref("Config")), ...errors(502) } },
    },
    "/api/limits": {
      get: { operationId: "getLimits", tags: ["Info"], summary: "XON reserve and payout limits", responses: { 200: json(ref("Limits")), ...errors(502) } },
    },
    "/api/quote": {
      get: {
        operationId: "getQuote",
        tags: ["Info"],
        summary: "XON for a USDT amount",
        description: "`warnings` say if the payout would be delayed or held for review. Refuses (422) amounts that round to 0 XON.",
        parameters: [
          { name: "amount", in: "query", required: true, schema: usdtInput },
          { name: "network", in: "query", required: false, schema: { ...networkName, default: "xode" } },
        ],
        responses: { 200: json(ref("Quote")), ...errors(400, 404, 422, 502) },
      },
    },
    "/api/balances/{address}": {
      get: {
        operationId: "getBalances",
        tags: ["Account"],
        summary: "Native, USDT and allowance on each network",
        description: "A network that can't be read right now comes back as `{ error, message }` instead of failing the whole request.",
        parameters: [addressParam, { name: "networks", in: "query", required: false, schema: { type: "string", example: "xode,ethereum" }, description: "Comma-separated. Default: all." }],
        responses: { 200: json(ref("Balances")), ...errors(400, 404) },
      },
    },
    "/api/allowance/{network}/{address}": {
      get: {
        operationId: "getAllowance",
        tags: ["Account"],
        summary: "How much USDT the gateway may take from an address",
        description: "Not available on Xode, which needs no approval.",
        parameters: [networkParam, addressParam],
        responses: { 200: json(ref("Allowance")), ...errors(400, 404, 502) },
      },
    },
    "/api/deposits/{address}": {
      get: {
        operationId: "getDeposits",
        tags: ["Account"],
        summary: "Purchase history for an XON recipient",
        description: "From the relayer's ledger, newest first. Empty if this server can't see the ledger.",
        parameters: [addressParam],
        responses: { 200: json(ref("Deposits")), ...errors(400) },
      },
    },
    "/api/tx/buy": {
      post: {
        operationId: "prepareBuy",
        tags: ["Transactions"],
        summary: "Every transaction a purchase needs, in order",
        description: "Xode: one USDT `transfer` into the vending contract. AssetHub/Ethereum: `approve` (only if the allowance is too low; on Ethereum a non-zero allowance is reset to 0 first) then `deposit`.",
        requestBody: prepareBody(["network", "from", "amount"], { beneficiary }),
        responses: { 200: json(ref("PreparedPurchase")), ...errors(400, 404, 422, 502) },
      },
    },
    "/api/tx/approve": {
      post: {
        operationId: "prepareApprove",
        tags: ["Transactions"],
        summary: "Only the approval(s)",
        description: "`amount` may be `\"max\"` for unlimited. Empty `steps` means the allowance already covers it. Not available on Xode.",
        requestBody: prepareBody(["network", "from", "amount"], { amount: { type: "string", example: "25", description: "USDT amount, or \"max\"." } }),
        responses: { 200: json(ref("PreparedApprove")), ...errors(400, 404, 502) },
      },
    },
    "/api/tx/deposit": {
      post: {
        operationId: "prepareDeposit",
        tags: ["Transactions"],
        summary: "Only the gateway deposit",
        description: "Refuses (422) if the balance or allowance is too low. Not available on Xode - use buy.",
        requestBody: prepareBody(["network", "from", "amount"], { beneficiary }),
        responses: { 200: json(ref("PreparedPurchase")), ...errors(400, 404, 422, 502) },
      },
    },
    "/api/tx/broadcast": {
      post: {
        operationId: "broadcastTx",
        tags: ["Transactions"],
        summary: "Send a transaction the wallet signed",
        description: "Only transactions to that network's USDT or gateway/vending contract are accepted.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["network", "signedTx"], properties: { network: networkName, signedTx: { type: "string", example: "0x02f8...", description: "Signed, serialized transaction." } } } } },
        },
        responses: { 200: json({ type: "object", properties: { network: networkName, txHash: hash } }), ...errors(400, 404, 422) },
      },
    },
    "/api/tx/{network}/{hash}": {
      get: {
        operationId: "getTxStatus",
        tags: ["Status"],
        summary: "Receipt, confirmations and each deposit's state",
        parameters: [networkParam, pathParam("hash", hash)],
        responses: { 200: json(ref("TxStatus")), ...errors(400, 404, 502) },
      },
    },
    "/api/tx/{network}/{hash}/events": {
      get: {
        operationId: "streamTxEvents",
        tags: ["Status"],
        summary: "Stream: follow a transaction until it's done (SSE)",
        description: [
          "Events:",
          "- `status` - the full TxStatus body, whenever something changes",
          "- `payout` - a DepositInfo with `settleTxHash` and `xonAmount`, as each deposit is paid",
          "- `done` - `{ network, txHash, state, deposits }`, then the stream closes (also when a deposit is held for review)",
          "- `timeout` - after an hour without finishing",
        ].join("\n"),
        parameters: [networkParam, pathParam("hash", hash)],
        responses: { 200: sse("Server-Sent Events stream"), ...errors(400, 404, 503) },
      },
    },
    "/api/watch/{addresses}": {
      get: {
        operationId: "watchAddresses",
        tags: ["Status"],
        summary: "Stream: block scanner for one or more addresses (SSE)",
        description: [
          "Scans each new block from now on. Events:",
          "- `subscribed` - `{ addresses, networks }`",
          "- `transaction` - a Receipt plus `network` and `timestamp`, for every tx from or to a watched address",
          "- `usdt-received` - `{ network, txHash, blockNumber, from, to, amount }`",
          "- `xon-payout` - `{ network, settleTxHash, blockNumber, beneficiary, sourceChain, depositId, usdtAmount, xonAmount }`",
          "- `block` - `{ network, blockNumber }` as each block is scanned",
          "",
          "Events are sent before confirmation; after a reorg a tx can come again - dedupe by hash.",
        ].join("\n"),
        parameters: [
          pathParam("addresses", { type: "string", example: "0xD6a09242a9e6F1Fa5A4E7136dE5E4c578DCc3d8c" }, "One address, or up to 20 comma-separated."),
          { name: "networks", in: "query", required: false, schema: { type: "string", example: "xode,ethereum" }, description: "Comma-separated. Default: all." },
        ],
        responses: { 200: sse("Server-Sent Events stream"), ...errors(400, 404, 503) },
      },
    },
  },
  components: {
    responses: {
      E400: json(ref("Error"), "Invalid input"),
      E404: json(ref("Error"), "Unknown network or endpoint"),
      E422: json(ref("Error"), "Valid input, but it can't go ahead (e.g. InsufficientUsdt, InsufficientAllowance, AmountTooSmall, BroadcastRejected)"),
      E502: json(ref("Error"), "A chain RPC call failed - try again shortly"),
      E503: json(ref("Error"), "Too many open event streams"),
    },
    schemas: {
      Error: { type: "object", properties: { error: { type: "string", example: "InsufficientUsdt" }, message: { type: "string" } } },
      Amount: { type: "object", properties: { raw: bigint("25000000"), formatted: { type: "string", example: "25.0" } } },
      NetworkInfo: {
        type: "object",
        properties: {
          name: networkName,
          chainId: bigint("1"),
          chainIdHex: { type: "string", example: "0x1" },
          nativeSymbol: { type: "string", example: "ETH" },
          nativeDecimals: { type: "integer", example: 18 },
          usdtAddress: address,
          payTo: { ...address, description: "The contract USDT is paid into: the vending contract on Xode, the gateway elsewhere." },
          flow: { type: "string", enum: ["transfer", "approve-deposit"] },
          confirmations: { oneOf: [{ type: "integer" }, { type: "string", enum: ["safe", "finalized"] }], description: "How settled a deposit's block must be before it's paid." },
        },
      },
      Config: {
        type: "object",
        properties: {
          vendingAddress: address,
          xon: { type: "object", properties: { symbol: { type: "string", example: "XON" }, decimals: { type: "integer", example: 18 }, perUsdt: ref("Amount") } },
          usdtDecimals: { type: "integer", example: 6 },
          networks: { type: "array", items: ref("NetworkInfo") },
          externalLimits: { type: "object", nullable: true, properties: { maxPerDeposit: ref("Amount"), maxPerDay: ref("Amount") } },
        },
      },
      Limits: {
        type: "object",
        properties: {
          vendingReserveXon: ref("Amount"),
          external: {
            type: "object",
            description: "AssetHub/Ethereum deposits above the lower per-deposit limit are held for manual review.",
            properties: {
              onChain: { type: "object", nullable: true, properties: { maxPerDeposit: ref("Amount"), maxPerDay: ref("Amount"), availableNow: ref("Amount") } },
              relayer: { type: "object", properties: { maxPerDeposit: nullable("Amount"), maxPer24h: nullable("Amount") } },
            },
          },
        },
      },
      Quote: {
        type: "object",
        properties: { network: networkName, usdtAmount: ref("Amount"), xonAmount: ref("Amount"), warnings: { type: "array", items: { type: "string" } } },
      },
      NetworkBalance: {
        type: "object",
        properties: {
          chainId: bigint("1"),
          native: { type: "object", properties: { symbol: { type: "string", example: "ETH" }, raw: bigint("1000000000000000000"), formatted: { type: "string", example: "1.0" } } },
          usdt: { type: "object", properties: { address, raw: bigint("25000000"), formatted: { type: "string", example: "25.0" } } },
          allowance: { ...nullable("Amount"), description: "null on Xode, which needs no approval." },
          error: { type: "string", description: "Only present if this network couldn't be read." },
          message: { type: "string" },
        },
      },
      Balances: {
        type: "object",
        properties: { address, networks: { type: "object", additionalProperties: ref("NetworkBalance"), description: "Keyed by network name." } },
      },
      Allowance: { type: "object", properties: { network: networkName, owner: address, spender: address, allowance: ref("Amount") } },
      UnsignedTx: {
        type: "object",
        description: "Pass as-is to eth_sendTransaction.",
        properties: { from: address, to: address, data: { type: "string", example: "0x095ea7b3..." }, value: { type: "string", example: "0x0" }, chainId: { type: "string", example: "0x1" } },
      },
      TxStep: {
        type: "object",
        properties: { kind: { type: "string", enum: ["approve", "deposit", "transfer"] }, description: { type: "string" }, tx: ref("UnsignedTx") },
      },
      PreparedPurchase: {
        type: "object",
        properties: {
          network: networkName,
          chainId: bigint("1"),
          from: address,
          usdtAmount: ref("Amount"),
          beneficiary: address,
          xonAmount: ref("Amount"),
          warnings: { type: "array", items: { type: "string" } },
          steps: { type: "array", items: ref("TxStep") },
        },
      },
      PreparedApprove: {
        type: "object",
        properties: {
          network: networkName,
          chainId: bigint("1"),
          from: address,
          usdtAmount: ref("Amount"),
          currentAllowance: ref("Amount"),
          steps: { type: "array", items: ref("TxStep") },
        },
      },
      Receipt: {
        type: "object",
        properties: {
          transactionHash: hash,
          blockNumber: { type: "integer" },
          blockHash: hash,
          from: address,
          to: { ...address, nullable: true },
          contractAddress: { ...address, nullable: true },
          status: { type: "integer", nullable: true, description: "1 success, 0 reverted." },
          gasUsed: bigint("46000"),
          gasPrice: bigint("1000000000"),
          logs: { type: "array", items: { type: "object", properties: { address, topics: { type: "array", items: hash }, data: { type: "string" }, index: { type: "integer" } } } },
        },
      },
      DepositInfo: {
        type: "object",
        properties: {
          index: { type: "integer", description: "Position among this tx's deposits, 0-based." },
          depositId: hash,
          beneficiary: address,
          usdtAmount: ref("Amount"),
          state: ref("DepositState"),
          settleTxHash: { ...hash, nullable: true, description: "The Xode tx that paid the XON." },
          xonAmount: { ...nullable("Amount"), description: "Filled in by the events stream once paid." },
          error: { type: "string", nullable: true, description: "Why it was held or skipped." },
        },
      },
      DepositState: {
        type: "string",
        enum: ["awaiting-confirmations", "settling", "settled", "held", "skipped", "refunded"],
        description: "awaiting-confirmations: mined, not yet past the chain's confirmation setting. settling: waiting for the relayer. held: over a payout limit, waiting for an operator. skipped: can never be paid, the USDT is owed back. refunded: it was returned.",
      },
      TxStatus: {
        type: "object",
        properties: {
          network: networkName,
          txHash: hash,
          state: { type: "string", enum: ["pending", "not-found", "failed", "mined"] },
          blockNumber: { type: "integer", nullable: true },
          confirmed: { type: "boolean", description: "Past the chain's confirmation setting." },
          confirmations: { type: "integer" },
          receipt: nullable("Receipt"),
          deposits: { type: "array", items: ref("DepositInfo"), description: "Empty unless the tx is a purchase." },
        },
      },
      Deposits: {
        type: "object",
        properties: {
          address,
          deposits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sourceChain: networkName,
                sourceTxHash: hash,
                index: { type: "integer" },
                depositId: hash,
                usdtAmount: ref("Amount"),
                state: ref("DepositState"),
                settleTxHash: { ...hash, nullable: true },
                updatedAt: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
      Health: {
        type: "object",
        properties: {
          status: { type: "string", example: "ok" },
          networks: {
            type: "object",
            additionalProperties: { type: "object", properties: { chainId: bigint("1"), head: { type: "integer", nullable: true }, error: { type: "string" } } },
          },
          openStreams: { type: "integer" },
          relayer: { type: "object", nullable: true, description: "The relayer's own /health body, `{ status: \"unreachable\" }`, or null if its HTTP server is off." },
        },
      },
    },
  },
};

const SWAGGER_UI = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14";

/// Swagger UI, loaded from a CDN (so the browser viewing it needs internet access).
export const swaggerHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>XON Relayer API</title>
  <link rel="stylesheet" href="${SWAGGER_UI}/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${SWAGGER_UI}/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({ url: "/api/openapi.json", dom_id: "#swagger-ui", deepLinking: true });
  </script>
</body>
</html>
`;
