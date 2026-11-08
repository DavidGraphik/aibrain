import "server-only";
import { createHash } from "node:crypto";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import { documentServicesForUser } from "@/documents/server-service";
import { DocumentPreviewService } from "@/documents/preview-service";
import { validateUploadedDocument } from "@/documents/upload-validation";

/** Convert the authorized bytes, never database rows or a model-supplied PDF. */
export async function renderReviewedSchedulePdf(installation: Readonly<InstallationConfig>, userId: string, threadId: string, data: Buffer, fileName: string) {
  const validated = validateUploadedDocument({ fileName, declaredMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data });
  if (validated.kind !== "xlsx") throw new Error("Cal un Excel .xlsx per preparar el PDF revisat.");
  const services = await documentServicesForUser(installation, userId);
  // Dedicated identities keep print PDFs separate from whole-sheet previews,
  // inside the conversion root already allowed by the production sandbox.
  const key = createHash("sha256").update(`horaria-print-v1:${threadId}:${validated.sha256}`).digest("hex");
  const uploadId = `${key.slice(0, 8)}-${key.slice(8, 12)}-5${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
  return services.storageGate.run(async () => {
    const staged = await services.staging.stage({ threadId, uploadId, validated: { ...validated, fileName: "reviewed.xlsx" }, data });
    const previews = new DocumentPreviewService({
      stagingRoot: services.manifest.roots.staging,
      previewRoot: path.join(services.manifest.roots.userRoot, "state", "document-previews"),
      lockManager: services.locks, tools: services.toolchain, conversionGate: services.conversionGate,
      spreadsheetLayout: "print",
    });
    const preview = await previews.create(staged);
    if (preview.sourceSha256 !== validated.sha256 || preview.pages !== 1) throw new Error("El PDF de la plantilla ha de conservar una única pàgina d’impressió. No s’ha preparat cap enviament.");
    const pdf = await previews.readFile(threadId, uploadId, "document.pdf");
    if (pdf.length > 4 * 1024 * 1024) throw new Error("El PDF revisat supera el límit de mida.");
    return pdf;
  });
}
