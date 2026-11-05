import { createHash } from "node:crypto";
import { getSession } from "@/auth/session";
import { resolveGeneratedDocumentResource } from "@/library/server-resource-access";
import { contentDisposition, libraryResourceErrorResponse } from "@/library/http";
import { readRegularFileWithin } from "@/security/safe-file";
import { isUuid } from "@/workbench/types";
import { OUTLOOK_ATTACHMENT_MAXIMUM } from "@/runtime/outlook-desktop-files";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const fail = (status: number) => Response.json({ error: "Archivo no disponible." }, { status, headers: { "Cache-Control": "private, no-store" } });
export async function GET(_request: Request, context: { params: Promise<{ threadId: string; artifactId: string }> }) {
  const session = await getSession(); if (!session) return fail(401);
  const { threadId, artifactId } = await context.params;
  if (!isUuid(threadId) || !isUuid(artifactId)) return fail(400);
  try {
    const { installation, location } = await resolveGeneratedDocumentResource(session, { artifactId, threadId });
    if (installation.installationId !== "g03-production" || location.storageOwnerId !== session.user.id ||
      !location.relativePath?.startsWith(`outlook-desktop-files/${session.user.id}/${artifactId}/`)) return fail(404);
    const bytes = await readRegularFileWithin(installation.paths.dataRoot, location.relativePath, OUTLOOK_ATTACHMENT_MAXIMUM);
    if (bytes.length !== location.size || createHash("sha256").update(bytes).digest("hex") !== location.sha256) return fail(409);
    return new Response(bytes, { headers: { "Content-Type": location.mediaType, "Content-Length": String(bytes.length),
      "Content-Disposition": contentDisposition(location.fileName, "attachment"), "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; sandbox" } });
  } catch (error) { return libraryResourceErrorResponse(error, "Archivo no encontrado.") ?? fail(404); }
}
