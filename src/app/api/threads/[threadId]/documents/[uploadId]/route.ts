import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { loadInstallationConfig } from "@/config/installation";
import { documentServicesForUser } from "@/documents/server-service";
import { documentVersionJson } from "@/documents/version-http";
import { StorageError } from "@/storage";
import { isUuid } from "@/workbench/types";
import { libraryResourceErrorResponse } from "@/library/http";
import { resolveThreadLibraryResource } from "@/library/server-resource-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ threadId: string; uploadId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  const { threadId, uploadId } = await context.params;
  if (!isUuid(threadId) || !isUuid(uploadId)) {
    return NextResponse.json({ error: "Documento no válido." }, { status: 400 });
  }
  try {
    const installation = await loadInstallationConfig();
    if (session.provider !== "local" || session.tenant.id !== installation.installationId) {
      return NextResponse.json({ error: "La sesión no pertenece a esta instalación." }, { status: 403 });
    }
    const resource = await resolveThreadLibraryResource(session, {
      kind: "upload",
      resourceId: uploadId,
      threadId,
    });
    const services = await documentServicesForUser(installation, resource.location.storageOwnerId);
    return documentVersionJson(await services.versions.read(threadId, uploadId));
  } catch (error) {
    const resourceError = libraryResourceErrorResponse(error, "Documento no encontrado.");
    if (resourceError) return resourceError;
    if (error instanceof StorageError || (error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      return NextResponse.json({ error: "Documento no encontrado." }, { status: 404 });
    }
    return NextResponse.json({ error: "No se ha podido leer el historial del documento." }, { status: 404 });
  }
}
