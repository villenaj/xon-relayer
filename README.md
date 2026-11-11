# xon-relayer

Standalone relayer service that pays out XON on Xode for USDT received on any of three sources:

- **Xode itself** - USDT is a `pallet_assets` `TrustBackedAsset` with an ERC20 precompile, so a
  buyer's plain `usdt.transfer()` into `XonVendingMachine` is directly observable on-chain.
  Fully verified: the contract checks its own real USDT balance before paying out
  (`settlePurchase` in `XonVendingMachine.sol`) - a compromised relayer key can misattribute a
  real deposit, but can never invent one.
- **AssetHub** - AssetHub now runs `pallet-revive` (enacted via governance, ~January 2026), so this
  leg works exactly like the Ethereum one: a `UsdtGateway` contract deployed on AssetHub itself,
  watched over AssetHub's own `pallet-revive-eth-rpc` bridge (a separate `eth-rpc` instance from
  Xode's, pointed at AssetHub's node).
- **Ethereum** - the same contract (`EthUsdtGateway.sol` - the logic is chain-agnostic, it's pure
  USDT escrow, so it's reused unchanged for AssetHub too) pulls USDT via `transferFrom` and records
  the depositor's intended Xode beneficiary address in a `Deposited` event.

The Xode path is fully trustless (backed by an on-chain balance check). **AssetHub and Ethereum are
not** - `settleExternalPurchase` on `XonVendingMachine` pays out purely on the relayer's say-so,
since the USDT there never touches the contract's own balance and can't be independently verified
from Xode. Securing the relayer's private key (and, for the AssetHub/Ethereum legs, the deployed
gateway contract's owner key that can withdraw its custodied USDT) is the actual security boundary
for those two paths - see the contract-level comments in `XonVendingMachine.sol` and
`EthUsdtGateway.sol` in the `contracts` repo.

Both the Ethereum and AssetHub legs are really the same adapter (`src/adapters/evmGatewayAdapter.ts`)
called with different chain config - `ethereumAdapter.ts` and `assetHubAdapter.ts` are thin wrappers
around it. All three adapters run the same deposit loop (`src/adapters/depositScanner.ts`: resume
from checkpoint, scan in chunks, settle in order, record outcomes); each adapter only says how to
read a deposit from its chain's logs and how to settle it.

## Setup

```bash
npm install
cp .env.example .env   # fill in the values for your deployment
npm run build          # compiles src/ to dist/
npm start              # node dist/index.js
```

For development, `npm run dev` runs `src/index.ts` directly via `tsx` (no build step), and
`npm run typecheck` type-checks `src/`, `test/` and `scripts/`.

### Dev/test chain setup

`npm run setup` (`scripts/setup.ts`) prepares a dev or test environment in one go. It creates the
USDT asset on Xode and AssetHub, deploys XonVendingMachine and both gateways, funds every account
and contract, and writes the relayer settings to `setup.out.env`. Two accounts run all of it: one
Substrate **asset owner** used on both Xode and AssetHub, and one EVM **contract owner**. The
relayer uses the contract owner's key unless you set `RELAYER_PRIVATE_KEY`. You can run it again
safely. Settings are in `setup.env.example`.

Using one key for the owner and the relayer is fine on dev and test chains, but not in production.
The relayer key sits on the server, and the owner key can withdraw the whole XON reserve, lift the
payout caps and drain the gateways. With one key, anyone who steals the relayer key gets all of
that, and the payout caps no longer limit the loss.

## Tests

- `npm test` - unit tests (`test/unit/`, Node's built-in test runner, no chain needed; Node 22+).
  They cover the deposit loop (ordering, stalling on transient failures, skipping permanent ones,
  checkpoint resume, payout-cap gating, shutdown), stuck-tx recovery (nonce resets, fee-bumped
  replacements, revert-reason replay), error classification, payout caps, checkpoints, the
  ledger, chunked log scanning, health/metrics, shutdown, and the front-end API (transaction
  building, deposit parsing, routing, CORS, event streams).
- `npm run test:e2e`, `test:multi-buyer`, `test:poison-pill` - manual end-to-end tests against a
  local zombienet / anvil (see each file's header for the setup they need).

CI (`.github/workflows/ci.yml`) runs typecheck, unit tests and build on every push to `main` and
every pull request.

Each of the three adapters can be toggled independently via `ENABLE_XODE_ADAPTER` /
`ENABLE_ASSETHUB_ADAPTER` / `ENABLE_ETHEREUM_ADAPTER` in `.env` - run only what you need.

Progress for each adapter is checkpointed to `.checkpoints/<adapter>.json` after every tick, so a
restart resumes from where it left off instead of silently skipping deposits made during downtime.
A deposit that fails to settle (transient RPC error, relayer temporarily out of gas, etc.) blocks
that adapter's checkpoint from advancing past it, so it's retried rather than abandoned - safe to
retry because both `settlePurchase` and `settleExternalPurchase` are idempotent.

### Confirmations

Each chain has its own setting for how settled a deposit's block must be before it's paid out -
a block count, or `safe` / `finalized`:

| Variable | Default | Why |
| --- | --- | --- |
| `XODE_CONFIRMATIONS` (or legacy `CONFIRMATIONS`) | `finalized` | The payout is backed by the contract's own balance check, but the checkpoint never moves back: a deposit a reorg re-included in an earlier block would be missed. |
| `ASSETHUB_CONFIRMATIONS` | `finalized` | Payout rests on the relayer's word - a reorged-away deposit would be a straight loss. |
| `ETHEREUM_CONFIRMATIONS` | `finalized` | Same; Ethereum finality is ~13 minutes. |

Logs are fetched in chunks of `LOG_CHUNK_SIZE` blocks (default 2000), with the checkpoint saved
after each chunk, so catching up after downtime works with providers that cap `eth_getLogs` ranges.

### Stuck settle transactions

A settle tx not mined within 60s is checked: if it was dropped from the pool, the relayer re-syncs
its nonce and retries next tick; if it's still pending, it's resent at the same nonce with fees
raised 25% (up to 3 times). Any failed send also re-syncs the nonce, so a single failure can't
leave a nonce gap that blocks every later settle.

### Payout caps

Because AssetHub/Ethereum payouts rest on the relayer's word alone, two optional caps (in USDT)
bound how much it will pay out automatically:

- `MAX_EXTERNAL_DEPOSIT_USDT` - a deposit above this (or above the daily cap) is **held**: recorded
  in the ledger with status `held` and not paid. Later deposits carry on. To pay it after checking
  it, run `npm run settle-held -- <source tx hash>` (plus `--index <n>` if the alert gives one); this re-reads the deposit from the source
  chain (it doesn't trust the ledger for the amount or recipient) and settles it, bypassing the caps.
- `MAX_EXTERNAL_DAILY_USDT` - total across both chains in any rolling 24 hours. Once reached, the
  AssetHub/Ethereum adapters pause at the next deposit and resume when older payouts age out. The
  window is rebuilt from the ledger at startup, so restarting doesn't reset it. Releases made with
  `settle-held` count toward it from the next restart.

The relayer logs a warning at startup if both are unset. These caps live in the relayer, so they
guard against relayer bugs and bad deposits, not a stolen relayer key. For that, `XonVendingMachine`
enforces its own limits on-chain (`setExternalLimits`, owner key): a per-deposit maximum and a daily
allowance that refills continuously. Both start at 0, so AssetHub/Ethereum deposits are paid only
once the owner sets them. Keep the relayer's caps at or below the on-chain ones. The relayer logs
the on-chain limits at startup and warns if they're 0, lower than its own caps, or missing (an
older contract). If a deposit goes over the on-chain limits anyway:

- Over the per-deposit limit (`OverExternalDepositLimit`): the deposit is **held**, like one over
  `MAX_EXTERNAL_DEPOSIT_USDT`. Raise the limit, then run `settle-held`.
- Over the daily allowance (`OverExternalDailyLimit`): the adapter retries until the allowance
  refills.

## Market-price payouts

AssetHub and Ethereum buyers can choose between two prices:

- **Fixed rate** - gateway `deposit` -> `settleExternalPurchase`: XON from the vending contract's
  reserve at its owner-set `rate`. Unchanged.
- **Market price** - gateway `depositForSwap(amount, beneficiary, minXonOut)` ->
  `settleExternalSwap`: the vending contract spends the same amount of its own USDT inventory on
  Xode, swaps it for XON through Xode's DEX (the XCM precompile and the runtime's XCM
  `AssetExchanger`, spec 17+), and pays the buyer whatever the swap returned. `minXonOut` is the
  buyer's own minimum, recorded in the deposit event; if the pool can't give that much, the swap
  reverts and nothing is paid.

The relayer settles each deposit by the event it came from (`Deposited` or `SwapDeposited`), so both
work side by side. Market-price payouts are bounded by the same external limits and caps, and need:

- a vending contract with `settleExternalSwap` (it warns at startup if not), and USDT inventory in
  it - the owner adds it with `fundUsdtInventory`. Set `MIN_USDT_INVENTORY` to be alerted before it
  runs out; meanwhile those deposits stall on `InsufficientUsdtInventory` and resume once it's
  topped up. The USDT buyers pay accumulates in the gateways, so move it back periodically.
- `XODE_SUBSTRATE_RPC` (Xode's ws/wss endpoint). When a swap fails, Xode's XCM precompile reverts
  with the same generic message whatever the reason, so the relayer asks the chain:

  | Cause | What the relayer does |
  | --- | --- |
  | Swaps paused by governance (`TxPause`) | Retries until they're unpaused (`SwapsPaused`) |
  | Pool not approved yet (`AssetWaiting` Pending) | Retries (`PoolNotActive`) |
  | Pool now gives less than the buyer's minimum | **Skips** it with `MinimumNotMet` and alerts - it's on the refund list |
  | Anything else | Retries (`SwapFailed`) |

  Without `XODE_SUBSTRATE_RPC` every failed swap is retried, including one the pool can never
  meet, which stalls the adapter behind it.

`settle-held` releases a held market-price deposit as a swap with its original minimum.

## Transaction ledger

Every settle attempt is appended to `.checkpoints/ledger.jsonl` (override with `LEDGER_FILE`), one
JSON object per line:

```json
{"time":"2026-10-14T09:12:03.120Z","adapter":"ethereum","buyer":"0x…","usdtAmount":"20000000","sourceChain":"ethereum","sourceTxHash":"0x…","depositId":"0x…","sourceBlock":1234,"status":"settled","settleTxHash":"0x…","settleBlock":5678}
```

`status` is one of:

- `settled` - XON paid out; `settleTxHash` / `settleBlock` point at the settle tx on Xode.
- `already-settled` - another attempt had already settled this deposit.
- `skipped` - reverted with a permanent error (`error`, e.g. `ZeroAmount`, or `MinimumNotMet` for a
  market-price deposit the pool couldn't pay) and will never be retried.
- `held` - over a payout cap, the relayer's or the contract's (`error` says which), over the
  buyer's per-address daily limit, or during a fixed-rate pause. That covers Xode-native deposits too.
  Waits for `npm run settle-held` (see Payout caps).
- `refunded` - a `skipped` deposit's USDT was returned to the payer (`refundTxHash` / `refundTo`).
- `failed` - transient failure (`error` / `message`); retried next tick. A deposit that keeps failing
  the same way gets a fresh `failed` line at most every 10 minutes (the console logs every attempt,
  and the `xon_relayer_settle_attempts_total` metric counts them all).

`sourceTxHash` is the original deposit tx on its own chain, and `depositIndex` says which of its
deposits this is (0-based) - one tx can carry several, e.g. a batch from a multisig or smart
wallet. `depositId` is the id the contract stores in `settledDeposits` / `externalSettledDeposits`:
the tx hash for Xode, the chain-namespaced `externalDepositId` for AssetHub/Ethereum, with deposits
after the first in a tx hashed together with their index (`depositIdAt` in `settlement.ts`). The
first deposit's id is the same one used before deposits were indexed, so nothing settled earlier
can be paid twice. Entries written before then have no `depositIndex`; read it as 0. The file is append-only and
never rotated by the relayer - use `logrotate` (with `copytruncate`) if it grows large. Quick
queries with `jq`:

```bash
jq -c 'select(.status == "settled")' .checkpoints/ledger.jsonl
jq -c 'select(.buyer == "0xYourAddress")' .checkpoints/ledger.jsonl
```

## Refunds

A `skipped` deposit (e.g. `ZeroAddress`, `XonTransferFailed`, a dust amount that rounds to 0
XON, or a market-price deposit whose minimum the pool couldn't meet) can never be paid out, so its USDT is stuck: in the vending contract for a Xode deposit, in
the gateway for an AssetHub/Ethereum one. Only that contract's **owner** can move it - not the
relayer's key, on purpose - so the relayer doesn't send refunds; it tracks them:

```bash
npm run refunds                     # what's owed: chain, amount, who to refund, which contract holds it
npm run refunds -- --all            # ...plus refunds already made
npm run refunds -- mark <source tx> <refund tx>
```

Refunds go to whoever *paid* - for AssetHub/Ethereum that's the depositor on the source chain,
looked up from the deposit tx, not the Xode beneficiary. `mark` checks the refund tx on-chain
before recording it: it must have succeeded on the deposit's chain and moved at least the
deposited amount of that chain's USDT to the payer. If it was refunded some other way, use
`--force --note "how"`; the note is kept in the ledger.

For an AssetHub/Ethereum deposit there are two steps, in this order, both from the owner Safes:

1. **Cancel it on Xode** (`npm run safe -- propose cancels --chain xode`). The vending contract
   then never pays it out, and the cancel itself fails if it was already paid. This is what stops a
   deposit from being both refunded and paid.
2. **Refund it from its gateway** (`npm run safe -- propose refunds --chain ethereum`). The tool only
   proposes, signs or executes a refund once the chain shows the deposit cancelled on Xode. That
   holds for any proposal, `raw` ones included. A deposit whose own market-price minimum couldn't
   be met is refunded less the gateway's `refundFee`; for any other failure it's refunded in full.
   A depositor can name a different refund address with the gateway's `setRefundAddress`, for
   example if USDT has frozen theirs.

A Xode-native deposit is refunded from the treasury, since the vending contract's USDT can only be
withdrawn there. Again cancel first, then refund:

1. **Cancel it on Xode** (`npm run safe -- propose cancels --chain xode`, which covers Xode-native
   deposits too: `cancelNativeDeposit`). It then can never be paid, and its USDT is counted as
   accounted for. Without the cancel, withdrawing it would leave the contract still treating it
   as an unpaid deposit, payable against USDT that has already left.
2. **Withdraw it to the treasury** (`withdrawUsdt`), and refund the payer from there.

`mark` refuses a refund whose deposit isn't cancelled on Xode yet (unless `--force`). Vending
contracts deployed before `cancelNativeDeposit` can't cancel native deposits, and `npm run refunds`
says so. Redeploy before refunding one.

## Attesters, the change queue and other limits

- **Attesters.** A cross-chain payout needs `attestationThreshold` of the vending contract's
  attesters to vote for that exact deposit. Then any attester can execute it. Run one relayer
  instance per attester key, ideally on different machines with different RPCs. Set
  `ASSETHUB_VERIFY_RPCS` / `ETHEREUM_VERIFY_RPCS` too: then a deposit is paid only once each of those
  RPCs independently shows the same deposit log, in the same block, past the confirmation policy.
  If they disagree, the adapter waits and alerts; if one is down, payouts wait until it's back.
  Attesters that all trust one provider are a single point of failure, however many there are.
  `ENABLE_XODE_ADAPTER=false` on all but the one holding the `relayer` key, which is the only key
  allowed to settle Xode-native deposits. With one vote in, the relayer logs "waiting for other
  attesters" and retries. Market-price swaps execute after a random wait of up to
  `SETTLE_JITTER_MS` (default 15s), so their timing is harder to sandwich.
- **Change queue.** Once a contract is handed over, a change that could pay out more has to be
  queued with its exact calldata and waits 48 hours. That covers raising limits, the rate or the
  refund fee, adding an attester, lowering the threshold, and appointing a relayer or keeper. Use
  `npm run safe -- propose <action> --queue`, then the same command without `--queue` once
  `npm run safe -- status` shows it `READY`. The guardian Safe can stop a queued change with
  `propose cancel-change <id>`. Changes that only make things safer (lowering limits, removing an
  attester, pausing) take effect immediately. Watch `status` for changes you didn't queue.
- **Rate keeper.** With `XODE_SUBSTRATE_RPC` set, the relayer compares the fixed `rate` with the
  DEX price every `RATE_KEEPER_INTERVAL_MS` (default 60s). It alerts past `RATE_ALERT_BPS`, and with
  a keeper key it steps the rate toward the market past `RATE_DEADBAND_BPS`, within the contract's
  own step and interval bounds. It acts on the **median of the last `RATE_KEEPER_SAMPLES`** (default
  5) price readings, each from a different block. A single reading of the pool is something anyone
  with capital can move for a block. Acting on one would let a trader steer the rate (or trigger the
  pause) and then buy against it. With the median, the pool has to be held off-market for more than
  half the window, against arbitrage. Nothing happens until the window is full (about 5 minutes
  after start). The keeper's transactions are bumped or given up on like settles, never waited on
  forever. Load the keeper key like the relayer key: the systemd credential `rate-keeper-key`, or
  `RATE_KEEPER_PRIVATE_KEY_FILE`. Never put it in `/etc/xon-relayer.env`, which the front-end API
  reads too. The relayer warns if it comes from a plain env var.
- **Fixed-rate pause.** Past `RATE_PAUSE_BPS` (default: `RATE_ALERT_BPS`), the rate keeper pauses
  `buy` and the fixed-rate deposit paths, and resumes them once the rate is back within half of
  that. Market-price swaps keep working. Deposits that arrive during the pause are held, on every
  chain including Xode. Once it lifts, pay them with `npm run settle-held`.
- **Per-address limit.** `maxPerAddressPerDay` caps what one buyer or beneficiary can take per day
  across every path, so a single party can't use up the shared allowance. A deposit over it is held.
- **Minimum deposit.** The gateways refuse deposits under `minDeposit`, and the API refuses to
  prepare them.

## Reconciliation

`npm run reconcile` cross-checks the ledger against the chains (read-only) and exits `1` if it
finds a problem, so it can run from cron:

- **Unrecorded payout** - a `Settled`/`ExternalSettled` event on Xode with no ledger record:
  something other than this relayer paid out (another instance, or a leaked key).
- **Ledger-only settlement** - the ledger says paid, but there's no payout event (e.g. a reorg).
- **Mismatch** - the ledger, the payout and the deposit disagree on amount or recipient.
- **Missed deposit** - a deposit behind its adapter's checkpoint that was never paid and isn't
  `skipped`, `held` or `refunded`.

Held deposits and skipped deposits still awaiting a refund are listed as notes, not problems.
Each chain is scanned from its configured start block, or else the earliest block the ledger
mentions for it, up to its adapter's checkpoint. Override with `--xode-from`, `--assethub-from` or
`--ethereum-from <block>`. Example root cron entry, alerting only on failure:

```cron
0 6 * * * /opt/xon-relayer/docker/xon-relayer-cmd reconcile > /var/log/xon-reconcile.log 2>&1 || <your alert command>
```

The operator commands (`settle-held`, `refunds`, `reconcile`) read the same configuration as the
relayer. On a server, run them through `docker/xon-relayer-cmd` (see Running on a server), which
gives them the relayer container's settings, state directory and key. Locally, they read `.env`.
Only `settle-held` signs anything, so only it loads the relayer key.

## Health, metrics and alerts

The relayer serves two endpoints on `http://127.0.0.1:9464` (`HTTP_HOST` / `HTTP_PORT`;
`HTTP_PORT=0` turns them off):

- `GET /health` - `200` when every adapter has caught up to its chain's safe head within
  `STALL_ALERT_AFTER_MS` (default 10 min), `503` otherwise or while shutting down. The JSON body
  has per-adapter detail (last poll, last caught up, blocks behind, consecutive failures) and any
  low-balance warnings. "Caught up" rather than "polled" is what counts, so an adapter stuck
  retrying one deposit shows as unhealthy even though it's still polling.
- `GET /metrics` - Prometheus format: per-adapter last poll / last caught up / blocks behind /
  poll failures, settle attempts by outcome, the relayer's gas balance, the vending contract's XON
  reserve, and USDT paid in the current 24h cap window.

Every `MONITOR_INTERVAL_MS` (default 60s) the relayer checks its own gas balance and the vending
contract's XON reserve against `MIN_RELAYER_BALANCE_XON` / `MIN_VENDING_RESERVE_XON`. Alerts fire
once when something goes wrong and once when it recovers:

- a balance drops below its threshold (and when it's back above it),
- an adapter stalls past `STALL_ALERT_AFTER_MS` (and when it catches up),
- a deposit is held for being over the per-deposit cap,
- the 24h payout cap pauses an adapter.

Alerts are always logged; set `ALERT_WEBHOOK_URL` to also POST them to a chat webhook. The body
carries the message as both `text` (Slack, Mattermost, Google Chat) and `content` (Discord).

## Front-end API

`npm run api` (`npm run dev:api` in development) starts a JSON API for a buyer-facing UI, on
`http://127.0.0.1:8080` (`API_HOST` / `API_PORT`). It's a separate process from the relayer and
never loads the relayer key. It doesn't hold buyers' keys either: it works out which transactions
a purchase needs and returns them unsigned, the buyer's wallet signs and sends them, and the API
then reports their progress. It reads the same configuration as the relayer, and the relayer's
ledger (if it's on the same host) for held, skipped and refunded deposits and for purchase history.

Browsers can only call it from the origins in `API_CORS_ORIGINS` (comma-separated, or `*`). To
expose it, put it behind a TLS reverse proxy that also rate-limits it. Amounts in requests are USDT
strings like `"12.5"`. Amounts in responses are `{ "raw": "12500000", "formatted": "12.5" }`. Errors
are `{ "error": "<Code>", "message": "..." }` with a 4xx status, or 502 when a chain RPC fails.

| Endpoint | What it does |
| --- | --- |
| `GET /api/config` | Networks (chain ID, USDT address, the contract USDT is paid into, `flow`: `transfer` or `approve-deposit`), the XON rate, and the external payout limits. Call it once at startup. |
| `GET /api/limits` | The vending contract's XON reserve, and the on-chain and relayer payout limits, including how much of today's allowance is left. |
| `GET /api/quote?amount=10&network=ethereum[&slippageBps=100]` | XON for that much USDT at the fixed rate, plus `warnings` if the payout would be delayed or held for review. On AssetHub/Ethereum, `swap` adds the market-price quote and the minimum that slippage would set (needs `XODE_SUBSTRATE_RPC`). |
| `GET /api/balances/:address?networks=xode,ethereum` | Native and USDT balance on each network, and the gateway allowance where one is needed. |
| `GET /api/allowance/:network/:address` | How much USDT the gateway may take from the address. |
| `POST /api/tx/buy` | `{ network, from, amount, beneficiary?, minXonOut?, slippageBps? }` returns every transaction the purchase needs, in order: one USDT transfer on Xode, or approve (if needed) then deposit elsewhere. `beneficiary` (default `from`) is who gets the XON. On Xode it's always the sender. With `minXonOut` (an XON amount) or `slippageBps`, the deposit is a `depositForSwap`, paid at market price (`payout: "swap"`). |
| `POST /api/tx/approve` | `{ network, from, amount }` returns only the approval (`amount: "max"` for unlimited). On Ethereum, a non-zero allowance is reset to 0 first, because USDT there requires it. |
| `POST /api/tx/deposit` | `{ network, from, amount, beneficiary?, minXonOut?, slippageBps? }` returns only the gateway deposit (`depositForSwap` with a minimum, as for `buy`). It refuses if the allowance or balance is too low. |
| `POST /api/tx/broadcast` | `{ network, signedTx }` sends a transaction the wallet signed but didn't send. It only accepts transactions to that network's USDT or gateway/vending contract. |
| `GET /api/tx/:network/:hash` | The receipt, confirmation status and, for a purchase, each deposit's state and payout tx. |
| `GET /api/tx/:network/:hash/events` | Event stream following the transaction until it's done (see below). |
| `GET /api/watch/:address[,address2...]?networks=` | Event stream for an address (block scanner, see below). |
| `GET /api/deposits/:address` | Purchase history for an XON recipient, from the ledger. |
| `GET /api/health` | Each chain's head block, the number of open streams, and the relayer's own `/health`. |
| `GET /api/docs` | Swagger UI for all of the above. It loads from a CDN, so the browser needs internet access. The OpenAPI spec itself is at `GET /api/openapi.json`. |

`buy`, `approve` and `deposit` refuse amounts the wallet doesn't have, and amounts that would round
to 0 XON (never payable). Each step's `tx` (`from`, `to`, `data`, `value`, `chainId`) goes straight
to `eth_sendTransaction`. Switch the wallet to `chainId` first (`wallet_switchEthereumChain`), and
send the steps in order, waiting for each to be mined.

A deposit's `state` is one of `awaiting-confirmations` (mined, not yet past the chain's
confirmation setting), `settling` (waiting for the relayer), `settled`, `held` (over a payout limit,
waiting for an operator), `skipped` (can never be paid, so the USDT is owed back) or `refunded`.
Whether a deposit is paid comes from the vending contract itself. The other states come from the
ledger, so without the ledger a held or skipped deposit shows as `settling`.

**Event streams** are [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/EventSource),
so a browser `EventSource` reads them. At most `API_MAX_STREAMS` (default 500) can be open at once:

- `/api/tx/:network/:hash/events` sends `status` (the same body as `GET /api/tx/...`) whenever
  something changes, `payout` (settle tx and XON amount) as each deposit is paid, then `done` and
  closes. It also stops if a deposit is held, or with `timeout` after an hour.
- `/api/watch/:address` scans each new block from now on (up to 20 addresses per stream). It sends
  `transaction` (with the receipt) for every tx from or to the address, `usdt-received` for incoming
  USDT, `xon-payout` when the address is paid XON, and `block` as each block is scanned. Events are
  sent at the chain head, before confirmation. After a reorg the same tx can come again from its new
  block, so dedupe by hash.

```js
const api = "https://api.example.com";
const { steps } = await (await fetch(`${api}/api/tx/buy`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ network: "ethereum", from: account, amount: "25" }),
})).json();
await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: steps[0].tx.chainId }] });
let hash;
for (const { tx } of steps) {
  hash = await ethereum.request({ method: "eth_sendTransaction", params: [tx] });
  await waitForReceipt(hash); // e.g. poll GET /api/tx/ethereum/:hash until state is "mined"
}
const events = new EventSource(`${api}/api/tx/ethereum/${hash}/events`);
events.addEventListener("payout", (e) => console.log("XON paid:", JSON.parse(e.data)));
events.addEventListener("done", () => events.close());
```

## Shutdown

On `SIGTERM` (e.g. `docker compose stop`) or `SIGINT`, the relayer stops picking up new deposits, lets
any settle already in flight finish, saves each adapter's checkpoint and exits. If that takes
longer than `SHUTDOWN_TIMEOUT_MS` (default 120s), or a second signal arrives, it exits immediately.
That's still safe: settling is idempotent, so an interrupted deposit is just retried on the next
start. `stop_grace_period: 150s` in `compose.yaml` leaves room for the default timeout.

## Running on a server

The relayer and the front-end API run as two Docker containers from one image (`Dockerfile`,
`compose.yaml`). Each runs as a fixed non-root uid (10001) with no matching host account, on a
read-only filesystem with all capabilities dropped. They use host networking, so `/health` and the
API stay on `127.0.0.1` and an RPC on the host's localhost is reachable. Host paths:

| Path | Contents | Owner, mode |
|---|---|---|
| `/etc/xon-relayer.env` | settings, no key | root, `0600` |
| `/etc/xon-relayer/relayer-key` | the relayer key, mounted as a Docker secret | `10001`, `0400` |
| `/var/lib/xon-relayer` | checkpoints and ledger (the API mounts it read-only) | `10001`, `0700` |

Run every `docker compose` command from `/opt/xon-relayer`.

### First deploy

```bash
# 1. Docker and the code
curl -fsSL https://get.docker.com | sudo sh
sudo git clone <this repo> /opt/xon-relayer && cd /opt/xon-relayer

# 2. Settings: copy .env.example, fill it in, and DELETE the RELAYER_PRIVATE_KEY line.
#    Set XODE_CHAIN_ID / ASSETHUB_CHAIN_ID / ETHEREUM_CHAIN_ID, the payout caps, the MIN_*_XON
#    thresholds and ALERT_WEBHOOK_URL. CHECKPOINT_DIR is set by compose.yaml.
sudo install -m 600 -o root -g root .env.example /etc/xon-relayer.env && sudoedit /etc/xon-relayer.env

# 3. The relayer key (paste the 0x... key, then Ctrl-D) and the state directory
sudo mkdir -p /etc/xon-relayer /var/lib/xon-relayer
sudo install -m 400 -o 10001 -g 10001 /dev/stdin /etc/xon-relayer/relayer-key
sudo chown 10001:10001 /var/lib/xon-relayer && sudo chmod 700 /var/lib/xon-relayer

# 4. Build (runs the typecheck and unit tests) and start
sudo docker compose up -d --build
sudo docker compose logs -f relayer
```

The key is plaintext at rest, readable only by root and the container. It isn't in the image, the
container's environment or the process list. Compose reads `/etc/xon-relayer.env` itself, so a
`$` in a value must be written `$$`.

At startup the relayer refuses to run if:
- another relayer is already running against the same state directory;
- an RPC reports a different chain ID than configured, or a configured contract has no code;
- a chain's RPC can't serve its confirmation setting (e.g. no `finalized` tag);
- the key doesn't match the vending contract's `relayer`.

### Front-end API

The `api` container starts with the relayer. It uses the same settings file and reads the
relayer's ledger, but never gets the key:

```bash
curl http://127.0.0.1:8080/api/health
```

It listens on localhost only. Reach it through an SSH tunnel, or put a TLS reverse proxy in front
of it (set `API_CORS_ORIGINS` in `/etc/xon-relayer.env` to the UI's origin). To run the relayer
alone, use `sudo docker compose up -d relayer`.

### Moving an existing server from systemd

Build first so the switch-over is short, stop the systemd units (gracefully), hand the state and
key to uid 10001, and start the containers. Masking the units matters: the instance lock can't
see a process in another PID namespace, so a systemd relayer and a container relayer would not
stop each other.

```bash
cd /opt/xon-relayer && sudo git pull && sudo docker compose build

# The key as a file. Ubuntu 22.04 setups already have /etc/xon-relayer/relayer-key. With the
# encrypted credential (systemd 250+), decrypt it once:
sudo systemd-creds decrypt /etc/xon-relayer/relayer-key.cred /etc/xon-relayer/relayer-key
sudo chown 10001:10001 /etc/xon-relayer/relayer-key && sudo chmod 400 /etc/xon-relayer/relayer-key

sudo systemctl disable --now xon-api xon-relayer   # waits for in-flight settles
sudo systemctl mask xon-api xon-relayer
sudo chown -R 10001:10001 /var/lib/xon-relayer

sudo docker compose up -d
sudo docker compose logs -f relayer
```

Then point the reconcile cron entry at `docker/xon-relayer-cmd` (see Reconciliation). To roll
back: `sudo docker compose down`, `sudo chown -R xonrelayer:xonrelayer /var/lib/xon-relayer`,
`sudo systemctl unmask xon-api xon-relayer`, and `sudo systemctl enable --now xon-relayer xon-api`.
The `systemd/` units are kept for that.

### Deploying an update

```bash
cd /opt/xon-relayer && sudo git pull
sudo docker compose up -d --build   # graceful: finishes in-flight settles before replacing
```

### Operator commands

```bash
sudo /opt/xon-relayer/docker/xon-relayer-cmd reconcile
sudo /opt/xon-relayer/docker/xon-relayer-cmd refunds -- --all
sudo /opt/xon-relayer/docker/xon-relayer-cmd settle-held 0x<source tx hash> [--index <n>]
```

Each runs in a one-off container with the relayer's settings, state directory and key.

### Checklist

- Back up `/var/lib/xon-relayer` (the ledger is the audit trail; checkpoints let it resume).
- Point external monitoring at `/health` - it also catches the process being down entirely, which
  the relayer's own alerts can't. `docker ps` shows the same check as the container's health.
- Run exactly one relayer per relayer key. The lock file stops a second one using the same state
  directory, but not one on another machine.
- Schedule `reconcile` daily (see Reconciliation).

## Runbook

**Unrecorded payout (reconcile) - treat as a key compromise until proven otherwise.**
1. Pause `XonVendingMachine` with the owner key so nothing more can be paid out.
2. Stop the relayer: `docker compose stop relayer`.
3. Rotate the key. Generate a new one, run `setRelayer(newAddress)` with the owner key, and
   replace `/etc/xon-relayer/relayer-key` (step 3 of First deploy).
4. Investigate the payout in the ledger and on-chain, then unpause and restart.

**Adapter stalled (alert, or `/health` returns 503).** Check `docker compose logs relayer`.
- Repeated "Failed to settle": the error name says why. `IsPaused` means the contract is paused;
  `InsufficientReserve` means it needs more XON; `NotRelayer` means the key and contract disagree.
- "Poll tick failed": the RPC is down or rate-limited.
- "24h payout cap reached": intended. It resumes by itself, or raise `MAX_EXTERNAL_DAILY_USDT`
  and restart.
- Repeated `OverExternalDailyLimit`: the contract's daily allowance is used up. It refills over
  time; raise it with `setExternalLimits` if the volume is real.

**Low balance (alert).** Top up the relayer address with XON for gas, or fund the vending contract's
reserve. Settles that failed meanwhile are retried automatically.

**Held deposit (alert).** Check the deposit on the source chain, then run
`xon-relayer-cmd settle-held <tx>`, or refund the depositor if it shouldn't be paid. If the tx
carries several deposits, the alert includes `--index <n>` for the one held. If it was held for
`OverExternalDepositLimit`, raise the contract's limit with `setExternalLimits` first.

**Skipped deposit / missed deposit (reconcile).** For skipped deposits, follow
`xon-relayer-cmd refunds`. A missed deposit means a deposit sits behind a checkpoint unpaid, which
shouldn't happen. Check the ledger and logs around its block. To reprocess it, stop the relayer,
set that adapter's checkpoint value (`/var/lib/xon-relayer/<chain>.json`) to the block, and start
again. Already-settled deposits are skipped, so this is safe.

Versions before deposits were indexed paid only the first deposit of a tx carrying several, and
recorded nothing for the rest. After upgrading, `reconcile` reports those as missed deposits
(`<tx> #1`, `#2`, ...); reprocess them the same way.

**Relayer won't start, "Another relayer is already running".** Find the other process
(`docker ps`, `systemctl status xon-relayer`, `ps`). Only delete `/var/lib/xon-relayer/relayer.lock` once you're
sure nothing else is running.
