import { NextResponse } from "next/server";
import { operationalLogger } from "@/operations/server-logger";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { loadInstallationConfig } from "@/config/installation";
import { isFreezePublicationRequest } from "@/documents/publication-api-contract";
import {
  documentPublisherForUser,
  documentServicesForUser,
} from "@/documents/server-service";
import { resolveServerTurnPermissions } from "@/runtime/permission-turn";
import { StorageError } from "@/storage";
import { workbenchErrorResponse } from "@/workbench/http";
import { getThread, getThreadRuntimeContext } from "@/workbench/store";
import { isUuid } from "@/workbench/types";
import { libraryResourceErrorResponse } from "@/library/http";
import { assertLibraryResourceWritable } from "@/library/server-resource-access";
import { resolveThreadAccess } from "@/workbench/shared-access";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ threadId: string }> };

function mayPublish(rules: readonly { ruleId: string; action: string; effect: string }[]) {
  const explicit = rules.find((rule) => rule.ruleId === "documents.publish");
  return explicit?.action === "publish" && explicit.effect === "allow" &&
    !rules.some((rule) => rule.action === "publish" && rule.effect === "deny");
}

function publicationErrorResponse(error: unknown) {
  const code = error instanceof StorageError ? error.code : "PUBLICATION_UNAVAILABLE";
  operationalLogger.warn("publication.freeze_rejected", { code });
  if (code.includes("CONFLICT") || code === "PUBLICATION_TARGET_PARENT_MISSING") {
    return NextResponse.json({ error: "El candidat o destí ha canviat i cal revisar-lo." }, { status: 409 });
  }
  if (code.includes("INVALID") || code.includes("MISMATCH") || code.includes("UNSAFE")) {
    return NextResponse.json({ error: "La petició de publicació no és segura." }, { status: 400 });
  }
  return NextResponse.json({ error: "No s’ha pogut congelar el candidat." }, { status: 503 });
}

export async function POST(request: Request, context: RouteContext) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const { threadId } = await context.params;
  const body: unknown = await request.json().catch(() => null);
  if (!isUuid(threadId) || !isFreezePublicationRequest(body)) {
    return NextResponse.json({ error: "La petició de publicació no és vàlida." }, { status: 400 });
  }

  try {
    assertLibraryResourceWritable(await resolveThreadAccess(session, threadId));
    const [threadContext, thread, installation] = await Promise.all([
      getThreadRuntimeContext(session, threadId),
      getThread(session, threadId),
      loadInstallationConfig(),
    ]);
    if (session.provider !== "local" || session.tenant.id !== installation.installationId) {
      return NextResponse.json({ error: "La sessió no pertany a aquesta instal·lació." }, { status: 403 });
    }
    if (!thread.messages.some((message) => message.id === body.turnId && message.role === "assistant")) {
      return NextResponse.json({ error: "El torn de publicació no pertany al fil." }, { status: 403 });
    }
    const permissions = await resolveServerTurnPermissions(installation, {
      installationId: installation.installationId,
      userId: session.user.id,
      projectId: threadContext.projectId,
      turnId: body.turnId,
    });
    if (!mayPublish(permissions.rules)) {
      return NextResponse.json({ error: "PERMISSIONS.md no autoritza aquesta publicació." }, { status: 403 });
    }

    const services = await documentServicesForUser(installation, session.user.id);
    const document = await services.staging.readById(threadId, body.uploadId);
    const preview = await services.previews.read(threadId, body.uploadId);
    if (preview.sourceSha256 !== document.sha256 || preview.status !== "ready") {
      return NextResponse.json({ error: "El preview ja no correspon al candidat." }, { status: 409 });
    }
    const publisher = await documentPublisherForUser(installation, session.user.id, { projectId: threadContext.projectId, permissions });
    const frozen = await publisher.freezeCandidate({
      operationId: body.operationId,
      clientRequestId: body.clientRequestId,
      threadId,
      turnId: body.turnId,
      candidateRelativePath: document.relativePath,
      targetRelativePath: body.targetRelativePath,
      preview: {
        schemaVersion: 1,
        previewId: body.uploadId,
        threadId,
        turnId: body.turnId,
        candidateSha256: preview.sourceSha256,
        status: "ready",
        artifacts: preview.files,
        createdAt: preview.createdAt,
      },
    });
    return NextResponse.json({
      operation: frozen.operation,
      confirmationToken: frozen.confirmationToken,
      permissionFingerprint: permissions.fingerprint,
    }, { status: 201 });
  } catch (error) {
    const resourceError = libraryResourceErrorResponse(error, "Publicación no encontrada.");
    if (resourceError) return resourceError;
    if (error instanceof StorageError) return publicationErrorResponse(error);
    return workbenchErrorResponse(error, "No s’ha pogut verificar la publicació.");
  }
}

/** Reattach private G03 confirmations after refresh without dispatching effects. */
export async function GET(_request: Request, context: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const { threadId } = await context.params;
  if (!isUuid(threadId)) return NextResponse.json({ error: "Fil no vàlid." }, { status: 400 });
  try {
    assertLibraryResourceWritable(await resolveThreadAccess(session, threadId));
    const installation = await loadInstallationConfig();
    if (session.provider !== "local" || session.tenant.id !== installation.installationId) {
      return NextResponse.json({ error: "Instal·lació no autoritzada." }, { status: 403 });
    }
    if (!["g03-production", "g03-qa"].includes(installation.installationId) || process.env.AIBRAIN_G03_PUBLICATION_ENABLED !== "true") {
      return NextResponse.json({ publications: [] }, { headers: { "Cache-Control": "no-store" } });
    }
    const threadContext = await getThreadRuntimeContext(session, threadId);
    // No source access is granted here. Every future confirmation re-resolves policy.
    const publisher = await documentPublisherForUser(installation, session.user.id, { projectId: threadContext.projectId });
    const publications = "recoverThread" in publisher ? await publisher.recoverThread(threadId) : [];
    return NextResponse.json({ publications }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const resourceError = libraryResourceErrorResponse(error, "Publicación no encontrada.");
    if (resourceError) return resourceError;
    return workbenchErrorResponse(error, "No s’han pogut recuperar les publicacions.");
  }
}
