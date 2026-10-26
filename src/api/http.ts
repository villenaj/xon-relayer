// Minimal HTTP plumbing for the front-end API, on plain node:http like telemetry.ts: a route
// table, JSON in and out (bigints as decimal strings), CORS, and Server-Sent Events for the
// streaming endpoints (a browser `EventSource` reads them natively, and they pass through ordinary
// reverse proxies, unlike WebSockets which would also need a dependency).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Request {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  raw: IncomingMessage;
  res: ServerResponse;
}

/// A handler returns the JSON body to send, or undefined once it has taken over the response
/// itself (a stream).
export type Handler = (req: Request) => Promise<unknown>;

export interface Route {
  method: "GET" | "POST";
  /// e.g. "/api/tx/:network/:hash"
  path: string;
  handler: Handler;
}

const MAX_BODY_BYTES = 64 * 1024;
const HEARTBEAT_MS = 15_000;

export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

function compile(path: string): { regex: RegExp; names: string[] } {
  const names: string[] = [];
  const pattern = path.split("/").map((part) => {
    if (!part.startsWith(":")) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    names.push(part.slice(1));
    return "([^/]+)";
  }).join("/");
  return { regex: new RegExp(`^${pattern}/?$`), names };
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method !== "POST") return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, "BodyTooLarge", `Request body is over ${MAX_BODY_BYTES} bytes.`);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "InvalidJson", "Request body isn't valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ApiError(400, "InvalidJson", "Request body must be a JSON object.");
  return body as Record<string, unknown>;
}

/// The Access-Control-Allow-Origin to send back for this request's Origin, or null for none.
export function allowedOrigin(origin: string | undefined, allowed: string[]): string | null {
  if (!origin) return null;
  if (allowed.includes("*")) return "*";
  return allowed.includes(origin) ? origin : null;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(toJson(body));
}

export function makeHandler(routes: Route[], corsOrigins: string[]) {
  const compiled = routes.map((route) => ({ ...route, ...compile(route.path) }));

  return async (raw: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = allowedOrigin(raw.headers.origin, corsOrigins);
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (raw.method === "OPTIONS") {
      if (origin) {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Max-Age", "600");
      }
      res.writeHead(204).end();
      return;
    }

    try {
      const url = new URL(raw.url ?? "/", "http://localhost");
      let pathMatched = false;
      for (const route of compiled) {
        const match = route.regex.exec(url.pathname);
        if (!match) continue;
        pathMatched = true;
        if (route.method !== raw.method) continue;
        let params: Record<string, string>;
        try {
          params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
        } catch {
          throw new ApiError(400, "InvalidPath", "Malformed URL encoding in the path.");
        }
        const body = await readBody(raw);
        const result = await route.handler({ params, query: url.searchParams, body, raw, res });
        if (result !== undefined) sendJson(res, 200, result);
        return;
      }
      throw pathMatched ? new ApiError(405, "MethodNotAllowed", `${raw.method} isn't supported here.`) : new ApiError(404, "NotFound", `No such endpoint: ${url.pathname}`);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof ApiError) {
        sendJson(res, err.status, { error: err.code, message: err.message });
      } else {
        // Don't hand RPC internals to the browser - log them and say what failed.
        console.error(`[api] ${raw.method} ${raw.url} failed:`, err);
        sendJson(res, 502, { error: "UpstreamError", message: "A chain RPC call failed - try again shortly." });
      }
    }
  };
}

export async function listen(handler: ReturnType<typeof makeHandler>, host: string, port: number): Promise<Server> {
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

export interface EventStream {
  send(event: string, data: unknown): void;
  close(): void;
  readonly closed: boolean;
  /// Resolves after `ms`, or as soon as the stream closes (client gone, or shutdown).
  sleep(ms: number): Promise<void>;
}

/// Caps how many event streams are open at once - each one costs RPC polling.
export class StreamRegistry {
  private readonly open = new Set<EventStream>();

  constructor(private readonly max: number) {}

  get size(): number {
    return this.open.size;
  }

  /// Switches the response to an SSE stream. Throws (before anything is sent) when at the cap.
  start(res: ServerResponse): EventStream {
    if (this.open.size >= this.max) throw new ApiError(503, "TooManyStreams", "Too many open event streams - try again shortly.");
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx buffers proxied responses by default, which would hold events back.
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    const wakers = new Set<() => void>();
    let closed = false;
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    const stream: EventStream = {
      send(event, data) {
        if (!closed) res.write(`event: ${event}\ndata: ${toJson(data)}\n\n`);
      },
      close: () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        this.open.delete(stream);
        for (const wake of wakers) wake();
        res.end();
      },
      get closed() {
        return closed;
      },
      sleep(ms) {
        if (closed) return Promise.resolve();
        return new Promise((resolve) => {
          const timer = setTimeout(done, ms);
          function done() {
            clearTimeout(timer);
            wakers.delete(done);
            resolve();
          }
          wakers.add(done);
        });
      },
    };
    res.on("close", () => stream.close());
    this.open.add(stream);
    return stream;
  }

  closeAll(): void {
    for (const stream of [...this.open]) stream.close();
  }
}
