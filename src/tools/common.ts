// Shared bits for the operator commands in src/tools/.

import { ethers } from "ethers";
import type { Confirmations } from "../chain.js";
import type { Config } from "../config.js";

export const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
export const DEPOSITED_TOPIC = ethers.id("Deposited(address,address,uint256,uint256)");

export type ExternalChainName = "assethub" | "ethereum";

export interface ExternalChain {
  name: ExternalChainName;
  rpcUrl: string;
  gatewayAddress: string;
  confirmations: Confirmations;
  startBlock: number | null;
  checkpointFile: string;
  chainId: bigint | null;
}

/// An external source chain's settings by ledger name ("assethub" / "ethereum"), or null if it
/// isn't a known chain or has no RPC/gateway configured.
export function externalChain(config: Config, name: string): ExternalChain | null {
  const chain = name === "assethub" ? config.assetHub : name === "ethereum" ? config.ethereum : null;
  if (!chain?.rpcUrl || !chain.gatewayAddress) return null;
  return { ...chain, name: name as ExternalChainName, rpcUrl: chain.rpcUrl, gatewayAddress: chain.gatewayAddress };
}

/// Every external chain that has an RPC/gateway configured (whether or not its adapter is enabled).
export function externalChains(config: Config): ExternalChain[] {
  return ["assethub", "ethereum"].map((name) => externalChain(config, name)).filter((c): c is ExternalChain => c !== null);
}

/// The value after `--name` on the command line, if given.
export function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function blockOption(args: string[], name: string): number | null {
  const value = option(args, name);
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a block number (got "${value}").`);
  return n;
}

export function runTool(main: () => Promise<void>): void {
  main().then(
    () => process.exit(process.exitCode ?? 0),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
