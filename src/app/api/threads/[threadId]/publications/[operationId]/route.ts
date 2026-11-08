import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { loadInstallationConfig } from "@/config/installation";
import { isDecidePublicationRequest } from "@/documents/publication-api-contract";
import { publicationDecisionError } from "@/documents/publication-http";
import { documentPublisherForUser } from "@/documents/server-service";
import { resolveServerTurnPermissions } from "@/runtime/permission-turn";
import { StorageError } from "@/storage";
import { workbenchErrorResponse } from "@/workbench/http";
import { getThread, getThreadRuntimeContext } from "@/workbench/store";
import { isUuid } from "@/workbench/types";
import { libraryResourceErrorResponse } from "@/library/http";
import { assertLibraryResourceWritable } from "@/library/server-resource-access";
import { resolveThreadAccess } from "@/workbench/shared-access";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ threadId: string; operationId: string }> };

function mayPublish(rules: readonly { ruleId: string; action: string; effect: string }[]) {
  const explicit = rules.find((rule) => rule.ruleId === "documents.publish");
  return explicit?.action === "publish" && explicit.effect === "allow" &&
    !rules.some((rule) => rule.action === "publish" && rule.effect === "deny");
}

export async function POST(request: Request, context: RouteContext) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const { threadId, operationId } = await context.params;
  const body: unknown = await request.json().catch(() => null);
  if (!isUuid(threadId) || !isUuid(operationId) || !isDecidePublicationRequest(body)) {
    return NextResponse.json({ error: "La decisió de publicació no és vàlida." }, { status: 400 });
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
    let permissionFingerprint: string | null = null;
    let publicationPermissions: Awaited<ReturnType<typeof resolveServerTurnPermissions>> | undefined;
    if (body.action === "confirm") {
      const permissions = await resolveServerTurnPermissions(installation, {
        installationId: installation.installationId,
        userId: session.user.id,
        projectId: threadContext.projectId,
        turnId: body.turnId,
      });
      if (!mayPublish(permissions.rules)) {
        return NextResponse.json({ error: "PERMISSIONS.md no autoritza aquesta publicació." }, { status: 403 });
      }
      permissionFingerprint = permissions.fingerprint;
      publicationPermissions = permissions;
    }
    const publisher = await documentPublisherForUser(installation, session.user.id,
      { projectId: threadContext.projectId, permissions: publicationPermissions });
    const input = {
      operationId,
      clientRequestId: body.clientRequestId,
      threadId,
      turnId: body.turnId,
      confirmationToken: body.confirmationToken,
    };
    const operation = body.action === "confirm"
      ? await publisher.confirm(input)
      : await publisher.decline(input);
    return NextResponse.json({ operation, permissionFingerprint });
  } catch (error) {
    const resourceError = libraryResourceErrorResponse(error, "Publicación no encontrada.");
    if (resourceError) return resourceError;
    if (error instanceof StorageError) return publicationDecisionError(error);
    return workbenchErrorResponse(error, "No s’ha pogut verificar la decisió de publicació.");
  }
}
