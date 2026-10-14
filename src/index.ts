import { ethers } from "ethers";
import { config, USDT_DECIMALS, validateConfig } from "./config.js";
import { createSettlementClient } from "./settlement.js";
import { makeLedger, readLedger } from "./ledger.js";
import { makePayoutLimiter } from "./payoutLimits.js";
import { runXodeAdapter } from "./adapters/xodeAdapter.js";
import { runAssetHubAdapter } from "./adapters/assetHubAdapter.js";
import { runEthereumAdapter } from "./adapters/ethereumAdapter.js";

async function main(): Promise<void> {
  validateConfig();

  const settlement = await createSettlementClient({
    xodeEthRpc: config.xodeEthRpc,
    vendingAddress: config.vendingAddress,
    relayerPrivateKey: config.relayerPrivateKey,
  });
  console.log(`Relayer address: ${settlement.relayerAddress}`);
  console.log(`Vending contract: ${config.vendingAddress}`);

  const ledger = makeLedger(config.ledgerFile);
  console.log(`Recording settle attempts to ${config.ledgerFile}`);

  const limiter = makePayoutLimiter(config.payoutLimits, readLedger(config.ledgerFile));
  const { maxPerDeposit, maxPer24h } = config.payoutLimits;
  const usdt = (v: bigint | null) => (v === null ? "no cap" : `${ethers.formatUnits(v, USDT_DECIMALS)} USDT`);
  console.log(
    `External payout caps: per deposit ${usdt(maxPerDeposit)}, per 24h ${usdt(maxPer24h)} ` +
    `(${usdt(limiter.usedInWindow())} already paid in the last 24h).`,
  );
  if ((config.adapters.assetHub || config.adapters.ethereum) && maxPerDeposit === null && maxPer24h === null) {
    console.warn("No MAX_EXTERNAL_DEPOSIT_USDT / MAX_EXTERNAL_DAILY_USDT set - AssetHub/Ethereum payouts are uncapped.");
  }

  const context = { settlement, config, ledger, limiter };
  const tasks: Promise<never>[] = [];
  if (config.adapters.xode) tasks.push(runXodeAdapter(context));
  if (config.adapters.assetHub) tasks.push(runAssetHubAdapter(context));
  if (config.adapters.ethereum) tasks.push(runEthereumAdapter(context));

  if (tasks.length === 0) {
    throw new Error("No adapters enabled - set ENABLE_XODE_ADAPTER/ENABLE_ASSETHUB_ADAPTER/ENABLE_ETHEREUM_ADAPTER.");
  }

  // Each adapter runs its own infinite polling loop and only rejects on a truly unrecoverable
  // error (everything retryable is already handled inside each adapter's own tick loop) - if any
  // of them does reject, bring the whole process down rather than run in a half-working state.
  await Promise.race(tasks);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
