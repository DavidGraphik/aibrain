import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect as netConnect, createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EgressGateway,
  EgressGatewayError,
  configFromEnvironment,
  isHealthProbeAuthorized,
  type EgressGatewayConfig,
  type GatewayConnection,
} from "../../infra/hetzner/egress/gateway.mjs";

const BROWSER_TOKEN = "browser-token-0000000000000000000000000000";
const WORKER_TOKEN = "worker-token-00000000000000000000000000000";
const SERVER_TOKEN = "server-token-00000000000000000000000000000";
const HEALTH_TOKEN = "health-token-00000000000000000000000000000";

function config(overrides: Partial<EgressGatewayConfig> = {}): EgressGatewayConfig {
  return {
    listenHost: "0.0.0.0",
    port: 0,
    browserToken: BROWSER_TOKEN,
    workerToken: WORKER_TOKEN,
    serverToken: SERVER_TOKEN,
    healthToken: HEALTH_TOKEN,
    workerHosts: new Set(["api.openai.com"]),
    supabaseHostname: "project-ref.supabase.co",
    maxHeaderBytes: 8_192,
    maxConnections: 16,
    maxAddresses: 4,
    connectTimeoutMs: 2_000,
    idleTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    maxBytesPerExchange: 1024 * 1024,
    ...overrides,
  };
}

function bearer(token: string) {
  return `Bearer ${token}`;
}

function basic(token: string, username = "aibrain") {
  return `Basic ${Buffer.from(`${username}:${token}`, "utf8").toString("base64")}`;
}

function localUrl(url: string) {
  return url.replace("0.0.0.0", "127.0.0.1");
}

async function listen(server: NetServer | ReturnType<typeof createHttpServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind TCP");
  return address.port;
}

async function close(server: NetServer | ReturnType<typeof createHttpServer>) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function localConnector(port: number, observed: GatewayConnection[]) {
  return async (target: GatewayConnection) => {
    observed.push(target);
    return await new Promise<Socket>((resolve, reject) => {
      const socket = netConnect({ host: "127.0.0.1", port });
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
  };
}

async function proxyHttp(proxyUrl: string, target: string, headers: Record<string, string>) {
  const proxy = new URL(localUrl(proxyUrl));
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest({
      host: proxy.hostname,
      port: proxy.port,
      method: "GET",
      path: target,
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end();
  });
}

async function connectExchange(proxyUrl: string, authority: string, authorization: string, pin?: string) {
  const proxy = new URL(localUrl(proxyUrl));
  return await new Promise<{ status: number; echoed: string }>((resolve, reject) => {
    const socket = netConnect({ host: proxy.hostname, port: Number(proxy.port) });
    let response = Buffer.alloc(0);
    let established = false;
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("CONNECT exchange timed out"));
    }, 3_000);
    socket.once("connect", () => {
      socket.write([
        `CONNECT ${authority} HTTP/1.1`,
        `Host: ${authority}`,
        `Proxy-Authorization: ${authorization}`,
        ...(pin ? [`X-AiBrain-Pinned-IP: ${pin}`] : []),
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, Buffer.from(chunk)]);
      if (!established) {
        const boundary = response.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        const status = Number(response.subarray(0, boundary).toString("ascii").split(" ")[1]);
        response = response.subarray(boundary + 4);
        if (status !== 200) {
          clearTimeout(timeout);
          socket.destroy();
          resolve({ status, echoed: "" });
          return;
        }
        established = true;
        socket.write("synthetic-payload");
      }
      if (established && response.toString("utf8").includes("synthetic-payload")) {
        clearTimeout(timeout);
        socket.destroy();
        resolve({ status: 200, echoed: response.toString("utf8") });
      }
    });
    socket.once("error", reject);
  });
}

const gateways: EgressGateway[] = [];
const servers: Array<NetServer | ReturnType<typeof createHttpServer>> = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  await Promise.all(servers.splice(0).map((server) => close(server)));
  vi.unstubAllEnvs();
});

describe("physical egress gateway", () => {
  it("forwards browser HTTP only to its approved global pin and strips control credentials", async () => {
    let receivedHeaders: IncomingHttpHeaders = {};
    const upstream = createHttpServer((request, response) => {
      receivedHeaders = request.headers;
      response.end("synthetic-ok");
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const observed: GatewayConnection[] = [];
    const lookup = vi.fn(async () => { throw new Error("browser channel must not resolve DNS twice"); });
    const gateway = new EgressGateway({ config: config(), lookup, connect: localConnector(upstreamPort, observed) });
    gateways.push(gateway);
    const proxyUrl = await gateway.start();

    const result = await proxyHttp(proxyUrl, "http://browser.example/document?q=1", {
      "proxy-authorization": bearer(BROWSER_TOKEN),
      "x-aibrain-pinned-ip": "8.8.8.8",
    });

    expect(result).toEqual({ status: 200, body: "synthetic-ok" });
    expect(lookup).not.toHaveBeenCalled();
    expect(observed).toMatchObject([{ address: "8.8.8.8", family: 4, port: 80, hostname: "browser.example", channel: "browser" }]);
    expect(receivedHeaders["proxy-authorization"]).toBeUndefined();
    expect(receivedHeaders["x-aibrain-pinned-ip"]).toBeUndefined();
    expect(receivedHeaders.host).toBe("browser.example");
  });

  it("resolves browser DNS only through the authenticated isolated gateway", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 as const },
    ]);
    const gateway = new EgressGateway({ config: config(), lookup });
    gateways.push(gateway);
    const proxyUrl = await gateway.start();

    const resolved = await proxyHttp(
      proxyUrl,
      "/__aibrain_egress_resolve?hostname=browser.example",
      { "proxy-authorization": bearer(BROWSER_TOKEN) },
    );

    expect(resolved.status).toBe(200);
    expect(JSON.parse(resolved.body)).toEqual({
      schemaVersion: 1,
      hostname: "browser.example",
      addresses: [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ],
    });
    expect(lookup).toHaveBeenCalledWith("browser.example", { all: true, verbatim: true });
    expect((await proxyHttp(
      proxyUrl,
      "/__aibrain_egress_resolve?hostname=browser.example",
      { "proxy-authorization": bearer(WORKER_TOKEN) },
    )).status).toBe(403);
    expect((await proxyHttp(proxyUrl, "/__aibrain_egress_resolve?hostname=localhost", {
      "proxy-authorization": bearer(BROWSER_TOKEN),
    })).status).toBe(403);
  });

  it("accepts standard Basic proxy auth only for worker/server and pins one worker DNS decision", async () => {
    const echo = createNetServer((socket) => socket.pipe(socket));
    servers.push(echo);
    const echoPort = await listen(echo);
    const observed: GatewayConnection[] = [];
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    const gateway = new EgressGateway({ config: config(), lookup, connect: localConnector(echoPort, observed) });
    gateways.push(gateway);
    const proxyUrl = await gateway.start();

    const result = await connectExchange(proxyUrl, "api.openai.com:443", basic(WORKER_TOKEN));

    expect(result.status).toBe(200);
    expect(result.echoed).toContain("synthetic-payload");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("api.openai.com", { all: true, verbatim: true });
    expect(observed).toMatchObject([{ address: "93.184.216.34", port: 443, hostname: "api.openai.com", channel: "worker" }]);

    expect((await connectExchange(proxyUrl, "browser.example:443", basic(BROWSER_TOKEN), "8.8.8.8")).status).toBe(407);
    expect((await connectExchange(proxyUrl, "api.openai.com:443", basic(WORKER_TOKEN, "worker"))).status).toBe(407);
  });

  it("allows an installation connector only on the server channel and rejects other stores", async () => {
    const echo = createNetServer(socket => socket.pipe(socket)); servers.push(echo);
    const echoPort = await listen(echo);
    const observed: GatewayConnection[] = [];
    const gateway = new EgressGateway({ config: config({ serverConnectorHosts: new Set(["c7f82c-f0.myshopify.com"]) }), lookup: async () => [{ address: "93.184.216.34", family: 4 }], connect: localConnector(echoPort, observed) });
    gateways.push(gateway); const proxy = await gateway.start();
    expect((await connectExchange(proxy, "c7f82c-f0.myshopify.com:443", basic(SERVER_TOKEN))).status).toBe(200);
    for (const [target, token] of [["c7f82c-f0.myshopify.com:443", WORKER_TOKEN], ["foreign.myshopify.com:443", SERVER_TOKEN], ["c7f82c-f0.myshopify.com:80", SERVER_TOKEN]]) expect((await connectExchange(proxy, target, basic(token))).status).toBe(403);
    expect(observed).toHaveLength(1);
    const unchanged = new EgressGateway({ config: config(), lookup: async () => [{ address: "93.184.216.34", family: 4 }], connect: localConnector(echoPort, observed) }); gateways.push(unchanged);
    expect((await connectExchange(await unchanged.start(), "c7f82c-f0.myshopify.com:443", basic(SERVER_TOKEN))).status).toBe(403);
  });
  it.each(["*.myshopify.com", "127.0.0.1", "localhost", "shop.myshopify.com:443", "SHOP.myshopify.com", "shop.myshopify.com/"])("rejects unsafe connector host %s", host => {
    expect(() => new EgressGateway({ config: config({ serverConnectorHosts: new Set([host]) }) })).toThrow(EgressGatewayError);
  });

  it("permits only opt-in exact Nominalia TLS targets for the server, never workers", async () => {
    const echo = createNetServer(socket => socket.pipe(socket)); servers.push(echo);
    const echoPort = await listen(echo);
    const observed: GatewayConnection[] = [];
    const gateway = new EgressGateway({ config: config({ serverMailTargets: new Set(["pop.securemail.pro:993", "authsmtp.securemail.pro:587"]) }), lookup: async () => [{ address: "93.184.216.34", family: 4 }], connect: localConnector(echoPort, observed) });
    gateways.push(gateway); const proxy = await gateway.start();
    for (const target of ["pop.securemail.pro:993", "authsmtp.securemail.pro:587"]) {
      expect((await connectExchange(proxy, target, basic(SERVER_TOKEN))).status).toBe(200);
      expect((await connectExchange(proxy, target, basic(WORKER_TOKEN))).status).toBe(403);
    }
    for (const target of ["pop.securemail.pro:465", "authsmtp.securemail.pro:993", "pop.securemail.pro:443", "foreign.example:993"]) {
      expect((await connectExchange(proxy, target, basic(SERVER_TOKEN))).status).toBe(403);
    }
    expect(observed).toHaveLength(2);
    const disabled = new EgressGateway({ config: config(), lookup: async () => [{ address: "93.184.216.34", family: 4 }], connect: localConnector(echoPort, observed) }); gateways.push(disabled);
    expect((await connectExchange(await disabled.start(), "pop.securemail.pro:993", basic(SERVER_TOKEN))).status).toBe(403);
  });

  it.each(["*.securemail.pro:993", "127.0.0.1:993", "pop.securemail.pro:143", "foreign.example:465"])("rejects unreviewed mail target %s", target => {
    expect(() => new EgressGateway({ config: config({ serverMailTargets: new Set([target]) }) })).toThrow(EgressGatewayError);
  });

  it("rejects private, metadata and mixed DNS answers before opening a socket", async () => {
    const connector = vi.fn(async () => { throw new Error("must not connect"); });
    const gateway = new EgressGateway({
      config: config(),
      lookup: vi.fn(async () => [
        { address: "93.184.216.34", family: 4 as const },
        { address: "10.0.0.8", family: 4 as const },
      ]),
      connect: connector,
    });
    gateways.push(gateway);
    const proxyUrl = await gateway.start();

    expect((await connectExchange(proxyUrl, "api.openai.com:443", basic(WORKER_TOKEN))).status).toBe(403);
    expect((await connectExchange(proxyUrl, "metadata.google.internal:443", bearer(BROWSER_TOKEN), "8.8.8.8")).status).toBe(403);
    expect((await connectExchange(proxyUrl, "browser.example:443", bearer(BROWSER_TOKEN), "169.254.169.254")).status).toBe(403);
    expect(connector).not.toHaveBeenCalled();
  });

  it("keeps channel allowlists separate and limits ports", async () => {
    const connector = vi.fn(async () => { throw new Error("must not connect"); });
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    const gateway = new EgressGateway({ config: config(), lookup, connect: connector });
    gateways.push(gateway);
    const proxyUrl = await gateway.start();

    expect((await connectExchange(proxyUrl, "project-ref.supabase.co:443", basic(WORKER_TOKEN))).status).toBe(403);
    expect((await connectExchange(proxyUrl, "api.openai.com:443", basic(SERVER_TOKEN))).status).toBe(403);
    expect((await connectExchange(proxyUrl, "backend.composio.dev.evil.example:443", basic(SERVER_TOKEN))).status).toBe(403);
    expect((await connectExchange(proxyUrl, "backend.composio.dev:80", basic(SERVER_TOKEN))).status).toBe(403);
    expect((await connectExchange(proxyUrl, "backend.composio.dev:443", basic(WORKER_TOKEN))).status).toBe(403);
    expect((await connectExchange(proxyUrl, "api.instantly.ai.evil.example:443", basic(SERVER_TOKEN))).status).toBe(403);
    expect((await connectExchange(proxyUrl, "api.instantly.ai:80", basic(SERVER_TOKEN))).status).toBe(403);
    expect((await connectExchange(proxyUrl, "api.instantly.ai:443", basic(WORKER_TOKEN))).status).toBe(403);
    expect((await connectExchange(proxyUrl, "project-ref.supabase.co:80", basic(SERVER_TOKEN))).status).toBe(403);
    expect((await connectExchange(proxyUrl, "browser.example:8443", bearer(BROWSER_TOKEN), "8.8.8.8")).status).toBe(403);
    expect(lookup).not.toHaveBeenCalled();
    expect(connector).not.toHaveBeenCalled();
  });

  it("allows configured Supabase and exact connector APIs on the server channel", async () => {
    const echo = createNetServer((socket) => socket.pipe(socket));
    servers.push(echo);
    const echoPort = await listen(echo);
    const observed: GatewayConnection[] = [];
    const lookup = vi.fn(async () => [{ address: "104.18.38.10", family: 4 as const }]);
    const gateway = new EgressGateway({ config: config(), lookup, connect: localConnector(echoPort, observed) });
    gateways.push(gateway);
    const proxyUrl = await gateway.start();

    expect((await connectExchange(proxyUrl, "project-ref.supabase.co:443", basic(SERVER_TOKEN))).status).toBe(200);
    expect(observed).toMatchObject([{ hostname: "project-ref.supabase.co", address: "104.18.38.10", port: 443, channel: "server" }]);
    expect((await connectExchange(proxyUrl, "backend.composio.dev:443", basic(SERVER_TOKEN))).status).toBe(200);
    expect(observed[1]).toMatchObject({ hostname: "backend.composio.dev", address: "104.18.38.10", port: 443, channel: "server" });
    expect((await connectExchange(proxyUrl, "api.instantly.ai:443", basic(SERVER_TOKEN))).status).toBe(200);
    expect(observed[2]).toMatchObject({ hostname: "api.instantly.ai", address: "104.18.38.10", port: 443, channel: "server" });
  });

  it("permits only opted-in exact IMAPS hosts on the server channel, rejects worker access and private DNS", async () => {
    const echo = createNetServer(socket => socket.pipe(socket)); servers.push(echo);
    const port = await listen(echo);
    const observed: GatewayConnection[] = [];
    const lookup = vi.fn(async () => [{ address: "104.18.38.10", family: 4 as const }]);
    const gateway = new EgressGateway({ config: config({ mailHosts: new Set(["hc65.infoselfcloud.com"]) }), lookup, connect: localConnector(port, observed) });
    gateways.push(gateway); const url = await gateway.start();
    expect((await connectExchange(url, "hc65.infoselfcloud.com:993", basic(SERVER_TOKEN))).status).toBe(200);
    expect(observed[0]).toMatchObject({ hostname: "hc65.infoselfcloud.com", port: 993, channel: "server" });
    expect((await connectExchange(url, "hc65.infoselfcloud.com:993", basic(WORKER_TOKEN))).status).toBe(403);
    expect((await connectExchange(url, "other.infoselfcloud.com:993", basic(SERVER_TOKEN))).status).toBe(403);
    expect((await connectExchange(url, "hc65.infoselfcloud.com:443", basic(SERVER_TOKEN))).status).toBe(403);
    expect((await connectExchange(url, "hc65.infoselfcloud.com:143", basic(SERVER_TOKEN))).status).toBe(403);
    lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    expect((await connectExchange(url, "hc65.infoselfcloud.com:993", basic(SERVER_TOKEN))).status).toBe(403);
    expect(observed).toHaveLength(1);
    expect(() => new EgressGateway({ config: config({ mailHosts: new Set(["*.infoselfcloud.com"]) }) })).toThrow();
  });

  it("has idempotent lifecycle, loopback health and fail-closed secret validation", async () => {
    expect(() => new EgressGateway({ config: config({ serverToken: WORKER_TOKEN }) })).toThrowError(EgressGatewayError);
    expect(() => new EgressGateway({ config: config({ healthToken: SERVER_TOKEN }) })).toThrowError(EgressGatewayError);
    expect(() => new EgressGateway({ config: config({ workerHosts: new Set(["localhost"]) }) })).toThrowError(EgressGatewayError);

    const gateway = new EgressGateway({ config: config() });
    gateways.push(gateway);
    const [first, concurrent] = await Promise.all([gateway.start(), gateway.start()]);
    expect(concurrent).toBe(first);
    expect(await gateway.start()).toBe(first);
    expect(gateway.health().healthy).toBe(true);
    expect((await proxyHttp(first, "http://unused.invalid", {})).status).toBe(407);

    const health = await proxyHttp(first, "/__aibrain_egress_health", {});
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ healthy: true });
    await gateway.stop();
    await gateway.stop();
    expect(gateway.health().healthy).toBe(false);
  });

  it("requires the dedicated secret for a non-loopback health probe", () => {
    expect(isHealthProbeAuthorized("172.20.0.4", undefined, HEALTH_TOKEN)).toBe(false);
    expect(isHealthProbeAuthorized("172.20.0.4", bearer(WORKER_TOKEN), HEALTH_TOKEN)).toBe(false);
    expect(isHealthProbeAuthorized("172.20.0.4", bearer(HEALTH_TOKEN), HEALTH_TOKEN)).toBe(true);
    expect(isHealthProbeAuthorized("127.0.0.1", undefined, HEALTH_TOKEN)).toBe(true);
  });

  it("allows the opted-in exact InsiJets CMS host only on server HTTPS with one pinned DNS decision", async () => {
    const echo = createNetServer(socket => socket.pipe(socket));
    servers.push(echo);
    const port = await listen(echo);
    const observed: GatewayConnection[] = [];
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    const gateway = new EgressGateway({
      config: config({ installationId: "insijets-demo", insijetsCmsOrigin: "https://CMS.website.example.:443/" }),
      lookup,
      connect: localConnector(port, observed),
    });
    gateways.push(gateway);
    const url = await gateway.start();

    expect((await connectExchange(url, "cms.website.example:443", basic(SERVER_TOKEN))).status).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("cms.website.example", { all: true, verbatim: true });
    expect(observed).toMatchObject([{ hostname: "cms.website.example", address: "93.184.216.34", family: 4, port: 443, channel: "server" }]);

    lookup.mockClear();
    for (const authority of ["cms.website.example.evil.example:443", "other.website.example:443", "cms.website.example:80", "cms.website.example:8443", "93.184.216.34:443"]) {
      expect((await connectExchange(url, authority, basic(SERVER_TOKEN))).status).toBe(403);
    }
    expect((await connectExchange(url, "cms.website.example:443", basic(WORKER_TOKEN))).status).toBe(403);
    // The CMS opt-in grants no browser exception to its existing pin/auth checks.
    expect((await connectExchange(url, "cms.website.example:443", bearer(BROWSER_TOKEN))).status).toBe(403);
    expect((await connectExchange(url, "cms.website.example:443", bearer(BROWSER_TOKEN), "127.0.0.1")).status).toBe(403);
    expect((await connectExchange(url, "cms.website.example:443", basic(BROWSER_TOKEN), "8.8.8.8")).status).toBe(407);
    expect(lookup).not.toHaveBeenCalled();
    expect(observed).toHaveLength(1);
  });

  it("keeps CMS server egress disabled by default even for InsiJets", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    const connector = vi.fn(async () => { throw new Error("must not connect"); });
    const gateway = new EgressGateway({ config: config({ installationId: "insijets-demo" }), lookup, connect: connector });
    gateways.push(gateway);
    const url = await gateway.start();
    expect((await connectExchange(url, "cms.website.example:443", basic(SERVER_TOKEN))).status).toBe(403);
    expect(lookup).not.toHaveBeenCalled();
    expect(connector).not.toHaveBeenCalled();
  });

  it.each([
    { name: "loopback IPv4", addresses: [{ address: "127.0.0.1", family: 4 as const }] },
    { name: "private IPv4", addresses: [{ address: "10.0.0.8", family: 4 as const }] },
    { name: "metadata IPv4", addresses: [{ address: "169.254.169.254", family: 4 as const }] },
    { name: "loopback IPv6", addresses: [{ address: "::1", family: 6 as const }] },
    { name: "mixed DNS", addresses: [{ address: "93.184.216.34", family: 4 as const }, { address: "10.0.0.8", family: 4 as const }] },
  ])("rejects $name CMS DNS before connection", async ({ addresses }) => {
    const connector = vi.fn(async () => { throw new Error("must not connect"); });
    const lookup = vi.fn(async () => addresses);
    const gateway = new EgressGateway({
      config: config({ installationId: "insijets-demo", insijetsCmsOrigin: "https://cms.website.example" }),
      lookup,
      connect: connector,
    });
    gateways.push(gateway);
    const url = await gateway.start();
    expect((await connectExchange(url, "cms.website.example:443", basic(SERVER_TOKEN))).status).toBe(403);
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledWith("cms.website.example", { all: true, verbatim: true });
    expect(connector).not.toHaveBeenCalled();
  });

  it.each([undefined, "arnall", "another-installation", "insijets-demo "])("rejects a CMS origin for typed foreign or missing installation %s", installationId => {
    expect(() => new EgressGateway({ config: config({ installationId, insijetsCmsOrigin: "https://cms.website.example" }) })).toThrowError(EgressGatewayError);
  });

  it.each([
    "", " ", "http://cms.website.example", "https://cms.website.example:80", "https://cms.website.example:444",
    "https://user:password@cms.website.example", "https://user@cms.website.example", "https://cms.website.example/path",
    "https://cms.website.example/a/..", "https://cms.website.example?", "https://cms.website.example?q=1",
    "https://cms.website.example#", "https://cms.website.example#fragment", "https://*.website.example",
    "https://127.0.0.1", "https://93.184.216.34", "https://[2606:4700:4700::1111]", "https://localhost",
    "https://cms.localhost", "https://metadata.google.internal", "https://cms", "https://cms_website.example",
    " https://cms.website.example", "https://cms.website.example\n", "https://%63ms.website.example",
    "https://cms.website.example\\path",
  ])("rejects invalid typed CMS origin %s at construction", insijetsCmsOrigin => {
    expect(() => new EgressGateway({ config: config({ installationId: "insijets-demo", insijetsCmsOrigin }) })).toThrowError(EgressGatewayError);
  });

  it("validates the same InsiJets CMS opt-in from environment and defaults off", () => {
    vi.stubEnv("AIBRAIN_EGRESS_WORKER_HOSTS", "api.openai.com");
    vi.stubEnv("AIBRAIN_EGRESS_SUPABASE_ORIGIN", "https://project-ref.supabase.co");
    vi.stubEnv("AIBRAIN_INSTALLATION_ID", "insijets-demo");
    vi.stubEnv("AIBRAIN_EGRESS_INSIJETS_CMS_ORIGIN", "");
    expect(configFromEnvironment().insijetsCmsOrigin).toBeUndefined();
    vi.stubEnv("AIBRAIN_EGRESS_INSIJETS_CMS_ORIGIN", "https://CMS.website.example.:443/");
    expect(configFromEnvironment()).toMatchObject({ installationId: "insijets-demo", insijetsCmsOrigin: "https://cms.website.example" });
    vi.stubEnv("AIBRAIN_INSTALLATION_ID", "another-installation");
    expect(() => configFromEnvironment()).toThrowError(EgressGatewayError);
    vi.stubEnv("AIBRAIN_INSTALLATION_ID", "insijets-demo");
    vi.stubEnv("AIBRAIN_EGRESS_INSIJETS_CMS_ORIGIN", "https://cms.website.example/path");
    expect(() => configFromEnvironment()).toThrowError(EgressGatewayError);
  });
});
