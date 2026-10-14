import { describeError } from "../errorClassifier.js";
import type { AdapterContext } from "./types.js";

/// Runs an adapter's `tick` every POLL_INTERVAL_MS until shutdown is requested, reporting each
/// poll to telemetry. `tick` returns how many blocks it's still behind the safe head (0 = caught
/// up). Only failures before the loop starts (bad config, unreachable RPC at startup) propagate -
/// a failed tick is logged and retried.
export async function runPollLoop(
  { config, telemetry, shutdown }: AdapterContext,
  label: string,
  tick: () => Promise<number>,
): Promise<void> {
  telemetry.registerAdapter(label);
  while (!shutdown.requested) {
    try {
      telemetry.tickSucceeded(label, await tick());
    } catch (err) {
      telemetry.tickFailed(label);
      console.error(`[${label}] Poll tick failed:`, describeError(err));
    }
    await shutdown.sleep(config.pollIntervalMs);
  }
  console.log(`[${label}] Stopped.`);
}
