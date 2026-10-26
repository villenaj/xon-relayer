// Live updates for the front-end, over Server-Sent Events:
//
//   - Address watch: one block scanner per chain, shared by every subscriber and running only
//     while someone is subscribed. Each new block is checked for transactions sent from or to a
//     watched address (pushed with their receipt), USDT arriving at one, and - on Xode - XON
//     payouts to one. Starts at the chain head: it reports what happens from now on, the
//     balance/deposit endpoints cover what already has. Events are reported at the head, before
//     confirmation - after a reorg the same transaction can be reported again from its new block.
//   - Tx progress: follows one transaction from pending to mined to confirmed and, for a
//     purchase, until each deposit is paid (or held/skipped), then closes.

import { ethers, type JsonRpcProvider } from "ethers";
import { TRANSFER_TOPIC } from "../tools/common.js";
import { toJson, type EventStream } from "./http.js";
import type { Network, NetworkName, Networks } from "./networks.js";
import { EXTERNAL_SETTLED_TOPIC, FINAL_DEPOSIT_STATES, nativeAmount, receiptJson, SETTLED_TOPIC, usdtAmount, type ApiService, type DepositInfo, type TxStatus } from "./service.js";

/// Blocks a scanner will catch up on after falling behind (RPC outage); older ones are skipped.
const MAX_BACKLOG_BLOCKS = 50;
/// A tx progress stream gives up after this long - Ethereum finality alone is ~13 minutes.
const TX_STREAM_TIMEOUT_MS = 60 * 60_000;

interface Subscriber {
  addresses: Set<string>; // lowercase
  stream: EventStream;
}

export class BlockScanner {
  private readonly subscribers = new Set<Subscriber>();
  private nextBlock: number | null = null;
  private running = false;

  constructor(
    private readonly network: Network,
    /// Xode's vending contract, to report XON payouts - null on other chains.
    private readonly vending: ethers.Contract | null,
    private readonly pollIntervalMs: number,
  ) {}

  subscribe(addresses: string[], stream: EventStream): void {
    const subscriber = { addresses: new Set(addresses.map((a) => a.toLowerCase())), stream };
    this.subscribers.add(subscriber);
    if (!this.running) void this.run();
  }

  unsubscribe(stream: EventStream): void {
    for (const s of this.subscribers) if (s.stream === stream) this.subscribers.delete(s);
  }

  private async run(): Promise<void> {
    this.running = true;
    this.nextBlock = null;
    while (this.subscribers.size > 0) {
      try {
        await this.tick();
      } catch (err) {
        // Retried from the same block next time.
        console.error(`[api:${this.network.name}] Block scan failed:`, err instanceof Error ? err.message : err);
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    this.running = false;
  }

  private async tick(): Promise<void> {
    const provider: JsonRpcProvider = this.network.provider;
    const head = await provider.getBlockNumber();
    if (this.nextBlock === null) this.nextBlock = head;
    if (head - this.nextBlock >= MAX_BACKLOG_BLOCKS) this.nextBlock = head - MAX_BACKLOG_BLOCKS + 1;
    if (this.nextBlock > head) return;

    // Block by block, advancing after each: a failure is retried from the block it failed on.
    for (let number = this.nextBlock; number <= head; number++) {
      await this.scanBlock(provider, number);
      this.nextBlock = number + 1;
      this.emit([...this.subscribers], "block", { network: this.network.name, blockNumber: number });
    }
  }

  private async scanBlock(provider: JsonRpcProvider, number: number): Promise<void> {
    const block = await provider.getBlock(number, true);
    if (!block) throw new Error(`RPC returned no block ${number}`);
    const events: [Subscriber[], string, unknown][] = [];

    for (const tx of block.prefetchedTransactions) {
      const targets = this.matching(tx.from, tx.to);
      if (targets.length === 0) continue;
      const receipt = await provider.getTransactionReceipt(tx.hash);
      // Right after a reorg the RPC can briefly still hand back the receipt from the old block.
      if (!receipt || receipt.blockHash !== block.hash) throw new Error(`receipt for ${tx.hash} isn't indexed for block ${number} yet`);
      events.push([targets, "transaction", { network: this.network.name, timestamp: block.timestamp, ...receiptJson(receipt) }]);
    }

    // Filtered by topic0 only (Xode's bridge rejects null topic wildcards) and matched here.
    const usdtLogs = await provider.getLogs({ address: this.network.usdtAddress, topics: [TRANSFER_TOPIC], fromBlock: number, toBlock: number });
    for (const log of usdtLogs) {
      const to = ethers.getAddress(ethers.dataSlice(log.topics[2], 12));
      const targets = this.matching(to);
      if (targets.length === 0) continue;
      events.push([targets, "usdt-received", {
        network: this.network.name,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        from: ethers.getAddress(ethers.dataSlice(log.topics[1], 12)),
        to,
        amount: usdtAmount(ethers.toBigInt(log.data)),
      }]);
    }

    if (this.vending) {
      for (const topic of [SETTLED_TOPIC, EXTERNAL_SETTLED_TOPIC]) {
        const logs = await provider.getLogs({ address: this.network.payTo, topics: [topic], fromBlock: number, toBlock: number });
        for (const log of logs) {
          const parsed = this.vending.interface.parseLog(log);
          if (!parsed) continue;
          const targets = this.matching(parsed.args.buyer);
          if (targets.length === 0) continue;
          events.push([targets, "xon-payout", {
            network: this.network.name,
            settleTxHash: log.transactionHash,
            blockNumber: log.blockNumber,
            beneficiary: parsed.args.buyer,
            sourceChain: topic === SETTLED_TOPIC ? "xode" : parsed.args.sourceChain,
            depositId: topic === SETTLED_TOPIC ? parsed.args.depositTxHash : parsed.args.depositId,
            usdtAmount: usdtAmount(parsed.args.usdtIn),
            xonAmount: nativeAmount(parsed.args.xonOut),
          }]);
        }
      }
    }

    // Only once the whole block has been read, so a retried block isn't half-reported twice.
    for (const [targets, event, data] of events) this.emit(targets, event, data);
  }

  private matching(...addresses: (string | null)[]): Subscriber[] {
    const wanted = addresses.filter((a): a is string => a !== null).map((a) => a.toLowerCase());
    return [...this.subscribers].filter((s) => wanted.some((a) => s.addresses.has(a)));
  }

  private emit(targets: Subscriber[], event: string, data: unknown): void {
    for (const s of targets) s.stream.send(event, data);
  }
}

export function makeScanners(networks: Networks, pollIntervalMs: number): Map<NetworkName, BlockScanner> {
  return new Map([...networks.byName.values()].map((net) => [net.name, new BlockScanner(net, net.name === "xode" ? networks.vending : null, pollIntervalMs)]));
}

/// Streams a transaction's progress until it's done: "status" whenever anything changes (the
/// full txStatus body), "payout" for each deposit once XON is paid, then "done" (or "timeout").
export async function followTx(service: ApiService, networkName: string, txHash: string, stream: EventStream, pollIntervalMs: number): Promise<void> {
  const net = service.network(networkName);
  const deadline = Date.now() + TX_STREAM_TIMEOUT_MS;
  // Where on Xode to look for payout events if the ledger can't name the settle tx.
  const xodeStart = Math.max(0, (await service.network("xode").provider.getBlockNumber()) - 100);
  const paid = new Map<string, Pick<DepositInfo, "settleTxHash" | "xonAmount">>();
  let last = "";

  while (!stream.closed) {
    let status: TxStatus;
    try {
      status = await service.txStatus(networkName, txHash);
    } catch (err) {
      console.error(`[api] Following ${networkName} tx ${txHash} failed:`, err instanceof Error ? err.message : err);
      await stream.sleep(pollIntervalMs);
      continue;
    }

    for (const deposit of status.deposits) {
      if (deposit.state !== "settled") continue;
      let payout = paid.get(deposit.depositId);
      if (!payout) {
        const found = await service.findPayout(deposit.depositId, net.gateway !== null, xodeStart);
        if (!found && !deposit.settleTxHash) continue; // flag's set but the event isn't visible yet - next poll
        payout = { settleTxHash: found?.settleTxHash ?? deposit.settleTxHash, xonAmount: found?.xonAmount ?? null };
        paid.set(deposit.depositId, payout);
        stream.send("payout", { network: net.name, txHash: status.txHash, ...deposit, ...payout });
      }
      Object.assign(deposit, payout);
    }

    const snapshot = toJson({ ...status, confirmations: undefined, deposits: status.deposits.map((d) => [d.depositId, d.state]) });
    if (snapshot !== last) {
      last = snapshot;
      stream.send("status", status);
    }

    const finished =
      status.state === "failed" ||
      (status.state === "mined" && status.confirmed && status.deposits.every((d) => FINAL_DEPOSIT_STATES.has(d.state) && (d.state !== "settled" || paid.has(d.depositId)))) ||
      // Held deposits wait on an operator, which can take a while - stop following.
      (status.deposits.length > 0 && status.deposits.every((d) => FINAL_DEPOSIT_STATES.has(d.state) || d.state === "held") && status.deposits.some((d) => d.state === "held"));
    if (finished) {
      stream.send("done", { network: net.name, txHash: status.txHash, state: status.state, deposits: status.deposits });
      break;
    }
    if (Date.now() > deadline) {
      stream.send("timeout", { network: net.name, txHash: status.txHash, message: "Stopped following - check the transaction status endpoint." });
      break;
    }
    await stream.sleep(pollIntervalMs);
  }
  stream.close();
}
