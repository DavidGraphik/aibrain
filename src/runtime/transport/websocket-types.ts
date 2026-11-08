import { isIP } from "node:net";
import { lookup as nodeLookup } from "node:dns/promises";

export type WebSocketCredential = {
  kind: "capability-token" | "signed-bearer-token";
  token: string;
};

export interface WebSocketCredentialProvider {
  getCredential(): Promise<WebSocketCredential>;
}

export type WebSocketAuth = {
  /** Raw Codex App Server supports Authorization. Subprotocol is for an AiBrain gateway that explicitly implements it. */
  placement: "authorization-header" | "subprotocol";
  credentialProvider: WebSocketCredentialProvider;
};

export type WebSocketConnectOptions = {
  headers?: Readonly<Record<string, string>>;
  protocols?: readonly string[];
};

export type WebSocketEventName = "open" | "message" | "close" | "error";

export interface WebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: WebSocketEventName, listener: (event: unknown) => void): void;
  removeEventListener(type: WebSocketEventName, listener: (event: unknown) => void): void;
}

export interface WebSocketFactory {
  readonly supportsAuthorizationHeaders: boolean;
  create(url: string, options: WebSocketConnectOptions): WebSocketLike | Promise<WebSocketLike>;
}

/** Browser-compatible factory. It cannot send Authorization headers. */
export class StandardWebSocketFactory implements WebSocketFactory {
  readonly supportsAuthorizationHeaders = false;

  create(url: string, options: WebSocketConnectOptions): WebSocketLike {
    if (options.headers && Object.keys(options.headers).length > 0) {
      throw new Error("The standard Node/Web WebSocket API cannot set Authorization headers.");
    }
    return new WebSocket(url, options.protocols ? [...options.protocols] : undefined) as WebSocketLike;
  }
}

export type EndpointLookup = (
  hostname: string,
) => Promise<readonly { address: string; family: number }[]>;

export type PrivateEndpointPolicy = {
  /** Required for Docker/service DNS names; IP literals are checked directly. */
  allowedHosts?: readonly string[];
  /** Plain ws:// is permitted only for loopback unless this is true. */
  allowPrivatePlaintext?: boolean;
  lookup?: EndpointLookup;
};

function normalizedHostname(hostname: string) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isPrivateIpv4(address: string) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function isLoopback(address: string) {
  const normalized = normalizedHostname(address).toLowerCase();
  return normalized === "::1" || normalized === "localhost" || normalized.startsWith("127.");
}

function isPrivateAddress(address: string) {
  const normalized = normalizedHostname(address).toLowerCase();
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) === 6) {
    if (normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
    return mapped ? isPrivateIpv4(mapped[1]) : false;
  }
  return false;
}

export async function validatePrivateWebSocketEndpoint(
  endpoint: string,
  policy: PrivateEndpointPolicy,
) {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("WebSocket endpoint is not a valid absolute URL.");
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("WebSocket endpoint must use ws:// or wss://.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("WebSocket endpoint must not contain credentials, query parameters, or fragments.");
  }

  const hostname = normalizedHostname(parsed.hostname).toLowerCase();
  const literalFamily = isIP(hostname);
  let addresses: readonly { address: string; family: number }[];
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else if (hostname === "localhost") {
    addresses = [{ address: "127.0.0.1", family: 4 }];
  } else {
    const allowed = new Set((policy.allowedHosts ?? []).map((host) => host.toLowerCase()));
    if (!allowed.has(hostname)) {
      throw new Error("WebSocket service hostname is not in the private endpoint allowlist.");
    }
    const resolve = policy.lookup ?? (async (host: string) => nodeLookup(host, { all: true, verbatim: true }));
    addresses = await resolve(hostname);
    if (addresses.length === 0) throw new Error("WebSocket service hostname did not resolve.");
  }

  if (addresses.some(({ address }) => !isPrivateAddress(address))) {
    throw new Error("WebSocket endpoint resolved outside loopback or a private network.");
  }
  if (parsed.protocol === "ws:" && !policy.allowPrivatePlaintext && addresses.some(({ address }) => !isLoopback(address))) {
    throw new Error("Plain ws:// is restricted to loopback unless private plaintext is explicitly enabled.");
  }
  return parsed.toString();
}

export function buildWebSocketAuth(
  credential: WebSocketCredential,
  placement: WebSocketAuth["placement"],
  factory: WebSocketFactory,
): WebSocketConnectOptions {
  if (typeof credential.token !== "string" || credential.token.length < 32 || credential.token.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(credential.token)) {
    throw new Error("WebSocket credential must be a high-entropy token without whitespace or control characters.");
  }
  if (placement === "authorization-header") {
    if (!factory.supportsAuthorizationHeaders) {
      throw new Error("The configured WebSocket factory cannot send the required Authorization header.");
    }
    return { headers: { Authorization: `Bearer ${credential.token}` } };
  }
  if (!/^[A-Za-z0-9._~-]+$/u.test(credential.token)) {
    throw new Error("A subprotocol credential must be base64url/token encoded.");
  }
  const kind = credential.kind === "capability-token" ? "cap" : "bearer";
  return { protocols: ["aibrain.worker.v1", `aibrain.auth.${kind}.${credential.token}`] };
}
