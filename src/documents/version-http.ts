import path from "node:path";
import type { StoredDocumentVersion, VersionedDocument } from "@/documents/version-store";
import { quotedDocumentEtag } from "@/documents/version-store";

export function versionPreviewFile(version: StoredDocumentVersion) {
  if (version.kind === "text" || version.kind === "audio") return "preview.txt";
  if (version.kind === "image") return `preview${path.extname(version.fileName).toLowerCase()}`;
  return "document.pdf";
}

export function publicVersionedDocument(document: VersionedDocument) {
  const prefix = `/api/threads/${document.threadId}/documents/${document.documentId}`;
  return {
    documentId: document.documentId,
    threadId: document.threadId,
    title: document.title,
    scope: document.scope,
    originalVersionId: document.originalVersionId,
    latestVersionId: document.latestVersionId,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    versions: document.versions.map((version) => ({
      versionId: version.versionId,
      number: version.number,
      etag: version.etag,
      fileName: version.fileName,
      kind: version.kind,
      mediaType: version.mediaType,
      size: version.size,
      sha256: version.sha256,
      author: version.author,
      createdAt: version.createdAt,
      provenance: version.provenance,
      downloadUrl: `${prefix}/versions/${version.versionId}`,
      previewUrl: `${prefix}/versions/${version.versionId}/preview/${encodeURIComponent(versionPreviewFile(version))}`,
    })),
  };
}

export function documentVersionJson(document: VersionedDocument, status = 200) {
  const latest = document.versions.at(-1)!;
  return Response.json({ document: publicVersionedDocument(document) }, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      ETag: quotedDocumentEtag(latest.etag),
    },
  });
}
