import type { Alerts } from "../alerts.js";
import type { Config } from "../config.js";
import type { Ledger } from "../ledger.js";
import type { PayoutLimiter } from "../payoutLimits.js";
import type { SettlementClient } from "../settlement.js";
import type { Shutdown } from "../shutdown.js";
import type { Telemetry } from "../telemetry.js";

/// What every adapter is handed by index.ts.
export interface AdapterContext {
  settlement: SettlementClient;
  config: Config;
  ledger: Ledger;
  limiter: PayoutLimiter;
  telemetry: Telemetry;
  alerts: Alerts;
  shutdown: Shutdown;
}
