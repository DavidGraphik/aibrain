import { createHash } from "node:crypto";
import path from "node:path";
import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { documentServicesForUser } from "@/documents/server-service";
import { prepareWorkspaceDocumentPage, prepareWorkspaceDocumentPreview } from "@/documents/workspace-preview";
import { prepareWorkbookGrid } from "@/documents/workbook-grid";
import { contentDisposition, libraryResourceErrorResponse } from "@/library/http";
import { resolveGeneratedDocumentResource } from "@/library/server-resource-access";
import { readRegularFileWithin } from "@/security/safe-file";
import { isUuid } from "@/workbench/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAXIMUM_DOCUMENT_BYTES = 50 * 1024 * 1024;
const SUPPORTED_MEDIA_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

function privateJson(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ threadId: string; artifactId: string }> },
) {
  const session = await getSession();
  if (!session) return privateJson("No autenticado.", 401);
  const { threadId, artifactId } = await context.params;
  if (!isUuid(threadId) || !isUuid(artifactId)) return privateJson("Documento no válido.", 400);
  const url = new URL(request.url);
  const preview = url.searchParams.get("preview") === "1";
  const download = url.searchParams.get("download") === "1";
  const grid = url.searchParams.get("grid") === "1";
  const rawPage = url.searchParams.get("page");
  const page = rawPage === null ? null : Number(rawPage);
  if ([...url.searchParams.keys()].some((key) => key !== "preview" && key !== "download" && key !== "grid" && key !== "page") ||
      url.searchParams.getAll("preview").length > 1 || url.searchParams.getAll("download").length > 1 ||
      url.searchParams.getAll("grid").length > 1 || url.searchParams.getAll("page").length > 1 ||
      (url.searchParams.has("preview") && !preview) || (url.searchParams.has("download") && !download) ||
      (url.searchParams.has("grid") && !grid) || Number(preview) + Number(download) + Number(grid) !== 1 ||
      (page !== null && (!preview || !Number.isSafeInteger(page) || page < 1 || page > 500))) {
    return privateJson("Consulta no válida.", 400);
  }

  let resource: Awaited<ReturnType<typeof resolveGeneratedDocumentResource>>;
  try {
    resource = await resolveGeneratedDocumentResource(session, { artifactId, threadId });
  } catch (error) {
    const resourceError = libraryResourceErrorResponse(error, "Documento no encontrado.");
    return resourceError ?? privateJson("Documento no encontrado.", 404);
  }
  try {
    const location = resource.location;
    if (!location.relativePath || !SUPPORTED_MEDIA_TYPES.has(location.mediaType) ||
        path.basename(location.relativePath) !== location.fileName ||
        !location.relativePath.startsWith(`generated-document-artifacts/${location.storageOwnerId}/${artifactId}/`)) {
      return privateJson("Documento no encontrado.", 404);
    }
    const contents = await readRegularFileWithin(resource.installation.paths.dataRoot, location.relativePath, MAXIMUM_DOCUMENT_BYTES);
    if (contents.byteLength !== location.size || createHash("sha256").update(contents).digest("hex") !== location.sha256) {
      return privateJson("El documento ya no coincide con su registro.", 409);
    }
    if (download) {
      return new Response(contents, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Disposition": contentDisposition(location.fileName, "attachment"),
          "Content-Length": String(contents.byteLength),
          "Content-Type": location.mediaType,
          "Cross-Origin-Resource-Policy": "same-origin",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (grid) {
      if (location.mediaType !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
        return privateJson("Este documento no es un libro Excel.", 400);
      }
      const services = await documentServicesForUser(resource.installation, location.storageOwnerId);
      const spreadsheet = await services.conversionGate.run(
        () => prepareWorkbookGrid({ fileName: location.fileName, data: contents, signal: request.signal }),
        { signal: request.signal },
      );
      return NextResponse.json(spreadsheet, { headers: {
        "Cache-Control": "private, no-store",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      } });
    }

    const services = await documentServicesForUser(resource.installation, location.storageOwnerId);
    const conversion = {
      services,
      projectId: location.projectId,
      relativePath: location.relativePath,
      fileName: location.fileName,
      declaredMimeType: location.mediaType,
      data: contents,
      signal: request.signal,
    };
    if (page !== null) {
      const rendered = await prepareWorkspaceDocumentPage({ ...conversion, page });
      return new Response(rendered.data, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Disposition": contentDisposition(`${location.fileName}-page-${page}.png`, "inline"),
          "Content-Length": String(rendered.data.byteLength),
          "Content-Type": "image/png",
          "X-Document-Page-Count": String(rendered.pages),
          "Cross-Origin-Resource-Policy": "same-origin",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    const rendered = await prepareWorkspaceDocumentPreview(conversion);
    return new Response(rendered.data, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": contentDisposition(`${location.fileName}.pdf`, "inline"),
        "Content-Length": String(rendered.data.byteLength),
        "Content-Type": "application/pdf",
        "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      },
    });
  } catch (error) {
    return privateJson("No se ha podido abrir este documento.", 422);
  }
}
