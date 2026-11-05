import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { unixBrokerFetch } from "./trinalum-broker-transport";

it("reaches the host via a Unix socket and preserves the exact request and status", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trinalum-unix-"));
  const socket = path.join(directory, "broker.sock");
  const server = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ path: req.url, body, auth: req.headers.authorization }));
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    const response = await unixBrokerFetch(socket, new URL("http://127.0.0.1/read"), { method: "POST", headers: { Authorization: "Bearer private-test-token" }, body: '{"operation":"attio_tasks"}' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ path: "/read", body: '{"operation":"attio_tasks"}', auth: "Bearer private-test-token" });
    const controller = new AbortController(); controller.abort();
    await expect(unixBrokerFetch(socket, new URL("http://127.0.0.1/read"), { signal: controller.signal })).rejects.toThrow("CONNECTOR_ABORTED");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

it("preserves raw binary bytes over the existing Unix transport with the bounded audio timeout", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trinalum-audio-wire-"));
  const socket = path.join(directory, "broker.sock");
  const bytes = new Uint8Array([0, 255, 128, 34, 10, 65]);
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    res.end(JSON.stringify({ path: req.url, hex: Buffer.concat(chunks).toString("hex"), length: req.headers["content-length"] }));
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    const response = await unixBrokerFetch(socket, new URL("http://127.0.0.1/audio-transcribe"), {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) }, body: bytes,
    }, { timeoutMs: 325_000 });
    expect(await response.json()).toEqual({ path: "/audio-transcribe", hex: Buffer.from(bytes).toString("hex"), length: String(bytes.length) });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
