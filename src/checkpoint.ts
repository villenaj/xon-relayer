// Shared, atomic on-disk checkpoint helper used by every adapter. Each adapter gets its own
// checkpoint file so a restart resumes each source independently from where it left off, instead
// of silently skipping whatever arrived on that source during downtime.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface Checkpoint<T> {
  load(): T | null;
  save(value: T): void;
}

interface CheckpointFile<T> {
  identity: string;
  value: T;
}

export function makeCheckpoint<T>(filePath: string, identity: string): Checkpoint<T> {
  function load(): T | null {
    if (!existsSync(filePath)) return null;
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as CheckpointFile<T>;
    if (parsed.identity !== identity) {
      throw new Error(
        `${filePath} was written for identity "${parsed.identity}", not "${identity}". ` +
        `Use a different checkpoint file per source/contract, or remove the stale file if that's expected.`,
      );
    }
    return parsed.value;
  }

  function save(value: T): void {
    const dir = dirname(filePath);
    if (dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmpFile = `${filePath}.tmp`;
    const contents: CheckpointFile<T> = { identity, value };
    // Write-fsync-rename-fsync(dir): without the fsyncs, a power cut can leave a renamed but empty
    // checkpoint, which load() can't parse - and the relayer wouldn't start until it's fixed by hand.
    const fd = openSync(tmpFile, "w");
    try {
      writeSync(fd, JSON.stringify(contents, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpFile, filePath);
    syncDir(dir);
  }

  return { load, save };
}

function syncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Some platforms/filesystems can't fsync a directory - the file itself is already synced.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
