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
  ledger, chunked log scanning, health/metrics and shutdown.
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
| `XODE_CONFIRMATIONS` (or legacy `CONFIRMATIONS`) | `1` | Backed by the contract's own balance check. |
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

## Transaction ledger

Every settle attempt is appended to `.checkpoints/ledger.jsonl` (override with `LEDGER_FILE`), one
JSON object per line:

```json
{"time":"2026-10-14T09:12:03.120Z","adapter":"ethereum","buyer":"0x…","usdtAmount":"20000000","sourceChain":"ethereum","sourceTxHash":"0x…","depositId":"0x…","sourceBlock":1234,"status":"settled","settleTxHash":"0x…","settleBlock":5678}
```

`status` is one of:

- `settled` - XON paid out; `settleTxHash` / `settleBlock` point at the settle tx on Xode.
- `already-settled` - another attempt had already settled this deposit.
- `skipped` - reverted with a permanent error (`error`, e.g. `ZeroAmount`) and will never be retried.
- `held` - over a payout cap, the relayer's or the contract's (`error` says which); waits for
  `npm run settle-held` (see Payout caps).
- `refunded` - a `skipped` deposit's USDT was returned to the payer (`refundTxHash` / `refundTo`).
- `failed` - transient failure (`error` / `message`); retried next tick, so a stuck deposit logs
  one `failed` line per poll until it settles or is fixed.

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

A `skipped` deposit (e.g. `ZeroAddress`, `XonTransferFailed`, or a dust amount that rounds to 0
XON) can never be paid out, so its USDT is stuck: in the vending contract for a Xode deposit, in
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
0 6 * * * /opt/xon-relayer/systemd/xon-relayer-cmd reconcile > /var/log/xon-reconcile.log 2>&1 || <your alert command>
```

The operator commands (`settle-held`, `refunds`, `reconcile`) read the same configuration as the
relayer. On a server, run them through `systemd/xon-relayer-cmd` (see Running on a server), which
gives them the service's settings, state directory and key credential. Locally, they read `.env`.
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

## Shutdown

On `SIGTERM` (e.g. `systemctl stop`) or `SIGINT`, the relayer stops picking up new deposits, lets
any settle already in flight finish, saves each adapter's checkpoint and exits. If that takes
longer than `SHUTDOWN_TIMEOUT_MS` (default 120s), or a second signal arrives, it exits immediately.
That's still safe: settling is idempotent, so an interrupted deposit is just retried on the next
start. The systemd unit's `TimeoutStopSec=150` leaves room for the default timeout.

## Running on a server

`systemd/xon-relayer.service` is the production unit: a dedicated no-login user, a hardened
sandbox (read-only filesystem apart from its state directory, no privilege escalation, restricted
syscalls), state in `/var/lib/xon-relayer`, and the key from an encrypted systemd credential.

### First deploy

```bash
# 1. Service user and code (Node 20.10+; Node 22 recommended)
sudo useradd --system --no-create-home --shell /usr/sbin/nologin xonrelayer
sudo git clone <this repo> /opt/xon-relayer && cd /opt/xon-relayer
sudo npm ci && sudo npm run build

# 2. Settings: copy .env.example, fill it in, and DELETE the RELAYER_PRIVATE_KEY line.
#    Set XODE_CHAIN_ID / ASSETHUB_CHAIN_ID / ETHEREUM_CHAIN_ID, the payout caps, the MIN_*_XON
#    thresholds and ALERT_WEBHOOK_URL. Don't set CHECKPOINT_DIR (the unit sets it).
sudo install -m 600 -o root -g root .env.example /etc/xon-relayer.env && sudoedit /etc/xon-relayer.env

# 3. The relayer key, encrypted at rest (paste the 0x... key, then Ctrl-D). It never touches disk
#    in plain text, and isn't visible in the environment or process list.
sudo mkdir -p /etc/xon-relayer
sudo systemd-creds encrypt --name=relayer-key - /etc/xon-relayer/relayer-key.cred

# 4. Install and start
sudo cp systemd/xon-relayer.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now xon-relayer
journalctl -u xon-relayer -f
```

`LoadCredentialEncrypted` needs systemd 250+ (Ubuntu 24.04, Debian 12; check with
`systemctl --version`). On older systemd, such as Ubuntu 22.04's 249, keep the key in a root-only
file and point the service at it with a drop-in, instead of step 3:

```bash
sudo mkdir -p /etc/xon-relayer
sudo install -m 600 -o root -g root /dev/stdin /etc/xon-relayer/relayer-key   # paste the key, Ctrl-D
sudo systemctl edit xon-relayer   # add the two lines below, save
#   [Service]
#   LoadCredential=relayer-key:/etc/xon-relayer/relayer-key
```

`systemd/xon-relayer-cmd` picks up whichever key file exists. The key is then plaintext at rest,
but still only readable by root and the service.

At startup the relayer refuses to run if:
- another relayer is already running against the same state directory;
- an RPC reports a different chain ID than configured, or a configured contract has no code;
- a chain's RPC can't serve its confirmation setting (e.g. no `finalized` tag);
- the key doesn't match the vending contract's `relayer`.

### Deploying an update

```bash
cd /opt/xon-relayer && sudo git pull && sudo npm ci && sudo npm test && sudo npm run build
sudo systemctl restart xon-relayer   # graceful: finishes in-flight settles first
```

### Operator commands

```bash
sudo /opt/xon-relayer/systemd/xon-relayer-cmd reconcile
sudo /opt/xon-relayer/systemd/xon-relayer-cmd refunds -- --all
sudo /opt/xon-relayer/systemd/xon-relayer-cmd settle-held 0x<source tx hash> [--index <n>]
```

These run as the service user with the service's settings and key, via `systemd-run`.

### Checklist

- Back up `/var/lib/xon-relayer` (the ledger is the audit trail; checkpoints let it resume).
- Point external monitoring at `/health` - it also catches the process being down entirely, which
  the relayer's own alerts can't.
- Run exactly one relayer per relayer key. The lock file stops a second one on the same machine,
  but not on another machine.
- Schedule `reconcile` daily (see Reconciliation).

## Runbook

**Unrecorded payout (reconcile) - treat as a key compromise until proven otherwise.**
1. Pause `XonVendingMachine` with the owner key so nothing more can be paid out.
2. Stop the relayer: `systemctl stop xon-relayer`.
3. Rotate the key. Generate a new one, run `setRelayer(newAddress)` with the owner key, and
   re-encrypt the credential (step 3 of First deploy).
4. Investigate the payout in the ledger and on-chain, then unpause and restart.

**Adapter stalled (alert, or `/health` returns 503).** Check `journalctl -u xon-relayer`.
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
(`systemctl status xon-relayer`, `ps`). Only delete `/var/lib/xon-relayer/relayer.lock` once you're
sure nothing else is running.
