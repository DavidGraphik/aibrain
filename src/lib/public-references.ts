/** Display evidence only. A record reference grants no access to the record. */
export const MAX_PUBLIC_REFERENCES = 2_048;
const OPAQUE_REFERENCE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|(?:sha256:)?[0-9a-f]{32,64})$/iu;
const OPAQUE_REFERENCES = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|(?:sha256:)?[0-9a-f]{32,64})\b/giu;
const REFERENCE_FIELD = /^(?:ids?|uuids?|identifiers?|references?|refs?|codes?|[a-z0-9]+(?:ids?|uuids?)|checksums?|digests?|sha256|sha1|md5)$/u;
const PRIVATE_FIELD = /token|secret|password|credential|authorization|cookie|lease|session|fingerprint|runtime|thread|turn|project|installation|tenant|workspace|user|employee|permission|auth|audit|transport|trace|requestid|call|candidate|build|revision|sourcesha|publicreferences|memory|conversation|automation|metadata|internal|interno|private|debug|diagnostic|profile|connector|catalog|chatgpt|codex|aibrain/iu;
const UNVERIFIED_FIELD = /^(?:input|arguments|parameters|request|prompt|instructions?|examples?|schema)$/u;

const PROVIDER_IDENTITY_CONTAINER = /^(?:user|member|workspacemember|workspace|account|organization|organisation)$/u;

/** External identity IDs may be public only when observed in a completed
 * provider result. A matching spelling alone never supplies display evidence. */
export function isProviderIdentityReferenceField(value: string) {
  return /^(?:user|member|workspacemember|workspace|account|organization|organisation)(?:id|uuid)$/u
    .test(value.toLowerCase().replace(/[^a-z0-9]/gu, ""));
}

export function isPrivateReferenceField(value: string) {
  return PRIVATE_FIELD.test(value.toLowerCase().replace(/[^a-z0-9]/gu, ""));
}

export type PublicReferenceEvidence = {
  publicReferences?: readonly string[];
  privateReferences?: readonly string[];
};

export function isPublicReference(value: unknown): value is string {
  return typeof value === "string" && value.length <= 71 && OPAQUE_REFERENCE.test(value);
}

export function referenceKey(value: string) {
  return value.toLowerCase().replace(/^sha256:/u, "");
}

export function validPublicReferences(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_PUBLIC_REFERENCES && value.every(isPublicReference)
    && new Set(value.map(referenceKey)).size === value.length;
}

/** Only server-produced, completed tool evidence is useful during display and
 * durable reload. Older messages simply have no exemptions. */
export function publicReferencesForResults(results: readonly { status: string; publicReferences?: unknown }[] | undefined) {
  const values = new Map<string, string>();
  for (const result of results ?? []) {
    if (result.status !== "complete" || !validPublicReferences(result.publicReferences)) continue;
    for (const reference of result.publicReferences) values.set(referenceKey(reference), reference);
    if (values.size > MAX_PUBLIC_REFERENCES) return [];
  }
  return [...values.values()];
}

function structuredPayload(value: unknown, providerText = false): unknown {
  if (typeof value !== "string") return value;
  if (value.length > 1_048_576) throw new Error("Reference evidence exceeds its limit.");
  try { return JSON.parse(value); } catch {
    // Native providers also return bounded key:value records. Do not accept
    // prose, duplicate/ambiguous keys, multiline values or arbitrary tool text.
    if (!providerText || value.length > 64_000) return null;
    const lines = value.replace(/\r\n?/gu, "\n").trim().split("\n");
    if (!lines.length || lines.length > 128) return null;
    const fields: Record<string, string> = Object.create(null);
    const seen = new Set<string>();
    for (const line of lines) {
      const match = /^([A-Za-z][A-Za-z0-9_[\]-]{0,127}):[ \t]*(.*)$/u.exec(line);
      if (!match || /[\u0000-\u001f\u007f]/u.test(match[2])) return null;
      const normalized = match[1].toLowerCase().replace(/[^a-z0-9]/gu, "");
      if (!normalized || seen.has(normalized)) return null;
      seen.add(normalized); fields[match[1]] = match[2].trim();
    }
    return fields;
  }
}

/** Extract before display sanitization, exclusively from successful structured or strictly parsed
 * native provider records. Free prose, command output and provider-declared allowlists
 * cannot authorize a reference. Private branches veto the same value elsewhere. */
export function observedToolPublicReferences(item: Record<string, unknown>, completed: boolean, privateReferences: readonly string[] = []) {
  if (!(item.status === "completed" || item.status === undefined && completed)
      || item.error || item.success === false) return [];
  const payloads: unknown[] = [];
  const nativeProvider = item.type === "mcpToolCall";
  if (item.type === "dynamicToolCall") {
    if (item.success !== true || item.namespace === "aibrain_browser") return [];
    if (Array.isArray(item.contentItems)) {
      for (const entry of item.contentItems) {
        if (entry && typeof entry === "object" && "type" in entry && entry.type === "inputText" && "text" in entry) payloads.push((entry as { text: unknown }).text);
      }
    }
  } else if (item.type === "mcpToolCall") {
    const result = item.result;
    if (!result || typeof result !== "object" || Array.isArray(result) || "isError" in result && result.isError === true) return [];
    if ("structuredContent" in result) payloads.push(result.structuredContent);
    if ("content" in result && Array.isArray(result.content)) {
      for (const entry of result.content) {
        if (entry && typeof entry === "object" && "type" in entry && entry.type === "text" && "text" in entry) payloads.push(entry.text);
      }
    }
  } else return [];
  const denied = new Set(privateReferences.filter(isPublicReference).map(referenceKey));
  const candidates = new Map<string, string>();
  let nodes = 0;
  const walk = (value: unknown, field: string, hidden: boolean, depth: number, unverified = false) => {
    if (++nodes > 20_000 || depth > 20) throw new Error("Reference evidence exceeds its limit.");
    if (typeof value === "string") {
      if (hidden) {
        for (const match of value.matchAll(OPAQUE_REFERENCES)) denied.add(referenceKey(match[0]));
      } else if (!unverified && REFERENCE_FIELD.test(field) && isPublicReference(value)) candidates.set(referenceKey(value), value);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) walk(item, field, hidden, depth + 1, unverified); return; }
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
      const providerIdentity = nativeProvider && (isProviderIdentityReferenceField(normalized)
        || PROVIDER_IDENTITY_CONTAINER.test(normalized) && child !== null && typeof child === "object");
      walk(child, normalized, hidden || isPrivateReferenceField(normalized) && !providerIdentity,
        depth + 1, unverified || UNVERIFIED_FIELD.test(normalized));
    }
  };
  try {
    for (const raw of payloads) {
      const payload = structuredPayload(raw, nativeProvider);
      if (!payload || typeof payload !== "object") continue;
      if (!Array.isArray(payload) && ("success" in payload && payload.success !== true
          || "ok" in payload && payload.ok !== true || "isError" in payload && payload.isError !== false
          || "error" in payload && payload.error)) return [];
      // Bound already structured payloads too, rather than trusting native JSON.
      if (JSON.stringify(payload).length > 1_048_576) return [];
      walk(payload, "", false, 0);
    }
    if (candidates.size > MAX_PUBLIC_REFERENCES) return [];
    return [...candidates].filter(([key]) => !denied.has(key)).map(([, value]) => value);
  } catch { return []; }
}
