import "server-only";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CatalogResource } from "@/catalog/contracts";
import { unixBrokerFetch } from "@/runtime/trinalum-broker-transport";

export const TRINALUM_CONNECTOR_RESOURCES: CatalogResource[] = [
  ["trinalum-attio", "Attio", true],
  ["trinalum-sibema", "Sibema", true],
  ["trinalum-mail", "Correo", false],
].map(([id, label, shared]) => ({
  id: id as string, label: label as string, kind: "connector", credentialMode: shared ? "shared-resource" : "none",
  managedBy: "company", sharedResource: shared as boolean, appId: null, connectorId: id as string, mcp: null,
}));

export type TrinalumCapabilitySnapshot = Readonly<{ installationId: string; userId: string; operations: readonly string[]; bindingFingerprint: string }>;
export function trinalumBindingFingerprint(config: { installationId: string; url?: string; socketPath?: string; users?: Record<string, unknown> }, userId: string) {
  return createHash("sha256").update(JSON.stringify({ installationId: config.installationId, url: config.url ?? null,
    socketPath: config.socketPath ?? null, binding: config.users?.[userId] ?? null })).digest("hex");
}

/** Checks the current authenticated broker binding, never assumes a configured tile is connected. */
export async function trinalumConnectorHealth(installationId: string, userId: string,
  options: { configPath?: string; fetcher?: typeof unixBrokerFetch; onCapabilities?: (snapshot: TrinalumCapabilitySnapshot) => void } = {}) {
  const health = new Map<string, { status: string; statusCode: string | null }>();
  for (const resource of TRINALUM_CONNECTOR_RESOURCES) health.set(resource.id, { status: "not_configured", statusCode: "TRINALUM_CONNECTOR_NOT_CONFIGURED" });
  if (installationId !== "trinalum-production") return health;
  try {
    const configPath = options.configPath ?? process.env.AIBRAIN_TRINALUM_BRIDGE_CONFIG;
    if (!configPath?.startsWith("/")) return health;
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const binding = config.users?.[userId];
    if (config.installationId !== installationId || binding?.status !== "active" || typeof binding.token !== "string" || binding.token.length < 32 || config.socketPath !== "/run/trinalum-broker/broker.sock") return health;
    const result = await (options.fetcher ?? unixBrokerFetch)(config.socketPath, new URL("http://127.0.0.1/capabilities"), {
      method: "POST", headers: { Authorization: `Bearer ${binding.token}` }, signal: AbortSignal.timeout(5_000),
    });
    if (!result.ok) throw new Error("BINDING_UNAVAILABLE");
    const body = await result.json();
    if (body.installationId !== installationId || body.userId !== userId || !Array.isArray(body.operations) || body.operations.length > 128 || body.operations.some((operation: unknown) => typeof operation !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(operation)) || new Set(body.operations).size !== body.operations.length) throw new Error("BINDING_MISMATCH");
    options.onCapabilities?.(Object.freeze({ installationId, userId, operations: Object.freeze([...body.operations]), bindingFingerprint: trinalumBindingFingerprint(config, userId) }));
    const groups = {
      "trinalum-attio": ["attio_search", "attio_deals", "attio_tasks"],
      "trinalum-sibema": ["sibema_read", "sibema_accounting_summary"],
      "trinalum-mail": body.mailbox ? ["mail_search", "mail_read"] : [],
    };
    for (const [id, operations] of Object.entries(groups)) if (operations.some(operation => body.operations.includes(operation))) health.set(id, { status: "connected", statusCode: null });
  } catch {
    for (const resource of TRINALUM_CONNECTOR_RESOURCES) health.set(resource.id, { status: "degraded", statusCode: "TRINALUM_BROKER_UNAVAILABLE" });
  }
  return health;
}
