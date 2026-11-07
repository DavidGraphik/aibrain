import { createHash } from "node:crypto";
import path from "node:path";
import type { DocumentArtifact } from "@/lib/chat-contract";
import { generatedDocumentArtifactId, persistGeneratedDocumentArtifact,
  type GeneratedDocumentArtifactContext } from "@/runtime/generated-document-artifacts";

const MAX_ORIGINAL_BYTES = 16 * 1024 * 1024;

/** Only accepts bytes returned by the already turn-authorized readOriginal broker. */
export async function createServerPdfArtifact(result: Record<string, unknown>, context: GeneratedDocumentArtifactContext): Promise<DocumentArtifact | null> {
  if (result.available !== true || result.scope !== "company" || result.sourceChecked !== true ||
      typeof result.path !== "string" || !/^server-[a-z0-9-]+\/.+\.pdf$/i.test(result.path) || result.path.includes("?") ||
      typeof result.checkedAt !== "string" || !Number.isFinite(Date.parse(result.checkedAt)) ||
      Math.abs(Date.now() - Date.parse(result.checkedAt)) > 5 * 60_000 ||
      typeof result.base64 !== "string" || result.base64.length > Math.ceil(MAX_ORIGINAL_BYTES / 3) * 4 ||
      !Number.isSafeInteger(result.size) || Number(result.size) < 1 || Number(result.size) > MAX_ORIGINAL_BYTES ||
      typeof result.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(result.sha256)) return null;
  const contents = Buffer.from(result.base64, "base64");
  if (contents.length !== result.size || contents.toString("base64") !== result.base64 ||
      createHash("sha256").update(contents).digest("hex") !== result.sha256) throw new Error("Server original identity changed");
  let name = decodeURIComponent(result.path.split("/").at(-1)!);
  if (name !== path.basename(name) || /[\\/\u0000-\u001f\u007f]/u.test(name)) throw new Error("Server original filename is unsafe");
  if (name.length > 120) name = `${name.slice(0, 103)}-${result.sha256.slice(0, 8)}.pdf`;
  const artifactId = generatedDocumentArtifactId(context.messageId, `server-original/${result.path}\0${result.sha256}`);
  return persistGeneratedDocumentArtifact({ artifactId, relativePath: name, contents, pages: null, context });
}
