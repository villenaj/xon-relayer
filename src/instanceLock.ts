// Guards against two relayers running against the same checkpoint directory - e.g. a manual start
// while the systemd service is up, or a botched deploy. They'd share the relayer key, so their
// transactions would keep colliding on nonces, and both would write the same checkpoints and
// ledger. Settling can't double-pay (the contract refuses), but it's a mess worth refusing outright.
//
// The lock is a file created exclusively, holding the owner's pid and host. A lock left behind by a
// crash (its pid no longer running on this host) is taken over; anything else refuses to start.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

interface LockHolder {
  pid: number;
  host: string;
  started: string;
}

function readHolder(file: string): LockHolder | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as LockHolder;
  } catch {
    return null; // unreadable / half-written by a crash
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

/// Takes the lock or throws. Returns a function that releases it (also done automatically on exit).
export function acquireInstanceLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "relayer.lock");

  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(file, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readHolder(file);
      const stale = holder === null
        || (holder.host === hostname() && (holder.pid === process.pid || !isRunning(holder.pid)));
      if (!stale) {
        throw new Error(
          `Another relayer is already running (pid ${holder.pid} on ${holder.host}, since ${holder.started}) - it holds ${file}. ` +
          `Two relayers sharing a key collide on every transaction. If you're sure it isn't running, delete that file.`,
        );
      }
      console.warn(`Taking over a stale lock left by a previous run (${holder ? `pid ${holder.pid}` : "unreadable"}).`);
      unlinkSync(file);
      continue;
    }

    const holder: LockHolder = { pid: process.pid, host: hostname(), started: new Date().toISOString() };
    writeSync(fd, JSON.stringify(holder));
    closeSync(fd);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        unlinkSync(file);
      } catch {
        // already gone - nothing to do
      }
    };
    process.on("exit", release);
    return release;
  }
  throw new Error(`Couldn't take the lock at ${file}.`);
}
