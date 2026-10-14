import { test } from "node:test";
import assert from "node:assert/strict";
import type { TransactionReceipt, TransactionRequest, TransactionResponse } from "ethers";
import { sendAndConfirm, type Sender } from "../../src/settlement.js";
import { quiet, revertError } from "./helpers.js";

quiet();

const FAST = { confirmTimeoutMs: 20, receiptPollMs: 5, maxFeeBumps: 2 };

function tx(hash: string, overrides: Partial<Record<keyof TransactionResponse, unknown>> = {}): TransactionResponse {
  return {
    hash, nonce: 7, to: "0x00000000000000000000000000000000000000aa", from: "0x00000000000000000000000000000000000000bb",
    data: "0xabcdef", value: 0n, gasLimit: 100_000n, chainId: 1n, type: 2,
    maxFeePerGas: 100n, maxPriorityFeePerGas: 10n, gasPrice: 100n, ...overrides,
  } as unknown as TransactionResponse;
}
const receipt = (hash: string, status = 1) => ({ hash, blockNumber: 42, status }) as unknown as TransactionReceipt;

interface FakeChain {
  receipts: Map<string, TransactionReceipt>;
  /// Hashes the node still knows about (pending or mined); anything else counts as dropped.
  known: Set<string>;
  replacements: TransactionRequest[];
  resets: number;
  calls: unknown[];
}

function fakeSender(onReplacement: (req: TransactionRequest, n: number, chain: FakeChain) => TransactionResponse): [Sender, FakeChain] {
  const chain: FakeChain = { receipts: new Map(), known: new Set(), replacements: [], resets: 0, calls: [] };
  const sender = {
    provider: {
      getTransactionReceipt: async (h: string) => chain.receipts.get(h) ?? null,
      getTransaction: async (h: string) => (chain.known.has(h) ? {} : null),
      getFeeData: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasPrice: 1n }),
      call: async (req: unknown) => {
        chain.calls.push(req);
        throw revertError("ZeroAmount");
      },
    },
    wallet: {
      sendTransaction: async (req: TransactionRequest) => {
        chain.replacements.push(req);
        return onReplacement(req, chain.replacements.length, chain);
      },
    },
    signer: { reset: () => chain.resets++ },
  };
  return [sender as unknown as Sender, chain];
}
const noReplacement = () => {
  throw new Error("unexpected replacement");
};

test("returns the receipt once the tx is mined", async () => {
  const [sender, chain] = fakeSender(noReplacement);
  chain.receipts.set("0x1", receipt("0x1"));
  const result = await sendAndConfirm(sender, "t", async () => tx("0x1"), FAST);
  assert.equal(result.hash, "0x1");
  assert.equal(chain.resets, 0);
});

test("a failed send resets the nonce (NonceManager already counted it) and rethrows", async () => {
  const [sender, chain] = fakeSender(noReplacement);
  const err = revertError("ZeroAmount");
  await assert.rejects(sendAndConfirm(sender, "t", async () => { throw err; }, FAST), (e) => e === err);
  assert.equal(chain.resets, 1);
});

test("a mined-but-reverted tx is replayed at its block to recover the revert reason", async () => {
  const [sender, chain] = fakeSender(noReplacement);
  chain.receipts.set("0x1", receipt("0x1", 0));
  await assert.rejects(sendAndConfirm(sender, "t", async () => tx("0x1"), FAST), (e: { data?: string }) => e.data === revertError("ZeroAmount").data);
  assert.deepEqual(chain.calls, [{ to: tx("0x1").to, from: tx("0x1").from, data: "0xabcdef", blockTag: 42 }]);
});

test("a tx dropped from the pool resets the nonce and fails for a retry", async () => {
  const [sender, chain] = fakeSender(noReplacement);
  await assert.rejects(sendAndConfirm(sender, "t", async () => tx("0x1"), FAST), /dropped from the pool/);
  assert.equal(chain.resets, 1);
});

test("a tx stuck pending is resent at the same nonce with fees bumped 25%", async () => {
  const [sender, chain] = fakeSender((req, n, c) => {
    const hash = `0xr${n}`;
    c.known.add(hash);
    c.receipts.set(hash, receipt(hash));
    return tx(hash);
  });
  chain.known.add("0x1");
  const result = await sendAndConfirm(sender, "t", async () => tx("0x1"), FAST);

  assert.equal(result.hash, "0xr1");
  assert.equal(chain.replacements.length, 1);
  const req = chain.replacements[0];
  assert.equal(req.nonce, 7);
  assert.equal(req.gasLimit, 100_000n);
  assert.equal(req.data, "0xabcdef");
  assert.equal(req.maxFeePerGas, 126n);
  assert.equal(req.maxPriorityFeePerGas, 13n);
  assert.equal(chain.resets, 0);
});

test("legacy (gasPrice) txs get their gas price bumped instead", async () => {
  const [sender, chain] = fakeSender((req, n, c) => {
    c.receipts.set("0xr1", receipt("0xr1"));
    return tx("0xr1");
  });
  chain.known.add("0x1");
  await sendAndConfirm(sender, "t", async () => tx("0x1", { type: 0, maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice: 200n }), FAST);
  assert.equal(chain.replacements[0].gasPrice, 251n);
  assert.equal(chain.replacements[0].maxFeePerGas, undefined);
});

test("gives up after the configured number of bumps, without resetting the still-pending nonce", async () => {
  const [sender, chain] = fakeSender((req, n, c) => {
    c.known.add(`0xr${n}`);
    return tx(`0xr${n}`);
  });
  chain.known.add("0x1");
  await assert.rejects(sendAndConfirm(sender, "t", async () => tx("0x1"), FAST), /still pending after 2 fee bumps/);
  assert.equal(chain.replacements.length, 2);
  assert.equal(chain.resets, 0);
});

test("a rejected replacement (e.g. the original just got mined) keeps waiting on what was sent", async () => {
  const [sender, chain] = fakeSender((req, n, c) => {
    c.receipts.set("0x1", receipt("0x1"));
    throw new Error("nonce too low");
  });
  chain.known.add("0x1");
  const result = await sendAndConfirm(sender, "t", async () => tx("0x1"), FAST);
  assert.equal(result.hash, "0x1");
});
