// Refunds without the owner. A gateway deposit that can never be paid (its own minimum can't be
// met, its beneficiary can't receive XON) used to need two owner-Safe transactions - cancel it on
// Xode, refund it on the gateway - with the owner alone deciding whether the refund fee applied.
// Instead, each attester's relayer:
//   1. votes to cancel it on Xode (`attestExternalCancel`), with the fee decided by rule: kept
//      only when the deposit's own minimum wasn't met. A quorum cancels it - it can never be paid;
//   2. once it IS cancelled - never before - signs the gateway's refund digest for exactly that
//      deposit and that fee, and publishes the signature on Xode (`publishRefundSignature`).
// Anyone can then collect a quorum of signatures from Xode's events and submit them to the
// gateway's `refundAttested` (npm run refunds prints the call). The relayer itself holds no gas
// on the source chains and sends nothing there.
//
// What an attester signs rests on its own scan: the nonce, depositor and amount come from the
// deposit log it read (and cross-checked) itself, and the deposit id is derived from that log.

import { ethers } from "ethers";
import type { Contract } from "ethers";
import { describeError, classifySettleError } from "../errorClassifier.js";
import type { SettlementClient } from "../settlement.js";

/// Why a deposit was skipped decides the fee: the gateway keeps it only when the depositor's own
/// minimum couldn't be met - never for anything on the operator's side. Every attester applies
/// the same rule, so their votes agree.
export const FEE_BEARING_ERRORS = new Set(["MinimumNotMet", "BelowMinimum"]);
export function refundChargesFee(error: string | null | undefined): boolean {
  return FEE_BEARING_ERRORS.has(error ?? "");
}

export interface RefundableDeposit {
  depositId: string;
  sourceTxHash: string;
  usdtAmount: bigint;
  gatewayNonce?: bigint;
  depositor?: string;
}

type Settlement = Pick<SettlementClient, "cancelState" | "voteCancel" | "publishRefundSignature" | "vending">;
interface GatewayLike {
  depositRecords(nonce: bigint): Promise<string>;
  attestationThreshold(): Promise<bigint>;
  refundDigest(nonce: bigint, depositor: string, usdtAmount: bigint, chargeFee: boolean): Promise<string>;
}

export interface RefundAttester {
  /// A deposit this instance gave up on: start (or join) its cancellation and refund.
  add(deposit: RefundableDeposit, error: string | null): void;
  /// One pass over the deposits still in progress.
  tick(): Promise<void>;
  pending(): number;
}

const STUCK_ALERT_MS = 60 * 60_000;

export function createRefundAttester(options: {
  label: string;
  settlement: Settlement;
  gateway: GatewayLike | Contract;
  alert(message: string): void;
}): RefundAttester {
  const { label, settlement, alert } = options;
  const gateway = options.gateway as GatewayLike;
  const pending = new Map<string, { deposit: RefundableDeposit; error: string | null; since: number; alerted: boolean }>();

  /// True once there is nothing more for this attester to do for the deposit.
  async function advance(deposit: RefundableDeposit, error: string | null): Promise<boolean> {
    if (deposit.gatewayNonce === undefined || !deposit.depositor) return true; // not a recorded gateway deposit
    // Already refunded (or released as paid) on the gateway: its record is gone.
    if ((await gateway.depositRecords(deposit.gatewayNonce)) === ethers.ZeroHash) return true;

    let state = await settlement.cancelState(deposit.depositId);
    if (state.paid) return true; // paid after all - never refund it
    if (!state.cancelled) {
      if (error === "DepositIsCancelled") return false; // reported cancelled, not visible yet
      if (!state.voted) {
        try {
          await settlement.voteCancel(deposit.depositId, refundChargesFee(error), label);
        } catch (err) {
          const { name } = classifySettleError(settlement.vending, err);
          if (name === "AlreadyExternallySettled") return true;
          if (name !== "DepositIsCancelled" && name !== "AlreadyAttested") throw err;
        }
        state = await settlement.cancelState(deposit.depositId);
        if (state.paid) return true;
      }
      if (!state.cancelled) return false; // waiting for the other attesters' votes
    }

    if ((await gateway.attestationThreshold()) === 0n) {
      console.warn(`[${label}] ${deposit.sourceTxHash} is cancelled on Xode, but the gateway takes no attested refunds (threshold 0) - its owner has to refund it (npm run refunds).`);
      return true;
    }
    // Cancelled on Xode for good: only now is a refund signature safe to exist.
    const digest = await gateway.refundDigest(deposit.gatewayNonce, deposit.depositor, deposit.usdtAmount, state.chargeFee);
    await settlement.publishRefundSignature(deposit.depositId, digest, label);
    return true;
  }

  return {
    add(deposit, error) {
      if (!pending.has(deposit.depositId)) pending.set(deposit.depositId, { deposit, error, since: Date.now(), alerted: false });
    },
    async tick() {
      for (const [id, entry] of pending) {
        try {
          if (await advance(entry.deposit, entry.error)) {
            pending.delete(id);
          } else if (!entry.alerted && Date.now() - entry.since >= STUCK_ALERT_MS) {
            entry.alerted = true;
            alert(`[${label}] Deposit ${entry.deposit.sourceTxHash} can't be paid (${entry.error ?? "skipped"}) and the attesters haven't agreed to cancel it for ${Math.round((Date.now() - entry.since) / 60_000)} min - check the other attesters, or cancel and refund it from the owner Safe (npm run refunds).`);
          }
        } catch (err) {
          console.error(`[${label}] Couldn't advance the refund of ${entry.deposit.sourceTxHash}, will retry:`, describeError(err));
        }
      }
    },
    pending: () => pending.size,
  };
}

/// The refund signatures published on Xode for a deposit that verify against `digest`, one per
/// current gateway attester, ordered by signer address as `refundAttested` wants them.
export async function collectRefundSignatures(
  logs: readonly { topics: readonly string[]; data: string }[],
  vendingInterface: ethers.Interface,
  digest: string,
  isGatewayAttester: (address: string) => Promise<boolean>,
): Promise<{ signer: string; signature: string }[]> {
  const bySigner = new Map<string, string>();
  for (const log of logs) {
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = vendingInterface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (parsed?.name !== "RefundSigned") continue;
    const signature: string = parsed.args.signature;
    let signer: string;
    try {
      signer = ethers.verifyMessage(ethers.getBytes(digest), signature);
    } catch {
      continue;
    }
    // The signature must be by the attester that published it, for exactly this refund.
    if (signer.toLowerCase() !== String(parsed.args.attester).toLowerCase()) continue;
    if (!bySigner.has(signer) && (await isGatewayAttester(signer))) bySigner.set(signer, signature);
  }
  return [...bySigner.entries()]
    .sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1))
    .map(([signer, signature]) => ({ signer, signature }));
}
