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
`EthUsdtGateway.sol` in the `xode-blockchain` repo.

Both the Ethereum and AssetHub legs are really the same adapter (`src/adapters/evmGatewayAdapter.ts`)
called with different chain config - `ethereumAdapter.ts` and `assetHubAdapter.ts` are thin wrappers
around it.

## Setup

```bash
npm install
cp .env.example .env   # fill in the values for your deployment
npm run build          # compiles src/ to dist/
npm start              # node dist/index.js
```

For development, `npm run dev` runs `src/index.ts` directly via `tsx` (no build step), and
`npm run typecheck` type-checks both `src/` and `test/`. The manual tests run with
`npm run test:e2e`, `npm run test:multi-buyer` and `npm run test:poison-pill`.

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
  it, run `npm run settle-held -- <source tx hash>`; this re-reads the deposit from the source
  chain (it doesn't trust the ledger for the amount or recipient) and settles it, bypassing the caps.
- `MAX_EXTERNAL_DAILY_USDT` - total across both chains in any rolling 24 hours. Once reached, the
  AssetHub/Ethereum adapters pause at the next deposit and resume when older payouts age out. The
  window is rebuilt from the ledger at startup, so restarting doesn't reset it. Releases made with
  `settle-held` count toward it from the next restart.

The relayer logs a warning at startup if both are unset. These caps live in the relayer, so they
guard against relayer bugs and bad deposits, not a stolen `RELAYER_PRIVATE_KEY` - that needs
equivalent caps enforced in `XonVendingMachine` itself.

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
- `held` - over a payout cap; waits for `npm run settle-held` (see Payout caps).
- `failed` - transient failure (`error` / `message`); retried next tick, so a stuck deposit logs
  one `failed` line per poll until it settles or is fixed.

`sourceTxHash` is the original deposit tx on its own chain; for AssetHub/Ethereum, `depositId` is
the namespaced id the contract stores in `externalSettledDeposits`. The file is append-only and
never rotated by the relayer - use `logrotate` (with `copytruncate`) if it grows large. Quick
queries with `jq`:

```bash
jq -c 'select(.status == "settled")' .checkpoints/ledger.jsonl
jq -c 'select(.buyer == "0xYourAddress")' .checkpoints/ledger.jsonl
```

## Running on a server

See `systemd/xon-relayer.service` for an example unit file. Key points:

- Put secrets (`RELAYER_PRIVATE_KEY` etc.) in an `EnvironmentFile` readable only by the service
  account (`chmod 600`, owned by that user) - never inline in the unit file or command line.
- Run under a dedicated, no-login service user.
- `CHECKPOINT_DIR` should point somewhere persistent and writable by that user.
- The unit runs the compiled `dist/index.js`, so run `npm run build` as part of each deploy.
