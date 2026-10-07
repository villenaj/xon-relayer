// Shared, atomic on-disk checkpoint helper used by every adapter. Each adapter gets its own
// checkpoint file so a restart resumes each source independently from where it left off, instead
// of silently skipping whatever arrived on that source during downtime.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function makeCheckpoint(filePath, identity) {
  function load() {
    if (!existsSync(filePath)) return null;
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed.identity !== identity) {
      throw new Error(
        `${filePath} was written for identity "${parsed.identity}", not "${identity}". ` +
        `Use a different checkpoint file per source/contract, or remove the stale file if that's expected.`,
      );
    }
    return parsed.value;
  }

  function save(value) {
    const dir = dirname(filePath);
    if (dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmpFile = `${filePath}.tmp`;
    writeFileSync(tmpFile, JSON.stringify({ identity, value }, null, 2));
    renameSync(tmpFile, filePath);
  }

  return { load, save };
}
