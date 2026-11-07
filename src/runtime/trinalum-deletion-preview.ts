import { deploymentErpOrigin } from "@/deployment/identities";
import { readFile } from "node:fs/promises";
import { connectorFingerprint } from "@/connectors/canonical";
import { nativeAttioActors } from "./trinalum-native-disposition";
import type { TrinalumBridgeContext } from "./trinalum-dynamic-tools";

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const text = (value: unknown) => value === null || typeof value === "string";
const integration = connectorFingerprint({ provider: "SIBEMA", origin: deploymentErpOrigin(), contractor_id: 1 });

export class SibemaDeletionPreviewError extends Error {
  constructor(readonly code: "SIBEMA_DELETE_PREVIEW_INVALID" | "SIBEMA_DELETE_PREVIEW_ACCESS_CHANGED" | "SIBEMA_DELETE_PREVIEW_UNAVAILABLE") { super(code); }
}
function requirePreview(value: unknown): asserts value {
  if (!value) throw new SibemaDeletionPreviewError("SIBEMA_DELETE_PREVIEW_INVALID");
}

/** Transport an actor-bound native proof without asking the model to copy it.
 * Native prepare still verifies the HMAC; this layer has no signing key and
 * never renews a prepared proof or authorizes an execute/provider DELETE. */
export async function resolveSibemaDeletionPreview(input: Record<string, unknown>, context: TrinalumBridgeContext,
  configPath: string, endpoint: URL, binding: { token: string; status: string }, fetcher: (url: URL, init: RequestInit) => Promise<Response>) {
  if (input.type !== "delete_offer" && input.type !== "delete_customer_tariff") return;
  const request = input.request;
  // A supplied body is the legacy exact-proof contract. Never repair or replace
  // an invalid, expired or altered proof silently: native validation owns it.
  if (object(request) && Object.hasOwn(request, "body")) return;
  const kind = input.type === "delete_offer" ? "offer" : "tariff";
  const targetKey = kind === "offer" ? "offerId" : "tariffId";
  requirePreview(object(request) && Object.keys(request).sort().join(",") === ["customerId", targetKey].sort().join(",") && id(request.customerId) && id(request[targetKey]));
  const actor = nativeAttioActors[context.authenticatedEmail?.trim().toLowerCase() ?? ""];
  requirePreview(actor && ["Trini", "Miguel", "Nerea"].includes(actor));
  const check = async () => {
    if (context.signal?.aborted || context.revalidateWrite && !await context.revalidateWrite()) throw new SibemaDeletionPreviewError("SIBEMA_DELETE_PREVIEW_ACCESS_CHANGED");
    const fresh = JSON.parse(await readFile(configPath, "utf8"));
    if (fresh.installationId !== context.installationId || fresh.users?.[context.userId]?.status !== "active" || fresh.users[context.userId].token !== binding.token) throw new SibemaDeletionPreviewError("SIBEMA_DELETE_PREVIEW_ACCESS_CHANGED");
  };
  await check();
  const path = `/customers/${request.customerId}/${kind === "offer" ? "offers" : "tariffs"}/${request[targetKey]}/deletion-preview`;
  const url = new URL(endpoint); url.pathname = "/read";
  const result = await fetcher(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(50_000),
    headers: { Authorization: `Bearer ${binding.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "sibema_api", input: { command: "read", method: "GET", path } }) });
  if (!result.ok) { await result.body?.cancel(); throw new SibemaDeletionPreviewError("SIBEMA_DELETE_PREVIEW_UNAVAILABLE"); }
  const raw = await result.text(); requirePreview(Buffer.byteLength(raw) <= 64 * 1024);
  let envelope: unknown;
  try { envelope = JSON.parse(raw); } catch { throw new SibemaDeletionPreviewError("SIBEMA_DELETE_PREVIEW_INVALID"); }
  requirePreview(object(envelope) && envelope.source === "Trinalum connector broker" && object(envelope.data));
  const native = envelope.data;
  requirePreview(native.source === "SIBEMA" && native.method === "GET" && native.path === path && native.integrationProjection === true && object(native.data));
  const preview = native.data;
  const fields = ["customer_id", kind === "offer" ? "offer_id" : "tariff_id", "expectedSnapshotSha256", "expiresAt", "proof", "independent_readback", "warning",
    ...(kind === "offer" ? ["description", "line_count", "file_count"] : ["reference", "product_id", "price", "remarks"])];
  requirePreview(Object.keys(preview).sort().join(",") === fields.sort().join(",") && preview.customer_id === request.customerId &&
    preview[kind === "offer" ? "offer_id" : "tariff_id"] === request[targetKey] && preview.independent_readback === true &&
    typeof preview.warning === "string" && typeof preview.expectedSnapshotSha256 === "string" && /^[a-f0-9]{64}$/.test(preview.expectedSnapshotSha256) &&
    typeof preview.proof === "string" && preview.proof.length <= 2000 && typeof preview.expiresAt === "string");
  requirePreview(kind === "offer" ? text(preview.description) && Number.isSafeInteger(preview.line_count) && Number(preview.line_count) >= 0 && preview.file_count === 0
    : text(preview.reference) && id(preview.product_id) && text(preview.remarks) && (preview.price === null || typeof preview.price === "number" && Number.isFinite(preview.price)));
  const parts = preview.proof.split(".");
  requirePreview(parts.length === 3 && parts[0] === "v1" && /^[A-Za-z0-9_-]+$/.test(parts[1]) && /^[A-Za-z0-9_-]{43}$/.test(parts[2]));
  let payload: unknown;
  try { const bytes = Buffer.from(parts[1], "base64url"); requirePreview(bytes.toString("base64url") === parts[1]); payload = JSON.parse(bytes.toString("utf8")); }
  catch { throw new SibemaDeletionPreviewError("SIBEMA_DELETE_PREVIEW_INVALID"); }
  requirePreview(object(payload) && Object.keys(payload).sort().join(",") === "actor,customerId,expiresAt,integration,issuedAt,kind,snapshotSha256,targetId,version" &&
    payload.version === 1 && payload.actor === actor && payload.integration === integration && payload.kind === kind && payload.customerId === request.customerId &&
    payload.targetId === request[targetKey] && payload.snapshotSha256 === preview.expectedSnapshotSha256 && Number.isSafeInteger(payload.issuedAt) && Number.isSafeInteger(payload.expiresAt));
  const now = Date.now(), issuedAt = Number(payload.issuedAt), expiresAt = Number(payload.expiresAt);
  requirePreview(issuedAt <= now && expiresAt > now && expiresAt - issuedAt === 300_000 && new Date(expiresAt).toISOString() === preview.expiresAt);
  await check();
  return {
    input: { ...input, request: { ...request, body: { expectedSnapshotSha256: preview.expectedSnapshotSha256, proof: preview.proof } } },
    safeTarget: { kind, customerId: request.customerId, [targetKey]: request[targetKey], ...(kind === "offer"
      ? { description: preview.description, lineCount: preview.line_count, fileCount: preview.file_count }
      : { reference: preview.reference, productId: preview.product_id, price: preview.price, remarks: preview.remarks }) },
    expiresAt: preview.expiresAt,
  };
}
