import { request, type ClientRequest } from "node:http";

/** Safe transport failures never expose socket paths or provider credentials. */
export class ConnectorTransportError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "ConnectorTransportError";
  }
}
type WaitingRequest = { start: () => void };
type EndpointQueue = { active: number; pending: WaitingRequest[] };
const endpoints = new Map<string, EndpointQueue>();
const failure = (code: string, status: number) => new ConnectorTransportError(code, status);
function pump(socketPath: string, endpoint: EndpointQueue) {
  while (endpoint.active < 2 && endpoint.pending.length) {
    const next = endpoint.pending.shift()!;
    endpoint.active++;
    next.start();
  }
  if (!endpoint.active && !endpoint.pending.length) endpoints.delete(socketPath);
}

/** Per exact source socket: two active exchanges and at most eight active/pending.
 * One deadline covers waiting and wire time. A dispatched request is never replayed.
 */
export function unixBrokerFetch(socketPath: string, url: URL, init: RequestInit, options: { timeoutMs?: number; maximumBytes?: number } = {}): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 50_000;
  const maximumBytes = options.maximumBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 330_000) return Promise.reject(failure("CONNECTOR_TIMEOUT_INVALID", 400));
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 48 * 1024 * 1024) return Promise.reject(failure("CONNECTOR_SIZE_INVALID", 400));
  if (init.signal?.aborted) return Promise.reject(failure("CONNECTOR_ABORTED", 499));
  const endpoint = endpoints.get(socketPath) ?? { active: 0, pending: [] };
  if (endpoint.active + endpoint.pending.length >= 8) return Promise.reject(failure("CONNECTOR_BUSY", 429));
  endpoints.set(socketPath, endpoint);
  return new Promise((resolve, reject) => {
    let req: ClientRequest | undefined;
    let settled = false;
    let started = false;
    let released = false;
    const release = () => {
      if (released || !started) return;
      released = true;
      endpoint.active--;
      pump(socketPath, endpoint);
    };
    const finish = (error?: ConnectorTransportError, response?: Response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", abort);
      if (!started) {
        const index = endpoint.pending.indexOf(waiting);
        if (index !== -1) endpoint.pending.splice(index, 1);
        pump(socketPath, endpoint);
      }
      if (error) {
        req?.destroy(error);
        reject(error);
      } else resolve(response!);
    };
    const abort = () => finish(failure("CONNECTOR_ABORTED", 499));
    const timer = setTimeout(() => finish(failure("CONNECTOR_TIMEOUT", 504)), timeoutMs);
    const waiting: WaitingRequest = { start: () => {
      started = true;
      try {
        req = request({ socketPath, path: url.pathname, method: init.method ?? "POST", headers: init.headers as Record<string, string>, agent: false }, res => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", chunk => {
            bytes += chunk.length;
            if (bytes > maximumBytes) { finish(failure("CONNECTOR_RESULT_TOO_LARGE", 413)); return; }
            chunks.push(chunk);
          });
          res.on("end", () => {
            if (!res.complete) { finish(failure("CONNECTOR_UNAVAILABLE", 503)); return; }
            try {
              finish(undefined, new Response(Buffer.concat(chunks), { status: res.statusCode ?? 502, headers: { "Content-Type": "application/json" } }));
            } catch { finish(failure("CONNECTOR_UNAVAILABLE", 503)); }
          });
          res.on("aborted", () => finish(failure("CONNECTOR_UNAVAILABLE", 503)));
          res.on("error", () => finish(failure("CONNECTOR_UNAVAILABLE", 503)));
          res.on("close", () => { if (!res.complete) finish(failure("CONNECTOR_UNAVAILABLE", 503)); });
        });
        req.on("error", error => finish(error instanceof ConnectorTransportError ? error : failure("CONNECTOR_UNAVAILABLE", 503)));
        req.on("close", () => {
          if (!settled) finish(failure("CONNECTOR_UNAVAILABLE", 503));
          release();
        });
        req.end(init.body);
      } catch {
        finish(failure("CONNECTOR_UNAVAILABLE", 503));
        if (!req) release();
      }
    } };
    endpoint.pending.push(waiting);
    init.signal?.addEventListener("abort", abort, { once: true });
    if (init.signal?.aborted) abort();
    else pump(socketPath, endpoint);
  });
}
