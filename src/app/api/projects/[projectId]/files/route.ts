import { createHash } from "node:crypto";
import path from "node:path";
import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { loadInstallationConfig } from "@/config/installation";
import { contentDisposition, libraryResourceErrorResponse } from "@/library/http";
import { resolveProjectLibraryResource } from "@/library/server-resource-access";
import { DocumentConversionBackpressureError } from "@/documents/conversion-gate";
import { documentServicesForUser } from "@/documents/server-service";
import { UploadValidationError, validateUploadedDocument } from "@/documents/upload-validation";
import { prepareWorkspaceDocumentPreview } from "@/documents/workspace-preview";
import { prepareWorkbookGrid } from "@/documents/workbook-grid";
import { deriveWorkerRoots, resolveWorkerOwnedPath } from "@/runtime/workers/provisioner";
import { readRegularFileWithin } from "@/security/safe-file";
import { StorageError } from "@/storage";
import { getProjectRuntimeContext } from "@/workbench/store";
import { isUuid } from "@/workbench/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAXIMUM_TEXT_FILE_BYTES = 8_000_000;
const MAXIMUM_BINARY_FILE_BYTES = 50 * 1024 * 1024;
const MAXIMUM_TEXT_BYTES = 500_000;
const PDF_SIGNATURE = Buffer.from("%PDF-");

function privateJson(body: Record<string, unknown>, status: number, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "private, no-store");
  return NextResponse.json(body, { status, headers: responseHeaders });
}

const officeMimeTypes: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const imageMimeTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const textLanguages: Record<string, string> = {
  ".css": "CSS",
  ".go": "Go",
  ".html": "HTML",
  ".java": "Java",
  ".js": "JavaScript",
  ".jsx": "JSX",
  ".json": "JSON",
  ".kt": "Kotlin",
  ".md": "Markdown",
  ".py": "Python",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".scss": "SCSS",
  ".sh": "Shell",
  ".sql": "SQL",
  ".swift": "Swift",
  ".toml": "TOML",
  ".ts": "TypeScript",
  ".tsx": "TSX",
  ".txt": "Texto",
  ".xml": "XML",
  ".yaml": "YAML",
  ".yml": "YAML",
};

function previewType(filePath: string) {
  const extension = path.extname(filePath).toLocaleLowerCase();
  const imageMimeType = imageMimeTypes[extension];
  if (imageMimeType) return { kind: "image" as const, mimeType: imageMimeType, language: null };
  if (extension === ".pdf") return { kind: "pdf" as const, mimeType: "application/pdf", language: null };
  const officeMimeType = officeMimeTypes[extension];
  if (officeMimeType) return { kind: "office" as const, mimeType: officeMimeType, language: null };
  return {
    kind: "text" as const,
    mimeType: extension === ".json" ? "application/json" : "text/plain",
    language: textLanguages[extension] ?? "Texto",
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const session = await getSession();
  if (!session) return privateJson({ error: "No autenticado." }, 401);
  const { projectId } = await context.params;
  if (!isUuid(projectId)) return privateJson({ error: "Proyecto no válido." }, 400);

  const url = new URL(request.url);
  const filePath = url.searchParams.get("path");
  const raw = url.searchParams.get("raw") === "1";
  const download = url.searchParams.get("download") === "1";
  const representation = url.searchParams.get("representation") === "1";
  const grid = url.searchParams.get("grid") === "1";
  const resourceId = url.searchParams.get("resourceId");
  if (
    [...url.searchParams.keys()].some((key) => key !== "path" && key !== "raw" && key !== "download" && key !== "representation" && key !== "grid" && key !== "resourceId") ||
    url.searchParams.getAll("path").length !== 1 ||
    url.searchParams.getAll("raw").length > 1 ||
    url.searchParams.getAll("download").length > 1 ||
    url.searchParams.getAll("representation").length > 1 ||
    url.searchParams.getAll("grid").length > 1 ||
    url.searchParams.getAll("resourceId").length > 1 ||
    (url.searchParams.has("raw") && url.searchParams.get("raw") !== "1") ||
    (url.searchParams.has("download") && url.searchParams.get("download") !== "1") ||
    (url.searchParams.has("representation") && url.searchParams.get("representation") !== "1") ||
    (url.searchParams.has("grid") && url.searchParams.get("grid") !== "1") ||
    (download && !raw) ||
    (representation && (raw || download)) ||
    (grid && (raw || download || representation)) ||
    (resourceId !== null && !isUuid(resourceId)) ||
    !filePath || filePath.length > 2_048 || filePath.includes("\0")
  ) {
    return privateJson({ error: "Ruta no válida." }, 400);
  }

  try {
    const installation = await loadInstallationConfig();
    if (session.provider !== "local" || installation.installationId !== session.tenant.id) {
      return privateJson({ error: "La sesión no pertenece a esta instalación." }, 403);
    }
    const indexedResource = resourceId
      ? await resolveProjectLibraryResource(session, { kind: "workspace-file", resourceId, projectId })
      : null;
    const runtimeProjectId = indexedResource
      ? indexedResource.access.project.id
      : (await getProjectRuntimeContext(session, projectId)).projectId;
    const roots = deriveWorkerRoots(installation, indexedResource?.location.storageOwnerId ?? session.user.id);
    const projectWorkspace = await resolveWorkerOwnedPath(
      roots.workspace,
      path.posix.join("projects", runtimeProjectId),
    );
    const workspaceRelativePath = path.isAbsolute(filePath)
      ? path.relative(projectWorkspace, filePath)
      : filePath;
    const preview = previewType(filePath);
    const normalizedRelativePath = path.normalize(workspaceRelativePath).split(path.sep).join("/");
    if (normalizedRelativePath === ".aibrain" || normalizedRelativePath.startsWith(".aibrain/")) {
      return privateJson({ error: "Archivo no encontrado." }, 404);
    }
    if (indexedResource && (
      indexedResource.location.relativePath !== normalizedRelativePath ||
      indexedResource.location.mediaType !== preview.mimeType
    )) {
      return privateJson({ error: "Archivo no encontrado." }, 404);
    }
    const contents = await readRegularFileWithin(
      projectWorkspace,
      workspaceRelativePath,
      preview.kind === "text" ? MAXIMUM_TEXT_FILE_BYTES : MAXIMUM_BINARY_FILE_BYTES,
    );
    if (indexedResource && (
      contents.byteLength !== indexedResource.location.size ||
      createHash("sha256").update(contents).digest("hex") !== indexedResource.location.sha256
    )) {
      return privateJson({ error: "El archivo ya no coincide con su registro." }, 409);
    }

    const encodedPath = encodeURIComponent(filePath);
    const resourceSuffix = resourceId ? `&resourceId=${resourceId}` : "";
    const rawUrl = `/api/projects/${projectId}/files?path=${encodedPath}&raw=1${resourceSuffix}`;
    const downloadUrl = `${rawUrl}&download=1`;

    if (grid) {
      if (preview.mimeType !== officeMimeTypes[".xlsx"]) {
        return privateJson({ error: "Este archivo no es un libro Excel." }, 400);
      }
      const services = await documentServicesForUser(installation, session.user.id);
      const spreadsheet = await services.conversionGate.run(
        () => prepareWorkbookGrid({ fileName: path.basename(filePath), data: contents, signal: request.signal }),
        { signal: request.signal },
      );
      return privateJson(spreadsheet, 200, {
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
    }

    if (representation) {
      if (preview.kind !== "office") {
        return privateJson({ error: "Este formato no necesita una representación convertida." }, 400);
      }
      const services = await documentServicesForUser(installation, session.user.id);
      const converted = await prepareWorkspaceDocumentPreview({
        services,
        projectId,
        relativePath: workspaceRelativePath.split(path.sep).join("/"),
        fileName: path.basename(filePath),
        declaredMimeType: preview.mimeType,
        data: contents,
        signal: request.signal,
      });
      return new Response(new Uint8Array(converted.data), {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Disposition": contentDisposition(`${path.basename(filePath)}.pdf`, "inline"),
          "Content-Length": String(converted.data.byteLength),
          "Content-Type": "application/pdf",
          "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        },
      });
    }

    if (raw) {
      let responseContents = contents;
      if (preview.kind === "text" && !download) {
        return privateJson({ error: "Este archivo se muestra como texto." }, 400);
      }
      if (preview.kind === "pdf" && !contents.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
        return privateJson({ error: "El archivo no es un PDF válido." }, 415);
      }
      if (preview.kind === "pdf" && !download) {
        // Old chat artifacts point directly at this URL. Normalize a private
        // representation, never rewrite the original or bypass its index hash.
        const services = await documentServicesForUser(installation, session.user.id);
        const converted = await prepareWorkspaceDocumentPreview({
          services, projectId, relativePath: normalizedRelativePath,
          fileName: path.basename(filePath), declaredMimeType: preview.mimeType,
          data: contents, signal: request.signal,
        });
        responseContents = converted.data;
      }
      if (preview.kind === "office") {
        try {
          validateUploadedDocument({
            fileName: path.basename(filePath),
            declaredMimeType: preview.mimeType,
            data: contents,
          });
        } catch (error) {
          if (error instanceof UploadValidationError) {
            return privateJson({ error: "El archivo Office no supera la validación segura." }, 415);
          }
          throw error;
        }
      }
      return new Response(responseContents, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Disposition": contentDisposition(path.basename(filePath), download ? "attachment" : "inline"),
          "Content-Type": preview.mimeType,
          ...(download ? {} : { "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'" }),
          "Cross-Origin-Resource-Policy": "same-origin",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          // The authenticated client fetches this response into a blob before
          // previewing it. Keeping the original response non-frameable avoids
          // turning a private document URL into an embeddable resource.
          "X-Frame-Options": "DENY",
        },
      });
    }

    if (preview.kind !== "text") {
      if (preview.kind === "office") {
        try {
          validateUploadedDocument({
            fileName: path.basename(filePath),
            declaredMimeType: preview.mimeType,
            data: contents,
          });
        } catch (error) {
          if (error instanceof UploadValidationError) {
            return privateJson({ error: "El archivo Office no supera la validación segura." }, 415);
          }
          throw error;
        }
      }
      const previewUrl = preview.kind === "office"
        ? `/api/projects/${projectId}/files?path=${encodedPath}&representation=1${resourceSuffix}`
        : rawUrl;
      return privateJson({
        file: {
          path: filePath,
          name: path.basename(filePath),
          kind: preview.kind,
          mimeType: preview.mimeType,
          size: contents.length,
          language: null,
          content: null,
          previewUrl,
          previewMimeType: preview.kind === "office" ? "application/pdf" : preview.mimeType,
          downloadUrl,
        },
      }, 200);
    }

    if (contents.length > MAXIMUM_TEXT_BYTES) {
      return privateJson({ error: "El archivo es demasiado grande para mostrarlo dentro del chat." }, 413);
    }
    if (contents.includes(0)) {
      return privateJson({ error: "Este formato no admite una vista previa segura." }, 415);
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    } catch {
      return privateJson({ error: "Este formato no admite una vista previa segura." }, 415);
    }
    return privateJson({
      file: {
        path: filePath,
        name: path.basename(filePath),
        kind: preview.kind,
        mimeType: preview.mimeType,
        size: contents.length,
        language: preview.language,
        content,
        previewUrl: null,
        previewMimeType: "text/plain",
        downloadUrl,
      },
    }, 200);
  } catch (error) {
    const resourceError = libraryResourceErrorResponse(error, "Archivo no encontrado.");
    if (resourceError) return resourceError;
    if (error instanceof UploadValidationError) {
      return privateJson({ error: "Este formato no admite una vista previa segura." }, 415);
    }
    if (error instanceof DocumentConversionBackpressureError) {
      return privateJson(
        { error: "La vista previa está ocupada. Vuelve a intentarlo en unos segundos.", state: "retryable" },
        503,
        { "Retry-After": String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))) },
      );
    }
    if (error instanceof StorageError && error.code === "DOCUMENT_OPERATION_ABORTED") {
      return privateJson({ error: "La conversión de la vista previa se ha cancelado.", state: "cancelled" }, 408);
    }
    if (error instanceof StorageError && error.code === "DOCUMENT_TOOL_TIMEOUT") {
      return privateJson({ error: "La conversión de la vista previa ha agotado su tiempo.", state: "failed" }, 504);
    }
    if (error instanceof StorageError && [
      "DOCUMENT_TOOL_FAILED",
      "DOCUMENT_TOOL_OUTPUT_TOO_LARGE",
      "DOCUMENT_PREVIEW_TOO_LARGE",
      "WORKSPACE_DOCUMENT_PREVIEW_INVALID",
    ].includes(error.code)) {
      return privateJson({ error: "No se ha podido crear una vista previa segura.", state: "failed" }, 422);
    }
    return privateJson({ error: "No se ha podido abrir este archivo del proyecto." }, 404);
  }
}
