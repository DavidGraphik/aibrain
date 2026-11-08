import { deploymentIdentity } from "@/deployment/identities";
import { parseConnectorReconciliationProof, type ApprovalLocator, type ConnectorDefinitiveRejectionProof, type ConnectorReconciliationProof } from "./approval-store";
import type { ChatAction } from "./trinalum-chat-actions";
import { connectorFingerprint } from "@/connectors/canonical";

export const nativeAttioActors: Readonly<Record<string, string>> = {
  [deploymentIdentity("operator")]: "David",
  [deploymentIdentity("manager")]: "Trini", [deploymentIdentity("sales")]: "Miguel", [deploymentIdentity("administration")]: "Nerea",
};
export function nativeAttioHashes(action: Pick<ChatAction, "id" | "input">, requestedBy: string) {
  const type = action.input.type;
  let request = action.input.request;
  const requestHash = connectorFingerprint({ id: action.id, type, requestedBy, request });
  if (type === "api_request") {
    const { readback: _readback, ...operation } = request as Record<string, unknown>;
    const url = new URL(String(operation.path), "https://api.attio.com"); url.searchParams.sort();
    request = { ...operation, path: url.pathname + url.search };
  }
  return { requestHash, effectHash: connectorFingerprint({ type, request }) };
}
/** Match the native operationFor routes, not model prose or payload similarity.
 * Query/body/readback cannot turn another attempt on this mutation target into
 * an independent operation. Typed tools and their generic API route share a key.
 */
const objectUuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export type NativeAttioObjectAliases = ReadonlyMap<string, string>;
/** Only an authenticated object metadata response may populate this map. */
export function checkedNativeAttioObjectAlias(value: unknown, expectedId: string): string {
  const r = value as { id?: { object_id?: unknown; workspace_id?: unknown }; api_slug?: unknown } | null;
  if (!objectUuid.test(expectedId) || !r || typeof r !== 'object' || Array.isArray(r) ||
      typeof r.id?.object_id !== 'string' || r.id.object_id.toLowerCase() !== expectedId.toLowerCase() ||
      typeof r.id.workspace_id !== 'string' || !objectUuid.test(r.id.workspace_id) ||
      typeof r.api_slug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(r.api_slug) || objectUuid.test(r.api_slug)) throw Error('ATTIO_OBJECT_ALIAS_INVALID');
  return r.api_slug;
}
export function nativeAttioObjectAlias(input: Record<string, unknown>): string | null {
  if (input.type !== 'api_request') return null;
  const request = input.request as { path?: unknown } | undefined;
  const pathname = typeof request?.path === 'string' ? request.path.split('?')[0] : '';
  if (pathname.includes('%') || pathname.includes('\\')) throw Error('ATTIO_OBJECT_ALIAS_INVALID');
  const object = /^\/objects\/([^/]+)(?:\/|$)/.exec(pathname)?.[1];
  return object && objectUuid.test(object) ? object.toLowerCase() : null;
}
function canonicalObjectPath(pathname: string, aliases: NativeAttioObjectAliases): string {
  return pathname.replace(/^\/objects\/([^/]+)(?=\/|$)/, (prefix, id: string) => {
    if (!objectUuid.test(id)) return prefix;
    const slug = aliases.get(id.toLowerCase());
    if (!slug) throw Error('ATTIO_OBJECT_ALIAS_UNRESOLVED');
    return `/objects/${slug}`;
  });
}
/** Comparison only; native hashes always retain the ORIGINAL frozen route. */
export function nativeAttioComparableEffectHash(input: Record<string, unknown>, aliases: NativeAttioObjectAliases = new Map()): string {
  if (input.type !== 'api_request') return nativeAttioHashes({id:'comparison-only',input},'scope').effectHash;
  const request = input.request as Record<string, unknown>;
  nativeAttioObjectAlias(input);
  const url = new URL(String(request.path), 'https://api.attio.com');
  const canonical = {...input,request:{...request,path:canonicalObjectPath(url.pathname,aliases)+url.search}};
  return nativeAttioHashes({id:'comparison-only',input:canonical},'scope').effectHash;
}
export function nativeAttioMutationTarget(input: Record<string, unknown>, aliases: NativeAttioObjectAliases = new Map()): string {
  const request = input.request && typeof input.request === "object" && !Array.isArray(input.request)
    ? input.request as Record<string, unknown> : {};
  let method: string, target: string;
  const records: Readonly<Record<string, string>> = { person: "people", company: "companies", deal: "deals" };
  if (input.type === "api_request") {
    nativeAttioObjectAlias(input);
    method = String(request.method ?? ""); target = canonicalObjectPath(String(request.path ?? "").split("?")[0], aliases);
  } else if (["create_person", "create_company", "create_deal"].includes(String(input.type))) {
    method = "POST"; target = `/objects/${records[String(input.type).slice(7)]}/records`;
  } else if (["update_person", "update_company", "update_deal"].includes(String(input.type))) {
    method = "PUT"; target = `/objects/${records[String(input.type).slice(7)]}/records/${encodeURIComponent(String(request.recordId ?? ""))}`;
  } else if (input.type === "create_task" || input.type === "create_note") {
    method = "POST"; target = input.type === "create_task" ? "/tasks" : "/notes";
  } else if (input.type === "update_task" || input.type === "delete_task") {
    method = input.type === "update_task" ? "PATCH" : "DELETE"; target = `/tasks/${encodeURIComponent(String(request.taskId ?? ""))}`;
  } else return `typed:${String(input.type)}`;
  // UUID case does not change the native target. Object aliases above require
  // authenticated metadata; validation of the actual request stays native-owned.
  return `${method} ${target.replace(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/gi, id => id.toLowerCase())}`;
}

export type NativeRejectionScope = {
  locator: ApprovalLocator; authorizationFingerprint: string; chatActionSha256: string;
  sourceMessageId: string; sourceTurnId: string;
};
type TrustedRejection = NativeRejectionScope & { proof: ConnectorDefinitiveRejectionProof };
const issued = new WeakMap<Error, TrustedRejection>();
/** Only the configured broker adapter calls this after strict source/binding validation. */
export function trustedNativeRejection(action: ChatAction, proof: ConnectorDefinitiveRejectionProof) {
  const error = new Error("ATTIO_VALIDATION_REJECTED");
  issued.set(error, structuredClone({ locator: action.locator, authorizationFingerprint: action.fingerprint,
    chatActionSha256: connectorFingerprint(action), sourceMessageId: action.sourceMessageId, sourceTurnId: action.sourceTurnId, proof }));
  return error;
}
export function trustedNativeRejectionDetails(error: unknown): TrustedRejection | null {
  const value = error instanceof Error ? issued.get(error) : undefined;
  return value ? structuredClone(value) : null;
}

/** Accept evidence only from the configured authenticated broker, never tool arguments. */
export function checkedNativeDisposition(value: unknown, action: ChatAction, email: string | undefined,
  category: ConnectorReconciliationProof["proofCategory"]): ConnectorReconciliationProof {
  const actor = nativeAttioActors[email?.trim().toLowerCase() ?? ""];
  const proof = parseConnectorReconciliationProof(value);
  const hashes = nativeAttioHashes(action, actor ?? "");
  if (!actor || action.operation !== "attio_action" || proof.proofCategory !== category ||
      proof.installationId !== action.installationId || proof.userId !== action.userId || proof.actionId !== action.id ||
      proof.requestedBy !== actor || proof.requestHash !== hashes.requestHash || proof.effectHash !== hashes.effectHash ||
      Date.parse(proof.checkedAt) > Date.now() || Date.parse(proof.expiresAt) <= Date.now() ||
      (proof.proofCategory === "definitive-rejection" && (Date.parse(proof.approvedAt) > Date.parse(proof.dispatchedAt) || Date.parse(proof.dispatchedAt) > Date.parse(proof.checkedAt)))) throw Error("NATIVE_DISPOSITION_BINDING_INVALID");
  return proof;
}
