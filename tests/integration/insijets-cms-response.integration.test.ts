import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { proxyCMS, type CMSConfiguration } from "@/insijets/cms-proxy";
import type { AuthSession } from "@/auth/types";

const session: AuthSession = {
  provider: "local", user: { id: "cms-response-fixture", name: "Fixture", email: "operator@example.invalid" },
  tenant: { id: "insijets-demo", name: "InsiJets" }, expiresAt: new Date(Date.now() + 300_000).toISOString(),
};
const configuration: CMSConfiguration = {
  installationId: "insijets-demo", enabled: true, upstreamOrigin: "https://cms.website.example",
  brainOrigin: "https://brain.example.test", signingKey: "synthetic-cms-response-key-0000000000000000",
};
const path = "/api/admin/content";
const request = (signal?: AbortSignal) => new Request(`${configuration.brainOrigin}/api/insijets/cms${path}?locale=en`, { signal });
const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
afterEach(() => vi.unstubAllGlobals());

it("returns a byte-exact complete7197-record catalogue over real HTTP after the old20s deadline", async () => {
  const body = Buffer.from(JSON.stringify({
    records: Array.from({ length: 7197 }, (_, index) => ({ id: `synthetic-${index}`, locale: "en", description: "α".repeat(3000) })),
    trailer: "catalogue-complete",
  }));
  expect(body.byteLength).toBeGreaterThan(42_968_466);
  let verifiedAssertion = false;
  let delayedTail: ReturnType<typeof setTimeout> | undefined;
  const server = createServer(async (req, res) => {
    const assertion = String(req.headers["x-insijets-cms-assertion"]);
    verifiedAssertion = req.url === "/brain-cms/api/admin/content?locale=en" && req.method === "GET" &&
      req.headers["x-insijets-cms-signature"] === createHmac("sha256", configuration.signingKey).update(assertion).digest("hex") &&
      JSON.parse(Buffer.from(assertion, "base64url").toString()).tenant === "insijets-demo";
    res.writeHead(200, { ...jsonHeaders, "content-length": body.byteLength });
    for (let offset = 0; offset < body.byteLength - 128; offset += 65_536) {
      if (!res.write(body.subarray(offset, Math.min(offset + 65_536, body.byteLength - 128)))) await once(res, "drain");
    }
    delayedTail = setTimeout(() => res.end(body.subarray(body.byteLength - 128)), 21_000);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("fixture did not bind");
  const started = Date.now();
  try {
    const result = await proxyCMS(request(), { ...configuration, upstreamOrigin: `http://127.0.0.1:${address.port}`, allowLoopback: true }, session, path);
    expect(result.status).toBe(200);
    const received = Buffer.from(await result.arrayBuffer());
    expect(Date.now() - started).toBeGreaterThan(20_000);
    expect(verifiedAssertion).toBe(true);
    expect(received.byteLength).toBe(body.byteLength);
    expect(createHash("sha256").update(received).digest("hex")).toBe(createHash("sha256").update(body).digest("hex"));
    const catalogue = JSON.parse(received.toString());
    expect(catalogue.records).toHaveLength(7197);
    expect(catalogue.records.at(-1).id).toBe("synthetic-7196");
    expect(catalogue.trailer).toBe("catalogue-complete");
  } finally {
    clearTimeout(delayedTail); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 30_000);

it("turns a body failure after headers into a complete JSON502 before exposing200", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"records":['));
    queueMicrotask(() => controller.error(new Error("synthetic upstream disconnect")));
  } }), { headers: jsonHeaders })));
  const result = await proxyCMS(request(), configuration, session, path);
  expect(result.status).toBe(502);
  expect(await result.json()).toEqual({ error: "CMS_UNAVAILABLE" });
});

it("rejects clean EOF with incomplete JSON", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"records":[{"id":"truncated', { headers: jsonHeaders })));
  const result = await proxyCMS(request(), configuration, session, path);
  expect(result.status).toBe(502);
  expect(await result.json()).toEqual({ error: "CMS_RESPONSE_INVALID" });
});

it("cancels an advertised over64MiB catalogue before reading it", async () => {
  const cancel = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), {
    headers: { ...jsonHeaders, "content-length": String(64 * 1024 * 1024 + 1) },
  })));
  const result = await proxyCMS(request(), configuration, session, path);
  expect(result.status).toBe(502);
  expect(await result.json()).toEqual({ error: "CMS_RESPONSE_TOO_LARGE" });
  expect(cancel).toHaveBeenCalledOnce();
});

it("bounds a chunked catalogue without Content-Length to64MiB", async () => {
  const cancel = vi.fn(); const chunk = new Uint8Array(1024 * 1024);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(chunk); }, cancel,
  }), { headers: jsonHeaders })));
  const result = await proxyCMS(request(), configuration, session, path);
  expect(result.status).toBe(502);
  expect(await result.json()).toEqual({ error: "CMS_RESPONSE_TOO_LARGE" });
  expect(cancel).toHaveBeenCalledOnce();
});

it("propagates caller cancellation to the upstream catalogue read", async () => {
  const caller = new AbortController(); let upstreamSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
    upstreamSignal = options.signal;
    return new Response(new ReadableStream({ start(controller) {
      upstreamSignal?.addEventListener("abort", () => controller.error(upstreamSignal?.reason), { once: true });
      queueMicrotask(() => caller.abort());
    } }), { headers: jsonHeaders });
  }));
  const result = await proxyCMS(request(caller.signal), configuration, session, path);
  expect(upstreamSignal?.aborted).toBe(true);
  expect(result.status).toBe(502);
  expect(await result.json()).toEqual({ error: "CMS_UNAVAILABLE" });
});

it("keeps a finite90s catalogue deadline with a complete504 on timeout", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort(new DOMException("synthetic deadline", "TimeoutError")));
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => { throw options.signal.reason; }));
  try {
    const result = await proxyCMS(request(), configuration, session, path);
    expect(timeout).toHaveBeenCalledWith(90_000);
    expect(result.status).toBe(504);
    expect(await result.json()).toEqual({ error: "CMS_RESPONSE_TIMEOUT" });
  } finally { timeout.mockRestore(); }
});

it("keeps the old20s deadline and streaming for other CMS routes", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("synthetic-asset", { headers: { "content-type": "image/png" } })));
  try {
    const result = await proxyCMS(new Request(`${configuration.brainOrigin}/api/insijets/cms/assets/fixture.png`), configuration, session, "/assets/fixture.png");
    expect(timeout).toHaveBeenCalledWith(20_000); expect(result.status).toBe(200);
    expect(await result.text()).toBe("synthetic-asset");
  } finally { timeout.mockRestore(); }
});
