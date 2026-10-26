// The chains the front-end API serves, connected and checked once at startup: Xode itself (where
// a purchase is a plain USDT transfer into XonVendingMachine) plus every external chain with an
// RPC and gateway configured (where it's approve + UsdtGateway.deposit).

import { ethers, type JsonRpcProvider } from "ethers";
import { makeProvider, verifyEndpoint, type Confirmations } from "../chain.js";
import type { Config } from "../config.js";
import { externalChains } from "../tools/common.js";
import ERC20_ABI from "../abi/IERC20.json" with { type: "json" };
import GATEWAY_ABI from "../abi/EthUsdtGateway.json" with { type: "json" };
import VENDING_ABI from "../abi/XonVendingMachine.json" with { type: "json" };

export type NetworkName = "xode" | "assethub" | "ethereum";

export interface Network {
  name: NetworkName;
  chainId: bigint;
  provider: JsonRpcProvider;
  nativeSymbol: string;
  confirmations: Confirmations;
  usdt: ethers.Contract;
  usdtAddress: string;
  /// Where the buyer's USDT goes: the vending contract on Xode, the gateway elsewhere.
  payTo: string;
  /// Null on Xode, which takes a plain transfer instead of approve + deposit.
  gateway: ethers.Contract | null;
  /// Real USDT on Ethereum reverts an approve from one non-zero allowance to another, so a
  /// top-up has to go through 0 first.
  approveResetsToZero: boolean;
}

export interface Networks {
  xode: Network;
  vending: ethers.Contract;
  byName: Map<NetworkName, Network>;
}

export async function connectNetworks(config: Config): Promise<Networks> {
  const xodeProvider = makeProvider(config.xodeEthRpc, config.rpcTimeoutMs);
  const xodeChainId = await verifyEndpoint(xodeProvider, { label: "xode", expectedChainId: config.xodeChainId, contracts: { XonVendingMachine: config.vendingAddress } });
  const vending = new ethers.Contract(config.vendingAddress, VENDING_ABI, xodeProvider);
  const xodeUsdtAddress: string = await vending.usdt();
  const xode: Network = {
    name: "xode",
    chainId: xodeChainId,
    provider: xodeProvider,
    nativeSymbol: "XON",
    confirmations: config.xodeConfirmations,
    usdt: new ethers.Contract(xodeUsdtAddress, ERC20_ABI, xodeProvider),
    usdtAddress: xodeUsdtAddress,
    payTo: await vending.getAddress(),
    gateway: null,
    approveResetsToZero: false,
  };

  const byName = new Map<NetworkName, Network>([["xode", xode]]);
  for (const chain of externalChains(config)) {
    const provider = makeProvider(chain.rpcUrl, config.rpcTimeoutMs);
    const chainId = await verifyEndpoint(provider, { label: chain.name, expectedChainId: chain.chainId, contracts: { UsdtGateway: chain.gatewayAddress } });
    const gateway = new ethers.Contract(chain.gatewayAddress, GATEWAY_ABI, provider);
    const usdtAddress: string = await gateway.usdt();
    byName.set(chain.name, {
      name: chain.name,
      chainId,
      provider,
      nativeSymbol: config[chain.name === "assethub" ? "assetHub" : "ethereum"].nativeSymbol,
      confirmations: chain.confirmations,
      usdt: new ethers.Contract(usdtAddress, ERC20_ABI, provider),
      usdtAddress,
      payTo: await gateway.getAddress(),
      gateway,
      approveResetsToZero: chain.name === "ethereum",
    });
  }
  return { xode, vending, byName };
}
