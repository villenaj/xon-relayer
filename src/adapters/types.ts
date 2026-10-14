import type { Config } from "../config.js";
import type { Ledger } from "../ledger.js";
import type { SettlementClient } from "../settlement.js";

/// What every adapter is handed by index.ts.
export interface AdapterContext {
  settlement: SettlementClient;
  config: Config;
  ledger: Ledger;
}
