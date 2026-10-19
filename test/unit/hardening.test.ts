import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import type { JsonRpcProvider } from "ethers";
import { verifyEndpoint } from "../../src/chain.js";
import { acquireInstanceLock } from "../../src/instanceLock.js";
import { quiet, tmpDir } from "./helpers.js";

quiet();

// config.ts reads required settings at import time, so load it only once the env is in place.
process.env.VENDING_ADDRESS ??= "0x00000000000000000000000000000000000000aa";
const { loadRelayerKey } = await import("../../src/config.js");

const KEY = `0x${"ab".repeat(32)}`;

// --- instance lock -----------------------------------------------------------------------------

const lockFile = (dir: string) => path.join(dir, "relayer.lock");
const writeLock = (dir: string, holder: object | string) =>
  writeFileSync(lockFile(dir), typeof holder === "string" ? holder : JSON.stringify(holder));

test("takes the lock, records who holds it, and releases it", () => {
  const dir = tmpDir();
  const release = acquireInstanceLock(dir);
  const holder = JSON.parse(readFileSync(lockFile(dir), "utf8"));
  assert.equal(holder.pid, process.pid);
  assert.equal(holder.host, hostname());
  release();
  assert.equal(existsSync(lockFile(dir)), false);
});

test("refuses to start while another live relayer holds the lock", () => {
  const dir = tmpDir();
  writeLock(dir, { pid: process.ppid, host: hostname(), started: "earlier" }); // our parent: definitely running
  assert.throws(() => acquireInstanceLock(dir), /Another relayer is already running/);
  assert.throws(() => acquireInstanceLock(dir), /Another relayer is already running/, "and keeps refusing");
});

test("refuses a lock held from another host - it can't tell whether that one is alive", () => {
  const dir = tmpDir();
  writeLock(dir, { pid: 1, host: "some-other-host", started: "earlier" });
  assert.throws(() => acquireInstanceLock(dir), /on some-other-host/);
});

test("takes over a lock left behind by a crash (dead pid, or a half-written file)", () => {
  for (const stale of [{ pid: 2 ** 22 + 12345, host: hostname(), started: "earlier" }, "{\"pid\":"]) {
    const dir = tmpDir();
    writeLock(dir, stale);
    const release = acquireInstanceLock(dir);
    assert.equal(JSON.parse(readFileSync(lockFile(dir), "utf8")).pid, process.pid);
    release();
  }
});

// --- relayer key -------------------------------------------------------------------------------

function withKeyEnv(env: { RELAYER_PRIVATE_KEY?: string; RELAYER_PRIVATE_KEY_FILE?: string; CREDENTIALS_DIRECTORY?: string }, fn: () => void) {
  const names = ["RELAYER_PRIVATE_KEY", "RELAYER_PRIVATE_KEY_FILE", "CREDENTIALS_DIRECTORY"] as const;
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) {
    if (env[n] === undefined) delete process.env[n];
    else process.env[n] = env[n];
  }
  try {
    fn();
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
}

test("loads the key from the systemd credential, trimming the trailing newline", () => {
  const dir = tmpDir();
  writeFileSync(path.join(dir, "relayer-key"), `${KEY}\n`);
  withKeyEnv({ CREDENTIALS_DIRECTORY: dir }, () => {
    assert.deepEqual(loadRelayerKey(), { key: KEY, source: 'systemd credential "relayer-key"' });
  });
});

test("loads the key from a file, or (for development) the env var - which it then scrubs", () => {
  const file = path.join(tmpDir(), "key");
  writeFileSync(file, KEY);
  withKeyEnv({ RELAYER_PRIVATE_KEY_FILE: file }, () => assert.equal(loadRelayerKey().key, KEY));
  withKeyEnv({ RELAYER_PRIVATE_KEY: KEY }, () => {
    assert.equal(loadRelayerKey().key, KEY);
    assert.equal(process.env.RELAYER_PRIVATE_KEY, undefined);
  });
});

test("a credentials directory without our credential doesn't count as a key source", () => {
  withKeyEnv({ CREDENTIALS_DIRECTORY: tmpDir(), RELAYER_PRIVATE_KEY: KEY }, () => {
    assert.equal(loadRelayerKey().source, "RELAYER_PRIVATE_KEY env var");
  });
});

test("refuses no key, two keys, or a malformed key - without echoing the key", () => {
  withKeyEnv({}, () => assert.throws(() => loadRelayerKey(), /No relayer key/));

  const file = path.join(tmpDir(), "key");
  writeFileSync(file, KEY);
  withKeyEnv({ RELAYER_PRIVATE_KEY_FILE: file, RELAYER_PRIVATE_KEY: KEY }, () => {
    assert.throws(() => loadRelayerKey(), /more than one place/);
  });

  const secretish = "0xnot-a-key-but-maybe-secret";
  withKeyEnv({ RELAYER_PRIVATE_KEY: secretish }, () => {
    assert.throws(() => loadRelayerKey(), (err: Error) => /isn't a 32-byte hex private key/.test(err.message) && !err.message.includes(secretish));
  });
});

test("accepts a key without the 0x prefix, as wallets like MetaMask export it", () => {
  withKeyEnv({ RELAYER_PRIVATE_KEY: KEY.slice(2) }, () => assert.equal(loadRelayerKey().key, KEY));
  const file = path.join(tmpDir(), "key");
  writeFileSync(file, `${KEY.slice(2)}\n`);
  withKeyEnv({ RELAYER_PRIVATE_KEY_FILE: file }, () => assert.equal(loadRelayerKey().key, KEY));
});

// --- endpoint checks ---------------------------------------------------------------------------

function fakeProvider(chainId: bigint, codeAt: string[]) {
  return {
    getNetwork: async () => ({ chainId }),
    getCode: async (address: string) => (codeAt.includes(address) ? "0x6080" : "0x"),
  } as unknown as JsonRpcProvider;
}

test("accepts the right chain with the contracts present", async () => {
  const provider = fakeProvider(3417n, ["0xV"]);
  assert.equal(await verifyEndpoint(provider, { label: "xode", expectedChainId: 3417n, contracts: { Vending: "0xV" } }), 3417n);
  assert.equal(await verifyEndpoint(provider, { label: "xode", expectedChainId: null, contracts: {} }), 3417n);
});

test("refuses the wrong chain, or a contract address with no code", async () => {
  await assert.rejects(
    verifyEndpoint(fakeProvider(1n, ["0xV"]), { label: "ethereum", expectedChainId: 11155111n, contracts: {} }),
    /reports chain ID 1, but it's configured for chain 11155111/,
  );
  await assert.rejects(
    verifyEndpoint(fakeProvider(1n, []), { label: "ethereum", expectedChainId: 1n, contracts: { UsdtGateway: "0xG" } }),
    /No contract code for UsdtGateway at 0xG/,
  );
});

