import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { g03ProductInstallation } from "@/g03-products/contracts";
import { G03_PRODUCT_TOOLS, g03ProductInstructions } from "@/g03-products/chat-tools";
import { G03_SAGE_DYNAMIC_TOOLS } from "./g03-sage-tool-contract";
import { CONVERSATION_ATTACHMENT_DYNAMIC_TOOLS, G03_HISTORICAL_PDF_TOOLS } from './conversation-attachment-contract';
import { TRINALUM_DYNAMIC_TOOLS } from "./trinalum-tool-contract";
import { TRINALUM_WORKFLOW_INSTRUCTIONS } from "./trinalum-workflows";
import { SUPPORT_DYNAMIC_TOOLS, SUPPORT_INSTRUCTIONS } from "./support-tool-contract";
import { getSigningSecret } from "@/auth/session";
import { DOCUMENT_DYNAMIC_TOOLS } from "./documents/dynamic-tool-contract";

const THREAD_TOKEN_SECONDS = 60 * 60 * 24 * 30;

/**
 * Dynamic tools are fixed when App Server creates a thread.  A resumable
 * thread issued before this revision cannot acquire the current tools on a
 * later `thread/resume`. The chat route bootstraps its durable history into a
 * fresh runtime, including follow-ups without any connector keywords.
 */
// nc marks the retired computer-use catalog; keep signed legacy identities within 127 characters.
const supportToolsetDigest = createHash("sha256")
  .update(JSON.stringify({ tools: SUPPORT_DYNAMIC_TOOLS, instructions: SUPPORT_INSTRUCTIONS }))
  .digest("hex").slice(0, 16);
// v2 removes installation-wide Composio discovery from native-only users.
export const CURRENT_THREAD_TOOLSET_REVISION = `aibrain-tools-2026-11-05-nc-${supportToolsetDigest}-native-v2`;

// The schema is immutable inside Codex threads. Derive this compatibility
// identity from the shipped catalog AND instructions so a new operation or
// changed guidance cannot silently retain a manually versioned older catalog.
// The public chat/history and authenticated turn permissions remain unchanged.
const g03ProductToolsetDigest = createHash("sha256")
  .update(JSON.stringify({ tools: G03_PRODUCT_TOOLS, instructions: g03ProductInstructions, conversationAndSourcePdfRevision: 1, sageTools: G03_SAGE_DYNAMIC_TOOLS, documentTools: DOCUMENT_DYNAMIC_TOOLS, historicalPdfTools:G03_HISTORICAL_PDF_TOOLS }))
  .digest("hex").slice(0, 32);

// Historical identity: accepted signed tokens remain readable, but this
// catalog cannot safely resume after customer-tariff tools/guidance changed.
export const TRINALUM_CREATE_ONLY_AUTOMATION_TOOLSET_REVISION = `${CURRENT_THREAD_TOOLSET_REVISION}-trinalum-natural-v4-mail-customer-notes`;

// Bind compatibility to the actual pure catalog and product-owned guidance,
// so future operations/schema/instruction edits refresh existing chats too.
const trinalumToolsetDigest = createHash("sha256")
  .update(JSON.stringify({ tools: TRINALUM_DYNAMIC_TOOLS, instructions: TRINALUM_WORKFLOW_INSTRUCTIONS, historicalAttachments: CONVERSATION_ATTACHMENT_DYNAMIC_TOOLS }))
  .digest("hex").slice(0, 32);
export const CURRENT_TRINALUM_THREAD_TOOLSET_REVISION = `${CURRENT_THREAD_TOOLSET_REVISION}-trinalum-${trinalumToolsetDigest}`;

export function currentThreadToolsetRevision(installationId?: string) {
  if (installationId === "modtime") return `${CURRENT_THREAD_TOOLSET_REVISION}-modtime-file-requests-v1`;
  if (installationId === "trinalum-production") return CURRENT_TRINALUM_THREAD_TOOLSET_REVISION;
  return installationId && g03ProductInstallation(installationId) ? `${CURRENT_THREAD_TOOLSET_REVISION}-g03-${g03ProductToolsetDigest}` : CURRENT_THREAD_TOOLSET_REVISION;
}

type ThreadPayload = {
  version: 3;
  tenantId: string;
  userId: string;
  threadId: string;
  toolsetRevision: string | null;
  expiresAt: number;
};

export type RuntimeThreadTokenContext = {
  threadId: string;
  toolsetRevision: string | null;
};

export function toolsetRevisionForIssuedThreadToken(
  resumedThreadId: string | null,
  resumedThreadToolsetRevision: string | null,
  installationId?: string,
) {
  return resumedThreadId
    ? resumedThreadToolsetRevision
    : currentThreadToolsetRevision(installationId);
}

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function signature(value: string) {
  return createHmac("sha256", getSigningSecret())
    .update(`thread:${value}`)
    .digest("base64url");
}

function matches(received: string, expected: string) {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function issueThreadToken(
  tenantId: string,
  userId: string,
  threadId: string,
  toolsetRevision: string | null = currentThreadToolsetRevision(tenantId),
) {
  if (!/^[a-z0-9-]{2,63}$/.test(tenantId) ||
      !USER_ID_PATTERN.test(userId) || !THREAD_ID_PATTERN.test(threadId)) {
    throw new Error("Thread token binding is invalid.");
  }
  const payload: ThreadPayload = {
    version: 3,
    tenantId,
    userId,
    threadId,
    toolsetRevision,
    expiresAt: Date.now() + THREAD_TOKEN_SECONDS * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(encoded)}`;
}

export function readThreadTokenContext(
  token: string,
  tenantId: string,
  userId: string,
): RuntimeThreadTokenContext | null {
  if (token.length > 2_048 || !USER_ID_PATTERN.test(userId)) return null;
  const [encoded, receivedSignature, extra] = token.split(".");
  if (!encoded || !receivedSignature || extra || !matches(receivedSignature, signature(encoded))) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!value || typeof value !== "object") return null;
    if (!("version" in value) || (value.version !== 2 && value.version !== 3)) return null;
    if (!("tenantId" in value) || value.tenantId !== tenantId) return null;
    if (!("userId" in value) || value.userId !== userId) return null;
    if (!("threadId" in value) || typeof value.threadId !== "string" ||
        !THREAD_ID_PATTERN.test(value.threadId)) return null;
    if (!("expiresAt" in value) || typeof value.expiresAt !== "number" || value.expiresAt <= Date.now()) return null;
    if (value.version === 2) {
      return {
        threadId: value.threadId,
        toolsetRevision: null,
      };
    }
    if (!("toolsetRevision" in value) ||
        (value.toolsetRevision !== null && (
          typeof value.toolsetRevision !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.toolsetRevision)
        ))) return null;
    return { threadId: value.threadId, toolsetRevision: value.toolsetRevision };
  } catch {
    return null;
  }
}

export function readThreadToken(token: string, tenantId: string, userId: string) {
  return readThreadTokenContext(token, tenantId, userId)?.threadId ?? null;
}
