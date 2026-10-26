// Unsigned transactions for the buyer's wallet to sign. The API never holds a buyer's key: it
// works out which calls a purchase needs and encodes them, and the front-end hands each one to
// the wallet (`eth_sendTransaction`) as-is.
//
// A purchase is one transaction on Xode (USDT `transfer` straight into XonVendingMachine - the
// sender gets the XON) and up to three elsewhere: `approve(0)` where USDT insists on it, then
// `approve`, then `UsdtGateway.deposit` naming the Xode beneficiary.

import { ethers } from "ethers";
import { USDT_DECIMALS } from "../config.js";
import { ApiError } from "./http.js";
import type { Network } from "./networks.js";

export interface UnsignedTx {
  from: string;
  to: string;
  data: string;
  value: "0x0";
  /// Hex, as `wallet_switchEthereumChain` and `eth_sendTransaction` take it.
  chainId: string;
}

export interface TxStep {
  kind: "approve" | "deposit" | "transfer";
  description: string;
  tx: UnsignedTx;
}

type StepNetwork = Pick<Network, "name" | "chainId" | "usdt" | "usdtAddress" | "payTo" | "gateway" | "approveResetsToZero">;

/// A USDT amount as given by the front-end ("10", "12.5"), in raw units.
export function parseUsdt(value: unknown, field = "amount"): bigint {
  if (typeof value !== "string" && typeof value !== "number") throw new ApiError(400, "InvalidAmount", `${field} must be a USDT amount like "10" or "12.5".`);
  let amount: bigint;
  try {
    amount = ethers.parseUnits(String(value), USDT_DECIMALS);
  } catch {
    throw new ApiError(400, "InvalidAmount", `${field} must be a USDT amount with at most ${USDT_DECIMALS} decimals (got "${value}").`);
  }
  if (amount <= 0n) throw new ApiError(400, "InvalidAmount", `${field} must be greater than 0.`);
  return amount;
}

export function parseAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !ethers.isAddress(value)) throw new ApiError(400, "InvalidAddress", `${field} must be an EVM address.`);
  const address = ethers.getAddress(value);
  if (address === ethers.ZeroAddress) throw new ApiError(400, "InvalidAddress", `${field} can't be the zero address.`);
  return address;
}

function unsigned(network: StepNetwork, from: string, to: string, data: string): UnsignedTx {
  return { from, to, data, value: "0x0", chainId: ethers.toQuantity(network.chainId) };
}

const usdt = (amount: bigint) => `${ethers.formatUnits(amount, USDT_DECIMALS)} USDT`;

/// The approvals needed for the gateway to pull `amount`, given the current allowance: none if
/// it already covers it, else an approve - preceded by one to 0 where USDT requires that.
export function approveSteps(network: StepNetwork, from: string, amount: bigint, allowance: bigint): TxStep[] {
  if (!network.gateway) throw new ApiError(400, "NoApprovalNeeded", "Purchases on Xode are a plain USDT transfer - nothing to approve.");
  if (allowance >= amount) return [];
  const approve = (value: bigint, description: string): TxStep => ({
    kind: "approve",
    description,
    tx: unsigned(network, from, network.usdtAddress, network.usdt.interface.encodeFunctionData("approve", [network.payTo, value])),
  });
  const amountText = amount === ethers.MaxUint256 ? "unlimited USDT" : usdt(amount);
  const steps: TxStep[] = [];
  if (allowance > 0n && network.approveResetsToZero) {
    steps.push(approve(0n, `Reset the gateway's USDT allowance to 0 (USDT on ${network.name} won't change a non-zero allowance directly)`));
  }
  steps.push(approve(amount, `Allow the gateway to take ${amountText}`));
  return steps;
}

export function depositStep(network: StepNetwork, from: string, amount: bigint, beneficiary: string): TxStep {
  if (!network.gateway) throw new ApiError(400, "NoGateway", "Xode has no gateway - use a buy (a USDT transfer to the vending contract) instead.");
  return {
    kind: "deposit",
    description: `Deposit ${usdt(amount)} into the gateway; XON is paid to ${beneficiary} on Xode`,
    tx: unsigned(network, from, network.payTo, network.gateway.interface.encodeFunctionData("deposit", [amount, beneficiary])),
  };
}

export function transferStep(network: StepNetwork, from: string, amount: bigint): TxStep {
  return {
    kind: "transfer",
    description: `Send ${usdt(amount)} to the XON vending contract; XON is paid back to ${from}`,
    tx: unsigned(network, from, network.usdtAddress, network.usdt.interface.encodeFunctionData("transfer", [network.payTo, amount])),
  };
}

/// Every transaction a purchase needs, in the order they must be sent.
export function purchaseSteps(network: StepNetwork, from: string, amount: bigint, beneficiary: string, allowance: bigint): TxStep[] {
  if (!network.gateway) {
    // On Xode the payout goes to whoever sent the USDT - there's nowhere to name anyone else.
    if (beneficiary !== from) throw new ApiError(400, "BeneficiaryNotSupported", "On Xode, XON is always paid to the sender - send from the address that should receive it.");
    return [transferStep(network, from, amount)];
  }
  return [...approveSteps(network, from, amount, allowance), depositStep(network, from, amount, beneficiary)];
}
