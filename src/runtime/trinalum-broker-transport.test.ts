import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
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

async function unixFixture(handler: import("node:http").RequestListener) {
  const directory = await mkdtemp(path.join(tmpdir(), "broker-admission-"));
  const socket = path.join(directory, "broker.sock");
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(socket, resolve));
  return {
    socket, server,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const brokerUrl = new URL("http://127.0.0.1/read");

it("queues four actual Unix requests with at most two active and preserves each identity", async () => {
  let active = 0, peak = 0;
  const seen: string[] = [];
  const fixture = await unixFixture(async (req, res) => {
    active++; peak = Math.max(peak, active);
    let body = ""; for await (const part of req) body += part;
    seen.push(`${req.headers.authorization}:${body}`);
    await new Promise(resolve => setTimeout(resolve, 30));
    active--; res.end(body);
  });
  try {
    const responses = await Promise.all(Array.from({ length: 4 }, (_, i) => unixBrokerFetch(fixture.socket, brokerUrl, {
      method: "POST", headers: { Authorization: `Bearer identity-${i}` }, body: String(i),
    })));
    expect(await Promise.all(responses.map(response => response.text()))).toEqual(["0", "1", "2", "3"]);
    expect(peak).toBe(2);
    expect(seen.sort()).toEqual(Array.from({ length: 4 }, (_, i) => `Bearer identity-${i}:${i}`));
  } finally { await fixture.close(); }
});

it("removes an aborted queued request before dispatch and isolates exact source sockets", async () => {
  const replies: import("node:http").ServerResponse[] = [];
  const fixture = await unixFixture((_req, res) => { replies.push(res); });
  const other = await unixFixture((_req, res) => { res.end("other-source"); });
  const controller = new AbortController();
  try {
    const first = unixBrokerFetch(fixture.socket, brokerUrl, {});
    const second = unixBrokerFetch(fixture.socket, brokerUrl, {});
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    const queued = unixBrokerFetch(fixture.socket, brokerUrl, { signal: controller.signal });
    const rejection = expect(queued).rejects.toMatchObject({ name: "ConnectorTransportError", code: "CONNECTOR_ABORTED", status: 499 });
    controller.abort(); await rejection;
    expect(await (await unixBrokerFetch(other.socket, brokerUrl, {})).text()).toBe("other-source");
    replies.forEach(res => res.end("done"));
    await Promise.all([first, second]);
    expect(replies).toHaveLength(2);
  } finally { await fixture.close(); await other.close(); }
});

it("bounds active plus pending at eight and rejects overload without a request frame", async () => {
  let frames = 0;
  let release = false;
  const held: import("node:http").ServerResponse[] = [];
  const fixture = await unixFixture((_req, res) => {
    frames++;
    if (release) res.end("done"); else held.push(res);
  });
  try {
    const admitted = Array.from({ length: 8 }, () => unixBrokerFetch(fixture.socket, brokerUrl, {}));
    await vi.waitFor(() => expect(frames).toBe(2));
    await expect(unixBrokerFetch(fixture.socket, brokerUrl, {})).rejects.toMatchObject({ code: "CONNECTOR_BUSY", status: 429 });
    expect(frames).toBe(2);
    release = true; held.forEach(res => res.end("done"));
    await Promise.all(admitted);
    expect(frames).toBe(8);
  } finally { await fixture.close(); }
});

it("applies the deadline to queue time, removes timed out work, and recovers admission", async () => {
  let frames = 0;
  const fixture = await unixFixture((_req, res) => { frames++; if (frames > 2) res.end("recovered"); });
  const controller = new AbortController();
  try {
    const active = Array.from({ length: 2 }, () => unixBrokerFetch(fixture.socket, brokerUrl, { signal: controller.signal }).catch(error => error));
    await vi.waitFor(() => expect(frames).toBe(2));
    await expect(unixBrokerFetch(fixture.socket, brokerUrl, {}, { timeoutMs: 30 })).rejects.toMatchObject({ code: "CONNECTOR_TIMEOUT", status: 504 });
    expect(frames).toBe(2);
    controller.abort(); await Promise.all(active);
    expect(await (await unixBrokerFetch(fixture.socket, brokerUrl, {})).text()).toBe("recovered");
    expect(frames).toBe(3);
  } finally { await fixture.close(); }
});

it("uses one total deadline through both waiting and an incomplete wire response", async () => {
  let frames = 0;
  const held: import("node:http").ServerResponse[] = [];
  const fixture = await unixFixture((_req, res) => { frames++; held.push(res); });
  const controller = new AbortController();
  try {
    const blockers = Array.from({ length: 2 }, () => unixBrokerFetch(fixture.socket, brokerUrl, { signal: controller.signal }).catch(error => error));
    await vi.waitFor(() => expect(frames).toBe(2));
    const start = performance.now();
    const waiting = unixBrokerFetch(fixture.socket, brokerUrl, {}, { timeoutMs: 200 });
    const rejected = expect(waiting).rejects.toMatchObject({ code: "CONNECTOR_TIMEOUT", status: 504 });
    await new Promise(resolve => setTimeout(resolve, 130));
    held[0].end("released");
    await vi.waitFor(() => expect(frames).toBe(3));
    await rejected;
    expect(performance.now() - start).toBeLessThan(310);
    controller.abort(); await Promise.all(blockers);
  } finally { await fixture.close(); }
});

it("settles truncated responses and socket resets as unavailable without replay", async () => {
  let frames = 0;
  const fixture = await unixFixture((_req, res) => {
    frames++;
    if (frames === 1) {
      res.writeHead(200, { "Content-Length": "100" });
      res.write("partial");
      setImmediate(() => res.destroy());
    } else if (frames === 2) res.socket!.destroy();
    else res.end("recovered");
  });
  try {
    await expect(unixBrokerFetch(fixture.socket, brokerUrl, {})).rejects.toMatchObject({ code: "CONNECTOR_UNAVAILABLE", status: 503 });
    expect(frames).toBe(1);
    await expect(unixBrokerFetch(fixture.socket, brokerUrl, {})).rejects.toMatchObject({ code: "CONNECTOR_UNAVAILABLE", status: 503 });
    expect(frames).toBe(2);
    expect(await (await unixBrokerFetch(fixture.socket, brokerUrl, {})).text()).toBe("recovered");
    expect(frames).toBe(3);
  } finally { await fixture.close(); }
});
