import { createHash, timingSafeEqual } from "node:crypto";
import { lookup as systemLookup } from "node:dns/promises";
import {
  Agent,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ClientRequestArgs,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect as systemConnect, isIP, type Socket } from "node:net";
import { pathToFileURL } from "node:url";
import process from "node:process";
import type { Duplex } from "node:stream";

const HEALTH_PATH = "/__aibrain_egress_health";
const BROWSER_RESOLVE_PATH = "/__aibrain_egress_resolve";
const METADATA_HOSTNAMES = new Set([
  "instance-data.ec2.internal",
  "metadata.azure.internal",
  "metadata.google",
  "metadata.google.internal",
  "metadata.oraclecloud.com",
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-aibrain-pinned-ip",
]);

type Channel = "browser" | "worker" | "server";

export type GatewayAddress = Readonly<{ address: string; family: 4 | 6 }>;
export type GatewayLookup = (
  hostname: string,
  options: Readonly<{ all: true; verbatim: true }>,
) => Promise<readonly GatewayAddress[]>;
export type GatewayConnection = Readonly<{
  address: string;
  family: 4 | 6;
  port: number;
  hostname: string;
  channel: Channel;
  signal: AbortSignal;
}>;
export type GatewayConnector = (target: GatewayConnection) => Promise<Socket>;

export type EgressGatewayConfig = Readonly<{
  listenHost: string;
  port: number;
  browserToken: string;
  workerToken: string;
  serverToken: string;
  healthToken: string;
  workerHosts: ReadonlySet<string>;
  /** Only the server channel may CONNECT to these exact hosts on IMAPS/993. */
  mailHosts?: ReadonlySet<string>;
  installationId?: string;
  /** Optional exact HTTPS CMS origin; only insijets-demo's server channel may use it. */
  insijetsCmsOrigin?: string;
  supabaseHostname: string;
  serverConnectorHosts?: ReadonlySet<string>;
  /** Exact Nominalia TLS mail endpoints, server channel only. */
  serverMailTargets?: ReadonlySet<string>;
  maxHeaderBytes: number;
  maxConnections: number;
  maxAddresses: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  requestTimeoutMs: number;
  maxBytesPerExchange: number;
}>;

export type EgressGatewayOptions = Readonly<{
  config: EgressGatewayConfig;
  lookup?: GatewayLookup;
  connect?: GatewayConnector;
}>;

type Target = Readonly<{
  hostname: string;
  address: string;
  family: 4 | 6;
  port: number;
  channel: Channel;
}>;

export class EgressGatewayError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "EgressGatewayError";
    this.code = code;
  }
}

function boundedInteger(name: string, value: number, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new EgressGatewayError("CONFIG_INVALID", `${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function parseIpv4(address: string) {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = ((result << 8) | octet) >>> 0;
  }
  return result;
}

function ipv4Prefix(address: number, prefix: string, bits: number) {
  const expected = parseIpv4(prefix);
  if (expected === null) return false;
  const mask = bits === 0 ? 0 : (0xffff_ffff << (32 - bits)) >>> 0;
  return (address & mask) === (expected & mask);
}

function isGlobalIpv4(address: string) {
  const value = parseIpv4(address);
  if (value === null) return false;
  if (ipv4Prefix(value, "0.0.0.0", 8) ||
    ipv4Prefix(value, "10.0.0.0", 8) ||
    ipv4Prefix(value, "100.64.0.0", 10) ||
    ipv4Prefix(value, "127.0.0.0", 8) ||
    ipv4Prefix(value, "169.254.0.0", 16) ||
    ipv4Prefix(value, "172.16.0.0", 12) ||
    ipv4Prefix(value, "192.0.2.0", 24) ||
    ipv4Prefix(value, "192.88.99.0", 24) ||
    ipv4Prefix(value, "192.168.0.0", 16) ||
    ipv4Prefix(value, "198.18.0.0", 15) ||
    ipv4Prefix(value, "198.51.100.0", 24) ||
    ipv4Prefix(value, "203.0.113.0", 24) ||
    ipv4Prefix(value, "224.0.0.0", 4) ||
    ipv4Prefix(value, "240.0.0.0", 4)) return false;
  if (ipv4Prefix(value, "192.0.0.0", 24)) {
    return address === "192.0.0.9" || address === "192.0.0.10";
  }
  return true;
}

function parseIpv6(address: string) {
  if (address.includes("%") || address.split("::").length > 2) return null;
  let normalized = address.toLowerCase();
  const lastColon = normalized.lastIndexOf(":");
  if (normalized.includes(".") && lastColon >= 0) {
    const ipv4 = parseIpv4(normalized.slice(lastColon + 1));
    if (ipv4 === null) return null;
    normalized = `${normalized.slice(0, lastColon)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const compressed = normalized.includes("::");
  const [leftValue, rightValue = ""] = normalized.split("::");
  const left = leftValue ? leftValue.split(":") : [];
  const right = rightValue ? rightValue.split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((!compressed && missing !== 0) || (compressed && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8) return null;
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}

function ipv6Prefix(address: bigint, prefix: string, bits: number) {
  const expected = parseIpv6(prefix);
  return expected !== null && (address >> BigInt(128 - bits)) === (expected >> BigInt(128 - bits));
}

function isGlobalIpv6(address: string) {
  const value = parseIpv6(address);
  if (value === null || !ipv6Prefix(value, "2000::", 3)) return false;
  return !ipv6Prefix(value, "2001::", 32) &&
    !ipv6Prefix(value, "2001:2::", 48) &&
    !ipv6Prefix(value, "2001:10::", 28) &&
    !ipv6Prefix(value, "2001:20::", 28) &&
    !ipv6Prefix(value, "2001:db8::", 32) &&
    !ipv6Prefix(value, "2002::", 16) &&
    !ipv6Prefix(value, "3fff::", 20);
}

export function isGlobalAddress(address: string) {
  const family = isIP(address);
  return family === 4 ? isGlobalIpv4(address) : family === 6 ? isGlobalIpv6(address) : false;
}

export function isHealthProbeAuthorized(
  remoteAddress: string | undefined,
  authorization: string | string[] | undefined,
  healthToken: string,
) {
  if (isLoopback(remoteAddress)) return true;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")
    || authorization.length > 768) return false;
  const expected = validateToken("healthToken", healthToken);
  const candidate = digest(authorization.slice(7));
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function normalizeHostname(value: string) {
  const unbracketed = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const hostname = unbracketed.toLowerCase().replace(/\.$/u, "");
  if (!hostname || hostname.length > 253 || /[\u0000-\u0020\u007f]/u.test(hostname)) {
    throw new EgressGatewayError("TARGET_INVALID", "Destination hostname is invalid.");
  }
  if (isIP(hostname)) return hostname;
  if (hostname.split(".").some((label) =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
    throw new EgressGatewayError("TARGET_INVALID", "Destination hostname is invalid.");
  }
  return hostname;
}

function rejectLocalHostname(hostname: string) {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || METADATA_HOSTNAMES.has(hostname)) {
    throw new EgressGatewayError("TARGET_REJECTED", "Local and metadata destinations are forbidden.");
  }
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

function validateToken(name: string, token: string) {
  if (Buffer.byteLength(token, "utf8") < 32 || Buffer.byteLength(token, "utf8") > 512 || /[\u0000-\u0020\u007f]/u.test(token)) {
    throw new EgressGatewayError("CONFIG_INVALID", `${name} must be a 32-512 byte non-whitespace secret.`);
  }
  return digest(token);
}

function channelFor(headers: IncomingHttpHeaders, tokens: ReadonlyMap<Channel, Buffer>) {
  const value = headers["proxy-authorization"];
  if (typeof value !== "string" || value.length > 768) {
    throw new EgressGatewayError("AUTH_REQUIRED", "Valid proxy bearer authentication is required.");
  }
  let scheme: "bearer" | "basic";
  let secret: string;
  if (value.startsWith("Bearer ")) {
    scheme = "bearer";
    secret = value.slice(7);
  } else if (value.startsWith("Basic ")) {
    scheme = "basic";
    let decoded: string;
    try { decoded = Buffer.from(value.slice(6), "base64").toString("utf8"); } catch {
      throw new EgressGatewayError("AUTH_REQUIRED", "Valid proxy authentication is required.");
    }
    const separator = decoded.indexOf(":");
    if (separator < 0 || decoded.slice(0, separator) !== "aibrain") {
      throw new EgressGatewayError("AUTH_REQUIRED", "Valid proxy authentication is required.");
    }
    secret = decoded.slice(separator + 1);
  } else {
    throw new EgressGatewayError("AUTH_REQUIRED", "Valid proxy authentication is required.");
  }
  const candidate = digest(secret);
  for (const [channel, expected] of tokens) {
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      if (scheme === "basic" && channel === "browser") break;
      return channel;
    }
  }
  throw new EgressGatewayError("AUTH_REQUIRED", "Valid proxy authentication is required.");
}

function parseAuthority(authority: string) {
  if (Buffer.byteLength(authority, "utf8") > 1_024 || authority.includes("@") || authority.includes("/")) {
    throw new EgressGatewayError("TARGET_INVALID", "CONNECT authority is invalid.");
  }
  const match = authority.startsWith("[")
    ? /^\[([^\]]+)\]:(\d{1,5})$/u.exec(authority)
    : /^([^:]+):(\d{1,5})$/u.exec(authority);
  if (!match) {
    throw new EgressGatewayError("TARGET_INVALID", "CONNECT requires an explicit credential-free host and port.");
  }
  return { hostname: normalizeHostname(match[1]!), port: Number(match[2]) };
}

function validateDnsResults(results: readonly GatewayAddress[], maxAddresses: number) {
  if (!Array.isArray(results) || results.length === 0) {
    throw new EgressGatewayError("DNS_EMPTY", "DNS returned no addresses.");
  }
  if (results.length > maxAddresses) {
    throw new EgressGatewayError("DNS_REJECTED", "DNS returned too many addresses.");
  }
  const unique = new Map<string, GatewayAddress>();
  for (const result of results) {
    if (!result || (result.family !== 4 && result.family !== 6) || isIP(result.address) !== result.family) {
      throw new EgressGatewayError("DNS_REJECTED", "DNS returned malformed addresses.");
    }
    if (!isGlobalAddress(result.address)) {
      throw new EgressGatewayError("DNS_REJECTED", "DNS returned a non-global or mixed destination.");
    }
    unique.set(`${result.family}:${result.address.toLowerCase()}`, result);
  }
  return [...unique.values()];
}

function connectionHeaderNames(headers: IncomingHttpHeaders) {
  const raw = Array.isArray(headers.connection) ? headers.connection.join(",") : headers.connection ?? "";
  return new Set(raw.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function forwardHeaders(headers: IncomingHttpHeaders, host: string) {
  const connectionNames = connectionHeaderNames(headers);
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP_HEADERS.has(normalized) || connectionNames.has(normalized)) continue;
    result[normalized] = value;
  }
  result.host = host;
  result.connection = "close";
  return result;
}

function sendHttp(response: ServerResponse, status: number, message: string) {
  if (response.headersSent) return response.destroy();
  response.writeHead(status, {
    "cache-control": "no-store",
    connection: "close",
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(message),
  });
  response.end(message);
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  if (response.headersSent) return response.destroy();
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "cache-control": "no-store",
    connection: "close",
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendConnect(socket: Duplex, status: number, reason: string) {
  if (!socket.destroyed && socket.writable) {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } else socket.destroy();
}

function statusFor(error: unknown) {
  if (error instanceof EgressGatewayError) {
    if (error.code === "AUTH_REQUIRED") return 407;
    if (error.code === "SATURATED") return 429;
    if (error.code === "CONNECT_TIMEOUT") return 504;
    if (new Set(["TARGET_INVALID", "TARGET_REJECTED", "DNS_EMPTY", "DNS_REJECTED", "PIN_REQUIRED", "PIN_REJECTED", "CHANNEL_REJECTED"]).has(error.code)) return 403;
  }
  return 502;
}

function reasonFor(status: number) {
  if (status === 403) return "Forbidden";
  if (status === 407) return "Proxy Authentication Required";
  if (status === 429) return "Too Many Requests";
  if (status === 504) return "Gateway Timeout";
  return "Bad Gateway";
}

function isLoopback(address: string | undefined) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function defaultConnector(target: GatewayConnection) {
  return new Promise<Socket>((resolve, reject) => {
    if (target.signal.aborted) return reject(new EgressGatewayError("CONNECT_ABORTED", "Connection was aborted."));
    const socket = systemConnect({ host: target.address, family: target.family, port: target.port, allowHalfOpen: false });
    const abort = () => socket.destroy(new EgressGatewayError("CONNECT_ABORTED", "Connection was aborted."));
    target.signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => {
      target.signal.removeEventListener("abort", abort);
      resolve(socket);
    });
    socket.once("error", (error) => {
      target.signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

class ConnectedSocketAgent extends Agent {
  private readonly connectedSocket: Socket;

  constructor(connectedSocket: Socket) {
    super({ keepAlive: false, maxSockets: 1 });
    this.connectedSocket = connectedSocket;
  }

  override createConnection(
    _options: ClientRequestArgs,
    _callback?: (error: Error | null, socket: Duplex) => void,
  ): Duplex {
    return this.connectedSocket;
  }
}

export class EgressGateway {
  private readonly config: EgressGatewayConfig;
  private readonly insijetsCmsHostname: string | undefined;
  private readonly lookup: GatewayLookup;
  private readonly connector: GatewayConnector;
  private readonly tokens: ReadonlyMap<Channel, Buffer>;
  private readonly clientSockets = new Set<Socket>();
  private readonly upstreamSockets = new Set<Socket>();
  private server: Server | null = null;
  private startPromise: Promise<string> | null = null;

  constructor(options: EgressGatewayOptions) {
    this.config = validateConfig(options.config);
    this.insijetsCmsHostname = this.config.insijetsCmsOrigin === undefined
      ? undefined : new URL(this.config.insijetsCmsOrigin).hostname;
    this.lookup = options.lookup ?? systemLookup as GatewayLookup;
    this.connector = options.connect ?? defaultConnector;
    const browser = validateToken("browserToken", this.config.browserToken);
    const worker = validateToken("workerToken", this.config.workerToken);
    const server = validateToken("serverToken", this.config.serverToken);
    const health = validateToken("healthToken", this.config.healthToken);
    const secrets = [browser, worker, server, health];
    if (secrets.some((secret, index) => secrets.slice(index + 1).some((candidate) => secret.equals(candidate)))) {
      throw new EgressGatewayError("CONFIG_INVALID", "Egress channel and health secrets must be pairwise distinct.");
    }
    this.tokens = new Map<Channel, Buffer>([["browser", browser], ["worker", worker], ["server", server]]);
  }

  start(): Promise<string> {
    if (this.server) return Promise.resolve(this.url());
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startServer().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startServer() {
    const server = createServer({
      maxHeaderSize: this.config.maxHeaderBytes,
      requestTimeout: this.config.requestTimeoutMs,
      headersTimeout: Math.min(this.config.requestTimeoutMs, 15_000),
      keepAliveTimeout: 1_000,
      connectionsCheckingInterval: 1_000,
    });
    server.maxConnections = this.config.maxConnections;
    server.on("connection", (socket) => {
      if (this.clientSockets.size >= this.config.maxConnections) return socket.destroy();
      this.clientSockets.add(socket);
      socket.setTimeout(this.config.idleTimeoutMs, () => socket.destroy());
      socket.once("close", () => this.clientSockets.delete(socket));
    });
    server.on("request", (request, response) => void this.handleRequest(request, response));
    server.on("connect", (request, socket, head) => void this.handleConnect(request, socket, head));
    server.on("clientError", (_error, socket) => sendConnect(socket, 400, "Bad Request"));
    try {
      await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: this.config.listenHost, port: this.config.port, exclusive: true });
      });
      this.server = server;
      return this.url();
    } catch (error) {
      server.close();
      throw error;
    }
  }

  async stop() {
    if (this.startPromise) {
      try { await this.startPromise; } catch { return; }
    }
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const socket of this.clientSockets) socket.destroy();
    for (const socket of this.upstreamSockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  health() {
    return Object.freeze({
      healthy: this.server?.listening === true,
      activeClients: this.clientSockets.size,
      activeUpstreams: this.upstreamSockets.size,
    });
  }

  url() {
    const address = this.server?.address();
    if (!address || typeof address === "string") throw new EgressGatewayError("NOT_RUNNING", "Egress gateway is not running.");
    const host = address.address.includes(":") ? `[${address.address}]` : address.address;
    return `http://${host}:${address.port}`;
  }

  private async resolveTarget(channel: Channel, hostname: string, port: number, headers: IncomingHttpHeaders): Promise<Target> {
    rejectLocalHostname(hostname);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new EgressGatewayError("TARGET_INVALID", "Destination port is invalid.");
    }
    if (channel === "browser") {
      if (port !== 80 && port !== 443) throw new EgressGatewayError("CHANNEL_REJECTED", "Browser egress is limited to ports 80 and 443.");
      const rawPin = headers["x-aibrain-pinned-ip"];
      if (typeof rawPin !== "string" || rawPin.includes(",")) throw new EgressGatewayError("PIN_REQUIRED", "Browser requests require one pinned IP.");
      const address = rawPin.trim().toLowerCase();
      const family = isIP(address);
      if ((family !== 4 && family !== 6) || !isGlobalAddress(address)) throw new EgressGatewayError("PIN_REJECTED", "Browser pinned IP is not globally routable.");
      if (isIP(hostname) && hostname.toLowerCase() !== address) throw new EgressGatewayError("PIN_REJECTED", "Browser IP destination differs from its pin.");
      return { hostname, address, family, port, channel };
    }
    const imaps = channel === "server" && port === 993 && this.config.mailHosts?.has(hostname);
    const mailTarget = channel === "server" && this.config.serverMailTargets?.has(`${hostname}:${port}`);
    if (port !== 443 && !imaps && !mailTarget) throw new EgressGatewayError("CHANNEL_REJECTED", "Destination port is not configured for this channel.");
    if (isIP(hostname)) throw new EgressGatewayError("TARGET_REJECTED", "Worker and server channels require configured DNS hostnames.");
    if (channel === "worker" && !this.config.workerHosts.has(hostname)) {
      throw new EgressGatewayError("CHANNEL_REJECTED", "Worker destination is not configured.");
    }
    if (channel === "server" && !imaps && !mailTarget && hostname !== this.config.supabaseHostname && hostname !== "backend.composio.dev" && hostname !== "api.instantly.ai" && hostname !== this.insijetsCmsHostname && !this.config.serverConnectorHosts?.has(hostname)) {
      throw new EgressGatewayError("CHANNEL_REJECTED", "Server destination is not an approved authentication or connector API host.");
    }
    const results = validateDnsResults(await this.lookup(hostname, { all: true, verbatim: true }), this.config.maxAddresses);
    const selected = results[0]!;
    return { hostname, address: selected.address, family: selected.family, port, channel };
  }

  private async open(target: Target) {
    if (this.upstreamSockets.size >= this.config.maxConnections) throw new EgressGatewayError("SATURATED", "Egress gateway is saturated.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.connectTimeoutMs);
    timeout.unref();
    try {
      const socket = await Promise.race([
        this.connector({ ...target, signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new EgressGatewayError("CONNECT_TIMEOUT", "Pinned connect timed out.")), { once: true });
        }),
      ]);
      socket.setTimeout(this.config.idleTimeoutMs, () => socket.destroy());
      this.upstreamSockets.add(socket);
      socket.once("close", () => this.upstreamSockets.delete(socket));
      return socket;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async handleConnect(request: IncomingMessage, client: Duplex, head: Buffer) {
    let upstream: Socket | null = null;
    try {
      const channel = channelFor(request.headers, this.tokens);
      const authority = parseAuthority(request.url ?? "");
      const target = await this.resolveTarget(channel, authority.hostname, authority.port, request.headers);
      upstream = await this.open(target);
      if (head.byteLength > this.config.maxBytesPerExchange) throw new EgressGatewayError("TARGET_REJECTED", "Exchange byte limit exceeded.");
      client.write("HTTP/1.1 200 Connection Established\r\nConnection: close\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      let bytes = head.byteLength;
      const account = (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > this.config.maxBytesPerExchange) {
          upstream?.destroy();
          client.destroy();
        }
      };
      client.on("data", account);
      upstream.on("data", account);
      client.once("error", () => upstream?.destroy());
      upstream.once("error", () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    } catch (error) {
      upstream?.destroy();
      const status = statusFor(error);
      if (status === 407 && !client.destroyed && client.writable) {
        client.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Bearer realm=\"aibrain-egress\"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      } else sendConnect(client, status, reasonFor(status));
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse) {
    if (request.method === "GET" && request.url === HEALTH_PATH) {
      if (!isHealthProbeAuthorized(
        request.socket.remoteAddress,
        request.headers.authorization,
        this.config.healthToken,
      )) return sendHttp(response, 404, "Not found.\n");
      const body = `${JSON.stringify(this.health())}\n`;
      response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    if (request.method === "GET" && request.url?.startsWith(BROWSER_RESOLVE_PATH)) {
      try {
        const channel = channelFor(request.headers, this.tokens);
        if (channel !== "browser") {
          throw new EgressGatewayError("CHANNEL_REJECTED", "Only the browser channel may resolve browser destinations.");
        }
        const requestUrl = new URL(request.url, "http://aibrain-egress.internal");
        const hostnames = requestUrl.searchParams.getAll("hostname");
        if (requestUrl.pathname !== BROWSER_RESOLVE_PATH || hostnames.length !== 1 ||
            [...requestUrl.searchParams.keys()].some((key) => key !== "hostname")) {
          throw new EgressGatewayError("TARGET_INVALID", "Browser DNS request is invalid.");
        }
        const hostname = normalizeHostname(hostnames[0]!);
        if (isIP(hostname)) {
          throw new EgressGatewayError("TARGET_INVALID", "Browser DNS requires a hostname.");
        }
        rejectLocalHostname(hostname);
        const addresses = validateDnsResults(
          await this.lookup(hostname, { all: true, verbatim: true }),
          this.config.maxAddresses,
        );
        sendJson(response, 200, { schemaVersion: 1, hostname, addresses });
      } catch (error) {
        const status = statusFor(error);
        if (status === 407 && !response.headersSent) {
          response.setHeader("proxy-authenticate", "Bearer realm=\"aibrain-egress\"");
        }
        sendHttp(response, status, `${reasonFor(status)}.\n`);
      }
      return;
    }
    let upstreamSocket: Socket | null = null;
    try {
      const channel = channelFor(request.headers, this.tokens);
      if (channel !== "browser") throw new EgressGatewayError("CHANNEL_REJECTED", "Worker and server channels support CONNECT only.");
      let url: URL;
      try { url = new URL(request.url ?? ""); } catch (error) {
        throw new EgressGatewayError("TARGET_INVALID", "Absolute proxy URL is required.", { cause: error });
      }
      if (url.protocol !== "http:" || url.username || url.password || !url.hostname) {
        throw new EgressGatewayError("TARGET_REJECTED", "Browser forwarding permits credential-free HTTP only; HTTPS uses CONNECT.");
      }
      const hostname = normalizeHostname(url.hostname);
      const port = url.port ? Number(url.port) : 80;
      const target = await this.resolveTarget(channel, hostname, port, request.headers);
      upstreamSocket = await this.open(target);
      const host = url.port && url.port !== "80" ? `${url.hostname}:${url.port}` : url.hostname;
      const agent = new ConnectedSocketAgent(upstreamSocket);
      const upstream = httpRequest({
        method: request.method,
        hostname: target.address,
        family: target.family,
        port: target.port,
        path: `${url.pathname}${url.search}`,
        headers: forwardHeaders(request.headers, host),
        agent,
        timeout: this.config.requestTimeoutMs,
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, forwardHeaders(upstreamResponse.headers, host));
        let bytes = 0;
        upstreamResponse.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > this.config.maxBytesPerExchange) {
            upstreamResponse.destroy();
            response.destroy();
          }
        });
        upstreamResponse.pipe(response);
      });
      upstream.once("error", () => {
        if (!response.headersSent) sendHttp(response, 502, "Upstream connection failed.\n");
        else response.destroy();
      });
      let requestBytes = 0;
      request.on("data", (chunk: Buffer) => {
        requestBytes += chunk.byteLength;
        if (requestBytes > this.config.maxBytesPerExchange) {
          request.destroy();
          upstream.destroy();
        }
      });
      request.pipe(upstream);
    } catch (error) {
      upstreamSocket?.destroy();
      const status = statusFor(error);
      if (status === 407 && !response.headersSent) response.setHeader("proxy-authenticate", "Bearer realm=\"aibrain-egress\"");
      sendHttp(response, status, `${reasonFor(status)}.\n`);
    }
  }
}

function normalizeInsijetsCmsOrigin(value: string, installationId: string | undefined) {
  if (installationId !== "insijets-demo") {
    throw new EgressGatewayError("CONFIG_INVALID", "CMS egress is exclusive to insijets-demo.");
  }
  // Validate the raw origin too: URL parsing alone hides empty query/fragment,
  // dot-segment paths, escaped hosts and surrounding whitespace.
  if (typeof value !== "string" || !/^https:\/\/[A-Za-z0-9.-]+(?::443)?\/?$/u.test(value)) {
    throw new EgressGatewayError("CONFIG_INVALID", "CMS egress requires one credential-free root HTTPS DNS origin on port 443.");
  }
  try {
    const origin = new URL(value);
    const hostname = normalizeHostname(origin.hostname);
    if (origin.protocol !== "https:" || origin.port || origin.username || origin.password ||
        origin.pathname !== "/" || origin.search || origin.hash || isIP(hostname) || !hostname.includes(".")) {
      throw new Error("Invalid CMS origin");
    }
    rejectLocalHostname(hostname);
    return `https://${hostname}`;
  } catch (error) {
    throw new EgressGatewayError("CONFIG_INVALID", "CMS egress requires one exact public DNS HTTPS origin.", { cause: error });
  }
}

export function validateConfig(config: EgressGatewayConfig): EgressGatewayConfig {
  if (config.listenHost !== "0.0.0.0") throw new EgressGatewayError("CONFIG_INVALID", "listenHost must be 0.0.0.0 inside the sidecar.");
  boundedInteger("port", config.port, 0, 65_535);
  boundedInteger("maxHeaderBytes", config.maxHeaderBytes, 4_096, 65_536);
  boundedInteger("maxConnections", config.maxConnections, 1, 1_024);
  boundedInteger("maxAddresses", config.maxAddresses, 1, 32);
  boundedInteger("connectTimeoutMs", config.connectTimeoutMs, 100, 60_000);
  boundedInteger("idleTimeoutMs", config.idleTimeoutMs, 1_000, 300_000);
  boundedInteger("requestTimeoutMs", config.requestTimeoutMs, 1_000, 600_000);
  boundedInteger("maxBytesPerExchange", config.maxBytesPerExchange, 1_024, 512 * 1_024 * 1_024);
  if (!(config.workerHosts instanceof Set) || config.workerHosts.size === 0) {
    throw new EgressGatewayError("CONFIG_INVALID", "At least one exact worker hostname is required.");
  }
  for (const hostname of config.workerHosts) {
    if (normalizeHostname(hostname) !== hostname || isIP(hostname)) throw new EgressGatewayError("CONFIG_INVALID", "Worker allowlist must contain normalized DNS hostnames.");
    rejectLocalHostname(hostname);
  }
  if (config.serverConnectorHosts !== undefined) {
    if (!(config.serverConnectorHosts instanceof Set) || config.serverConnectorHosts.size > 16) throw new EgressGatewayError("CONFIG_INVALID", "Server connector allowlist must contain at most 16 exact hosts.");
    for (const hostname of config.serverConnectorHosts) {
      if (normalizeHostname(hostname) !== hostname || isIP(hostname)) throw new EgressGatewayError("CONFIG_INVALID", "Server connector allowlist must contain normalized DNS hostnames.");
      rejectLocalHostname(hostname);
    }
  }
  if (config.mailHosts !== undefined) {
    if (!(config.mailHosts instanceof Set) || config.mailHosts.size > 10) throw new EgressGatewayError("CONFIG_INVALID", "Invalid IMAPS allowlist.");
    for (const hostname of config.mailHosts) {
      if (normalizeHostname(hostname) !== hostname || isIP(hostname) || !hostname.includes(".")) throw new EgressGatewayError("CONFIG_INVALID", "IMAPS allowlist requires exact DNS hostnames.");
      rejectLocalHostname(hostname);
    }
  }
  if (config.serverMailTargets !== undefined) {
    const supported = new Set(["pop.securemail.pro:993", "authsmtp.securemail.pro:587"]);
    if (!(config.serverMailTargets instanceof Set) || [...config.serverMailTargets].some(target => !supported.has(target))) {
      throw new EgressGatewayError("CONFIG_INVALID", "Mail targets must be reviewed exact Nominalia TLS endpoints.");
    }
  }
  const supabaseHostname = normalizeHostname(config.supabaseHostname);
  if (supabaseHostname !== config.supabaseHostname || isIP(supabaseHostname)) throw new EgressGatewayError("CONFIG_INVALID", "Supabase hostname must be normalized DNS.");
  rejectLocalHostname(supabaseHostname);
  if (config.insijetsCmsOrigin === undefined) return config;
  const insijetsCmsOrigin = normalizeInsijetsCmsOrigin(config.insijetsCmsOrigin, config.installationId);
  return Object.freeze({ ...config, insijetsCmsOrigin });
}

function envInteger(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) throw new EgressGatewayError("CONFIG_INVALID", `${name} must be an integer.`);
  return Number(raw);
}

export function configFromEnvironment(): EgressGatewayConfig {
  const workerHosts = new Set((process.env.AIBRAIN_EGRESS_WORKER_HOSTS ?? "")
    .split(",").map((value) => value.trim().toLowerCase().replace(/\.$/u, "")).filter(Boolean));
  let supabase: URL;
  try { supabase = new URL(process.env.AIBRAIN_EGRESS_SUPABASE_ORIGIN ?? ""); } catch (error) {
    throw new EgressGatewayError("CONFIG_INVALID", "AIBRAIN_EGRESS_SUPABASE_ORIGIN must be an HTTPS origin.", { cause: error });
  }
  if (supabase.protocol !== "https:" || supabase.username || supabase.password || supabase.port || supabase.pathname !== "/" || supabase.search || supabase.hash) {
    throw new EgressGatewayError("CONFIG_INVALID", "AIBRAIN_EGRESS_SUPABASE_ORIGIN must be a credential-free default-port HTTPS origin.");
  }
  const port = envInteger("AIBRAIN_EGRESS_PORT", 8080);
  if (port === 0) throw new EgressGatewayError("CONFIG_INVALID", "AIBRAIN_EGRESS_PORT cannot be ephemeral in production.");
  return validateConfig({
    listenHost: process.env.AIBRAIN_EGRESS_LISTEN_HOST ?? "0.0.0.0",
    port,
    browserToken: process.env.AIBRAIN_EGRESS_BROWSER_TOKEN ?? "",
    workerToken: process.env.AIBRAIN_EGRESS_WORKER_TOKEN ?? "",
    serverToken: process.env.AIBRAIN_EGRESS_SERVER_TOKEN ?? "",
    healthToken: process.env.AIBRAIN_EGRESS_HEALTH_TOKEN ?? "",
    workerHosts,
    serverConnectorHosts: new Set((process.env.AIBRAIN_EGRESS_SERVER_CONNECTOR_HOSTS ?? "").split(",").filter(Boolean)),
    serverMailTargets: new Set((process.env.AIBRAIN_EGRESS_SERVER_MAIL_TARGETS ?? "").split(",").filter(Boolean)),
    mailHosts: new Set((process.env.AIBRAIN_EGRESS_MAIL_HOSTS ?? "").split(",").map(v => v.trim()).filter(Boolean)),
    installationId: process.env.AIBRAIN_INSTALLATION_ID,
    insijetsCmsOrigin: process.env.AIBRAIN_EGRESS_INSIJETS_CMS_ORIGIN || undefined,
    supabaseHostname: normalizeHostname(supabase.hostname),
    maxHeaderBytes: envInteger("AIBRAIN_EGRESS_MAX_HEADER_BYTES", 32 * 1_024),
    maxConnections: envInteger("AIBRAIN_EGRESS_MAX_CONNECTIONS", 128),
    maxAddresses: envInteger("AIBRAIN_EGRESS_MAX_ADDRESSES", 16),
    connectTimeoutMs: envInteger("AIBRAIN_EGRESS_CONNECT_TIMEOUT_MS", 10_000),
    idleTimeoutMs: envInteger("AIBRAIN_EGRESS_IDLE_TIMEOUT_MS", 60_000),
    requestTimeoutMs: envInteger("AIBRAIN_EGRESS_REQUEST_TIMEOUT_MS", 120_000),
    maxBytesPerExchange: envInteger("AIBRAIN_EGRESS_MAX_BYTES", 128 * 1_024 * 1_024),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gateway = new EgressGateway({ config: configFromEnvironment() });
  const shutdown = async () => { await gateway.stop(); process.exit(0); };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  gateway.start().then((url) => {
    process.stdout.write(`${JSON.stringify({ event: "aibrain_egress_ready", url })}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ event: "aibrain_egress_start_failed", code: error instanceof EgressGatewayError ? error.code : "UNKNOWN" })}\n`);
    process.exit(1);
  });
}
