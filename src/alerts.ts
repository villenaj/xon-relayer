// Operator alerts: always logged, and also POSTed to ALERT_WEBHOOK_URL if set. The payload carries
// the message as both `text` (Slack, Mattermost, Google Chat) and `content` (Discord), so most
// chat webhooks work as-is. Callers only send on state changes (went low / recovered, etc.), not
// on every check, so this never needs its own rate limiting.

import { hostname } from "node:os";
import { describeError } from "./errorClassifier.js";

const WEBHOOK_TIMEOUT_MS = 10_000;

export interface Alerts {
  send(message: string): void;
}

export function makeAlerts(webhookUrl: string | null): Alerts {
  return {
    send(message) {
      console.warn(`[alert] ${message}`);
      if (!webhookUrl) return;

      // Fire-and-forget: a slow or broken webhook must never hold up settling.
      const text = `[xon-relayer@${hostname()}] ${message}`;
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, content: text }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      })
        .then((res) => {
          if (!res.ok) console.error(`[alert] Webhook returned HTTP ${res.status}.`);
        })
        .catch((err: unknown) => console.error("[alert] Webhook failed:", describeError(err)));
    },
  };
}
