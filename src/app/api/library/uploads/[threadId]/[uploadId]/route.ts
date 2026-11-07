import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { documentServicesForUser } from "@/documents/server-service";
import { contentDisposition, libraryResourceErrorResponse } from "@/library/http";
import { resolveThreadLibraryResource } from "@/library/server-resource-access";
import { readRegularFileWithin } from "@/security/safe-file";
import { StorageError } from "@/storage";
import { isUuid } from "@/workbench/types";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ threadId: string; uploadId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const { threadId, uploadId } = await context.params;
  if (!isUuid(threadId) || !isUuid(uploadId)) {
    return NextResponse.json({ error: "Archivo no válido." }, { status: 400 });
  }
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => key !== "inline") || params.getAll("inline").length > 1 ||
      (params.has("inline") && params.get("inline") !== "1")) {
    return NextResponse.json({ error: "Consulta no válida." }, { status: 400 });
  }
  try {
    const resource = await resolveThreadLibraryResource(session, {
      kind: "upload",
      resourceId: uploadId,
      threadId,
    });
    const thread = resource.access.thread;
    const attachment = thread.messages.flatMap((message) => message.attachments)
      .find((candidate) => candidate.id === uploadId);
    if (!attachment) return NextResponse.json({ error: "Archivo no encontrado." }, { status: 404 });
    const services = await documentServicesForUser(resource.installation, resource.location.storageOwnerId);
    const resolved = await services.staging.resolveContentById(threadId, uploadId);
    if (resolved.document.fileName !== attachment.name || resolved.document.mediaType !== attachment.mimeType ||
        resolved.document.size !== attachment.size ||
        resolved.document.fileName !== resource.location.fileName ||
        resolved.document.mediaType !== resource.location.mediaType ||
        resolved.document.size !== resource.location.size ||
        resolved.document.sha256 !== resource.location.sha256 ||
        resolved.document.relativePath !== resource.location.relativePath) {
      return NextResponse.json({ error: "El archivo ya no coincide con su registro." }, { status: 409 });
    }
    const contents = await readRegularFileWithin(
      services.staging.rootDirectory,
      resolved.document.relativePath,
      50 * 1024 * 1024,
    );
    if (contents.byteLength !== resource.location.size ||
        createHash("sha256").update(contents).digest("hex") !== resource.location.sha256) {
      return NextResponse.json({ error: "El archivo ya no coincide con su registro." }, { status: 409 });
    }
    const inline = params.get("inline") === "1";
    return new Response(new Uint8Array(contents), {
      headers: {
        "Content-Type": resolved.document.mediaType,
        "Content-Length": String(contents.byteLength),
        "Content-Disposition": contentDisposition(resolved.document.fileName, inline ? "inline" : "attachment"),
        "Cache-Control": "private, no-store",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        ...(inline ? { "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'unsafe-inline'" } : {}),
      },
    });
  } catch (error) {
    const resourceError = libraryResourceErrorResponse(error, "Archivo no encontrado.");
    if (resourceError) return resourceError;
    if (error instanceof StorageError) {
      return NextResponse.json({ error: "Archivo no encontrado." }, { status: 404 });
    }
    return NextResponse.json({ error: "Archivo no encontrado." }, { status: 404 });
  }
}
