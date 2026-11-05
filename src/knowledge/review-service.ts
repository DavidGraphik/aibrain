import "server-only";
import { randomUUID } from "node:crypto";
import type { AuthSession } from "@/auth/types";
import { FileLocalUserStore } from "@/auth/local-user-store";
import { loadInstallationConfig } from "@/config/installation";
import { workspacePolicyForIdentity } from "@/admin/policy-service";
import { resolveProjectAccess } from "@/workbench/shared-access";
import { resolveServerTurnPermissions } from "@/runtime/permission-turn";
import { EnterpriseDocumentNetwork } from "@/documents/enterprise-document-network";
import { KnowledgeReviewTransport } from "./review-transport";
import { audience, UUID, type KnowledgeAudience, type KnowledgeReviewCommand } from "./review-contract";

export class KnowledgeReviewError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
async function context(session: AuthSession, projectId: string) {
  if (session.provider !== "local" || !UUID.test(session.user.id) || !UUID.test(projectId)) throw new KnowledgeReviewError("REVIEW_IDENTITY_DENIED", 403);
  const installation = await loadInstallationConfig();
  if (installation.installationId !== session.tenant.id) throw new KnowledgeReviewError("REVIEW_TENANT_DENIED", 403);
  const user = await new FileLocalUserStore(installation.paths.usersRoot).read(session.user.id);
  if (!user?.enabled) throw new KnowledgeReviewError("REVIEW_IDENTITY_DENIED", 403);
  const policy = await workspacePolicyForIdentity(installation.installationId, session.user.id, installation);
  if (!policy.role.canManageWorkspace || !policy.policy.capabilities.consult) throw new KnowledgeReviewError("REVIEW_ROLE_REQUIRED", 403);
  // Shared access is resolved before any foreign project or document store read.
  const project = await resolveProjectAccess(session, projectId);
  const permissions = await resolveServerTurnPermissions(installation, { installationId: installation.installationId, userId: session.user.id, projectId, turnId: randomUUID() });
  const network = new EnterpriseDocumentNetwork(installation);
  const roots = await network.rootsForTurn({ userId: session.user.id, projectId, departmentIds: policy.groups.map((g) => g.id), permissions });
  const scopes = roots.map((root) => ({ scope: root.scope, scopeId: root.scopeId,
    label: root.scope === "company" ? "Empresa" : root.scope === "private" ? "Tu espacio privado" : root.scope === "project" ? "Este proyecto" : policy.groups.find((g) => g.id === root.scopeId)?.name ?? "Departamento",
    // Review changes derived knowledge, never the read-only source documents.
    canReview: policy.policy.capabilities.publish && (root.scope !== "project" || project.role !== "viewer") }));
  return { network, roots, scopes };
}
export async function listKnowledgeReviews(session: AuthSession, input: KnowledgeAudience & { projectId: string; status: "proposed" | "confirmed"; cursor: number; connectionId?: string }) {
  const resolved = await context(session, input.projectId);
  if (!audience(input) || !resolved.scopes.some((s) => s.scope === input.scope && s.scopeId === input.scopeId)) throw new KnowledgeReviewError("REVIEW_SCOPE_DENIED", 403);
  const result = await new KnowledgeReviewTransport(resolved.network).call(resolved.roots, session.user.id, { scope: input.scope, scopeId: input.scopeId }, "list", { status: input.status, cursor: input.cursor }, input.connectionId);
  return { ...result, scopes: resolved.scopes };
}
export async function knowledgeReviewScopes(session: AuthSession, projectId: string) {
  return { scopes: (await context(session, projectId)).scopes };
}
export async function reviewKnowledge(session: AuthSession, input: KnowledgeReviewCommand) {
  const resolved = await context(session, input.projectId);
  if (!resolved.scopes.some((s) => s.scope === input.scope && s.scopeId === input.scopeId && s.canReview)) throw new KnowledgeReviewError("REVIEW_SCOPE_DENIED", 403);
  const result = await new KnowledgeReviewTransport(resolved.network).call(resolved.roots, session.user.id, { scope: input.scope, scopeId: input.scopeId }, input.decision === "correct" ? "correct" : "review",
    input.decision === "correct" ? { recordId: input.recordId, revision: input.revision, content: input.content, reason: input.reason } :
      { recordId: input.recordId, revision: input.revision, decision: input.decision }, input.connectionId);
  if (!result.available && ["CORRECTION_UNCHANGED", "INVALID_KNOWLEDGE_TEXT"].includes(result.error ?? "")) throw new KnowledgeReviewError(result.error!, 400);
  if (!result.available) throw new KnowledgeReviewError(result.error === "REVISION_CONFLICT" ? "REVISION_CONFLICT" : "REVIEW_UNAVAILABLE", result.error === "REVISION_CONFLICT" ? 409 : 503);
  return result;
}
