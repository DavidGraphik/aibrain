import { isProviderIdentityReferenceField, isPrivateReferenceField, isPublicReference, referenceKey, type PublicReferenceEvidence } from "@/lib/public-references";

const INTERNAL_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const INTERNAL_DIGEST = /\b(?:sha256:)?[0-9a-f]{32,64}\b/giu;
const INTERNAL_BRAND = /\b(?:AiBrain|Codex(?:\s+App\s+Server)?|gpt-[a-z0-9.-]+)\b/giu;
const INTERNAL_NAMESPACE = /\b(?:aibrain|codex)[_-][a-z0-9_.:-]+\b/giu;
const INSTALLATION_REFERENCE = /\b(?:installation|instalaci[oó]n|tenant|entorno)\s*:\s*[a-z0-9][a-z0-9._-]{1,127}\b/giu;
const INSTALLATION_SLUG = /\b(?:(?:company|tenant|installation)[-_][a-z0-9._-]+|[a-z0-9._-]+-(?:qa|prod|staging|preview))\b/giu;
const FILE_URL = /\bfile:\/\/\/[^\s<>"')\]]+/giu;
const ABSOLUTE_PATH = /(?<![\w.:])\/(?:var|srv|home|Users|private|tmp|opt|etc|usr|root)(?:\/[^\s<>"'`)\]]+)+/gu;
const RUNTIME_PATH = /\b(?:runtime\/codex-home|source-ro|usersRoot|dataRoot)(?:\/[^\s<>"'`)\]]*)?/giu;
const PRIVATE_API_PATH = /\/api\/[^\s<>"'`)\]]+/giu;
const PRIVATE_FIELD_REFERENCE = /(\b([a-z][a-z0-9_-]*)["']?\s*[:=]\s*["']?)(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|(?:sha256:)?[0-9a-f]{32,64})\b/giu;

function normalizedText(value: unknown) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "\uFFFD")
    .replace(/\r\n?/gu, "\n");
}

function withoutMarkdown(value: string) {
  return value
    .replace(/```[\s\S]*?```/gu, "Comprobación interna")
    .replace(/!?\[([^\]\n]+)\]\([^)\n]+\)/gu, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s{0,3}>\s?/gmu, "")
    .replace(/\*\*([^*\n]+)\*\*/gu, "$1")
    .replace(/__([^_\n]+)__/gu, "$1")
    .replace(/~~([^~\n]+)~~/gu, "$1")
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gmu, "");
}

function redactInternalDetails(value: string, assistantName = "el asistente", evidence: PublicReferenceEvidence = {}) {
  const denied = new Set((evidence.privateReferences ?? []).filter(isPublicReference).map(referenceKey));
  const allowed = new Set((evidence.publicReferences ?? []).filter(isPublicReference).map(referenceKey));
  const identifier = (match: string) => allowed.has(referenceKey(match)) && !denied.has(referenceKey(match)) ? match : "identificador interno";
  return value
    .replace(INSTALLATION_REFERENCE, "entorno privado")
    .replace(INSTALLATION_SLUG, "entorno privado")
    .replace(FILE_URL, "archivo interno")
    .replace(ABSOLUTE_PATH, "archivo interno")
    .replace(RUNTIME_PATH, "entorno privado")
    .replace(PRIVATE_API_PATH, "ruta interna")
    .replace(PRIVATE_FIELD_REFERENCE, (match, prefix: string, field: string) => {
      const verifiedIdentity = isProviderIdentityReferenceField(field)
        && identifier(match.slice(prefix.length)) !== "identificador interno";
      return isPrivateReferenceField(field) && !verifiedIdentity ? `${prefix}identificador interno` : match;
    })
    .replace(INTERNAL_ID, identifier)
    .replace(INTERNAL_DIGEST, identifier)
    .replace(INTERNAL_NAMESPACE, "herramienta autorizada")
    .replace(INTERNAL_BRAND, assistantName);
}

/**
 * Converts model/runtime activity into employee-safe prose. This is a display
 * boundary, not an authorization boundary: it intentionally removes internal
 * brands, host paths, opaque identifiers and literal Markdown decoration.
 */
export function publicActivityText(value: unknown, maximum = 12_000, evidence: PublicReferenceEvidence = {}) {
  const publicText = withoutMarkdown(redactInternalDetails(normalizedText(value), "el asistente", evidence))
    .replace(/[ \t]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return publicText ? publicText.slice(0, maximum) : null;
}

/** Keeps useful command output reviewable without exposing its host/runtime. */
export function publicToolOutput(value: unknown, maximum = 64_000, evidence: PublicReferenceEvidence = {}) {
  return publicActivityText(value, maximum, evidence);
}

/**
 * Publish all complete lexical tokens, not only chunks ending at a boundary.
 * The last token stays private until it is complete: a UUID, host path or
 * internal namespace split across network chunks must never flash in the UI.
 * This is a sanitization boundary, not a pacing timer or a final-phase guess.
 */
export function completePublicTextPrefix(value: string) {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (/\s/u.test(value[index])) return value.slice(0, index + 1);
  }
  return "";
}

/**
 * Redacts final-answer internals while retaining Markdown and safe links.
 * Runtime artifact/API links are protected before opaque IDs are removed.
 */
export function publicAssistantText(value: unknown, assistantName: string, maximum = 128_000, evidence: PublicReferenceEvidence = {}) {
  const normalized = normalizedText(value);
  if (!normalized) return "";
  const links: string[] = [];
  const protectedText = normalized.replace(
    /https?:\/\/[^\s<>"']+|\/api\/threads\/[0-9a-f-]{36}\/artifacts\/[0-9a-f-]{36}(?:\?[^\s<>"')\]]*)?|\/g03\/apps\?id=[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:&published=1)?(?=[\s<>"'`)\]]|$)|(?<![^\s<>"'`(])\/(?:g03\/production\/preview|api\/g03\/apps\/preview)\?id=[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=[\s<>"'`)\]]|$)|\/api\/(?:projects|browser|documents)\/[^\s<>"')\]]+/giu,
    (link) => {
      const index = links.push(link) - 1;
      return `SAFEURLTOKEN${index}ENDTOKEN`;
    },
  );
  const safeName = assistantName.trim() || "el asistente";
  const redacted = redactInternalDetails(protectedText, safeName, evidence)
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n");
  return redacted.replace(/SAFEURLTOKEN(\d+)ENDTOKEN/gu, (_match, index: string) => links[Number(index)] ?? "").slice(0, maximum);
}

function contains(command: string, pattern: RegExp) {
  pattern.lastIndex = 0;
  return pattern.test(command);
}

/** Commands stay executable server-side; employees receive only their purpose. */
export function publicCommandTitle(command: unknown, running = false) {
  const alreadyPublic = publicActivityText(command, 240);
  if (alreadyPublic && /^(?:En curso: )?(?:Buscando información|Consultando archivos|Revisando archivos|Ejecutando comprobaciones|Validando el proyecto|Revisando cambios|Actualizando archivos|Procesando información)/u.test(alreadyPublic)) {
    return alreadyPublic;
  }
  const raw = normalizedText(command).toLocaleLowerCase("es");
  const prefix = running ? "En curso: " : "";
  if (contains(raw, /\b(?:rg|grep|ag)\b|buscar|search/u)) return `${prefix}Buscando información en el proyecto`;
  if (contains(raw, /\b(?:sed|cat|head|tail|less|pdftotext)\b|leer|read/u)) return `${prefix}Consultando archivos del proyecto`;
  if (contains(raw, /\b(?:ls|find|fd|tree)\b|listar|list/u)) return `${prefix}Revisando archivos del proyecto`;
  if (contains(raw, /\b(?:vitest|playwright|pytest|jest)\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/u)) return `${prefix}Ejecutando comprobaciones`;
  if (contains(raw, /\b(?:typecheck|lint|build|tsc)\b/u)) return `${prefix}Validando el proyecto`;
  if (contains(raw, /\bgit\s+(?:status|diff|log|show)\b/u)) return `${prefix}Revisando cambios del proyecto`;
  if (contains(raw, /\b(?:mkdir|cp|mv|touch|patch|apply_patch)\b/u)) return `${prefix}Actualizando archivos del proyecto`;
  return `${prefix}Procesando información en el espacio de trabajo`;
}

const TOOL_NAMES: Record<string, string> = {
  aibrain_browser: "Navegador",
  aibrain_company_files: "Archivos de empresa",
  aibrain_documents: "Documentos",
  aibrain_gmail: "Gmail",
  aibrain_outlook: "Outlook",
  aibrain_automations: "Automatizaciones",
  aibrain_memory: "Memoria",
  aibrain_g03_apps: "Aplicaciones de G03",
  aibrain_g03_production: "Producción de G03",
};

export function publicToolName(value: unknown, fallback = "Herramienta") {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  if (!normalized) return fallback;
  if (TOOL_NAMES[normalized]) return TOOL_NAMES[normalized];
  const safe = publicActivityText(normalized.replace(/[_-]+/gu, " "), 120);
  return safe && safe !== "herramienta autorizada" ? safe : fallback;
}

/** Relative project paths are useful; host paths and traversal are not. */
export function publicProjectPath(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 2_048 || value.includes("\0")) return null;
  const normalized = value.replace(/\\/gu, "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) return null;
  INTERNAL_ID.lastIndex = 0;
  RUNTIME_PATH.lastIndex = 0;
  if (INTERNAL_ID.test(normalized) || RUNTIME_PATH.test(normalized)) return null;
  INTERNAL_ID.lastIndex = 0;
  RUNTIME_PATH.lastIndex = 0;
  return normalized;
}
