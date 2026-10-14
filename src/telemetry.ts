// Health and metrics, served over plain HTTP (no dependencies):
//   GET /health  - 200 if every adapter has caught up to its chain's head recently, else 503,
//                  with per-adapter detail and any low-balance warnings as JSON.
//   GET /metrics - Prometheus text format.
// "Caught up" (nothing left to scan up to the safe head) is what's tracked rather than "a poll
// ran", because an adapter stalled on a deposit that keeps failing still polls happily - it just
// never gets past that deposit.

import { createServer, type Server } from "node:http";
import type { LedgerStatus } from "./ledger.js";
import type { Shutdown } from "./shutdown.js";

type Labels = Record<string, string>;

class Metric {
  private readonly series = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: "gauge" | "counter",
  ) {}

  set(labels: Labels, value: number): void {
    this.series.set(seriesKey(labels), { labels, value });
  }

  inc(labels: Labels, by = 1): void {
    const key = seriesKey(labels);
    this.series.set(key, { labels, value: (this.series.get(key)?.value ?? 0) + by });
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`];
    for (const { labels, value } of this.series.values()) lines.push(`${this.name}${formatLabels(labels)} ${value}`);
    return lines.join("\n");
  }
}

function seriesKey(labels: Labels): string {
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
}

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const escape = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  return `{${entries.map(([k, v]) => `${k}="${escape(v)}"`).join(",")}}`;
}

interface AdapterState {
  registeredAt: number;
  lastTickAt: number | null;
  lastCaughtUpAt: number | null;
  blocksBehind: number | null;
  consecutiveFailures: number;
}

export class Telemetry {
  private readonly adapters = new Map<string, AdapterState>();
  private warnings: string[] = [];

  private readonly startTime = new Metric("xon_relayer_start_time_seconds", "Unix time the relayer started.", "gauge");
  private readonly lastTick = new Metric("xon_relayer_adapter_last_tick_timestamp_seconds", "Unix time of the adapter's last successful poll.", "gauge");
  private readonly lastCaughtUp = new Metric("xon_relayer_adapter_last_caught_up_timestamp_seconds", "Unix time the adapter last had nothing left to scan up to the safe head.", "gauge");
  private readonly behind = new Metric("xon_relayer_adapter_blocks_behind", "Blocks between the adapter's checkpoint and the chain's safe head, as of its last poll.", "gauge");
  private readonly tickFailures = new Metric("xon_relayer_adapter_tick_failures_total", "Polls that failed outright (RPC errors etc).", "counter");
  private readonly settleAttempts = new Metric("xon_relayer_settle_attempts_total", "Settle attempts by outcome, as recorded in the ledger.", "counter");
  private readonly relayerBalance = new Metric("xon_relayer_relayer_balance_xon", "Relayer account's native balance on Xode (pays gas).", "gauge");
  private readonly vendingReserve = new Metric("xon_relayer_vending_reserve_xon", "XonVendingMachine's XON balance (what payouts come from).", "gauge");
  private readonly externalPaid = new Metric("xon_relayer_external_paid_24h_usdt", "USDT paid out for AssetHub/Ethereum deposits in the rolling 24h cap window.", "gauge");

  constructor(private readonly stallAfterMs: number) {
    this.startTime.set({}, Date.now() / 1000);
  }

  registerAdapter(adapter: string): void {
    this.adapters.set(adapter, { registeredAt: Date.now(), lastTickAt: null, lastCaughtUpAt: null, blocksBehind: null, consecutiveFailures: 0 });
  }

  tickSucceeded(adapter: string, blocksBehind: number): void {
    const state = this.state(adapter);
    const now = Date.now();
    state.lastTickAt = now;
    state.blocksBehind = blocksBehind;
    state.consecutiveFailures = 0;
    if (blocksBehind === 0) state.lastCaughtUpAt = now;
    this.lastTick.set({ adapter }, now / 1000);
    if (state.lastCaughtUpAt !== null) this.lastCaughtUp.set({ adapter }, state.lastCaughtUpAt / 1000);
    this.behind.set({ adapter }, blocksBehind);
  }

  tickFailed(adapter: string): void {
    this.state(adapter).consecutiveFailures++;
    this.tickFailures.inc({ adapter });
  }

  settleAttempt(adapter: string, status: LedgerStatus): void {
    this.settleAttempts.inc({ adapter, status });
  }

  setBalances(relayerXon: number, reserveXon: number): void {
    this.relayerBalance.set({}, relayerXon);
    this.vendingReserve.set({}, reserveXon);
  }

  setExternalPaid24h(usdt: number): void {
    this.externalPaid.set({}, usdt);
  }

  setWarnings(warnings: string[]): void {
    this.warnings = warnings;
  }

  /// Adapters that haven't caught up to their chain's head within the stall threshold.
  stalledAdapters(now = Date.now()): string[] {
    return [...this.adapters.entries()]
      .filter(([, s]) => now - (s.lastCaughtUpAt ?? s.registeredAt) > this.stallAfterMs)
      .map(([adapter]) => adapter);
  }

  health(shuttingDown: boolean): { healthy: boolean; body: object } {
    const now = Date.now();
    const stalled = new Set(this.stalledAdapters(now));
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    const adapters = Object.fromEntries([...this.adapters.entries()].map(([adapter, s]) => [adapter, {
      healthy: !stalled.has(adapter),
      lastTick: iso(s.lastTickAt),
      lastCaughtUp: iso(s.lastCaughtUpAt),
      blocksBehind: s.blocksBehind,
      consecutiveFailures: s.consecutiveFailures,
    }]));
    const healthy = !shuttingDown && stalled.size === 0;
    return {
      healthy,
      body: { status: shuttingDown ? "shutting-down" : healthy ? "ok" : "stalled", adapters, warnings: this.warnings },
    };
  }

  renderMetrics(): string {
    const metrics = [
      this.startTime, this.lastTick, this.lastCaughtUp, this.behind, this.tickFailures,
      this.settleAttempts, this.relayerBalance, this.vendingReserve, this.externalPaid,
    ];
    return `${metrics.map((m) => m.render()).join("\n")}\n`;
  }

  private state(adapter: string): AdapterState {
    let state = this.adapters.get(adapter);
    if (!state) {
      this.registerAdapter(adapter);
      state = this.adapters.get(adapter)!;
    }
    return state;
  }
}

export async function startHttpServer(telemetry: Telemetry, shutdown: Shutdown, host: string, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const path = req.url?.split("?")[0];
    if (req.method !== "GET") {
      res.writeHead(405).end();
    } else if (path === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" }).end(telemetry.renderMetrics());
    } else if (path === "/health") {
      const { healthy, body } = telemetry.health(shutdown.requested);
      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" }).end(JSON.stringify(body, null, 2));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
