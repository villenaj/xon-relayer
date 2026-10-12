import { config, validateConfig } from "./config.js";
import { createSettlementClient } from "./settlement.js";
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

  const tasks: Promise<never>[] = [];
  if (config.adapters.xode) tasks.push(runXodeAdapter({ settlement, config }));
  if (config.adapters.assetHub) tasks.push(runAssetHubAdapter({ settlement, config }));
  if (config.adapters.ethereum) tasks.push(runEthereumAdapter({ settlement, config }));

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
