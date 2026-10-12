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

## Running on a server

See `systemd/xon-relayer.service` for an example unit file. Key points:

- Put secrets (`RELAYER_PRIVATE_KEY` etc.) in an `EnvironmentFile` readable only by the service
  account (`chmod 600`, owned by that user) - never inline in the unit file or command line.
- Run under a dedicated, no-login service user.
- `CHECKPOINT_DIR` should point somewhere persistent and writable by that user.
- The unit runs the compiled `dist/index.js`, so run `npm run build` as part of each deploy.
