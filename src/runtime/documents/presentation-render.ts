import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { validateUploadedDocument } from "@/documents/upload-validation";
import { readRegularFileWithin } from "@/security/safe-file";
import { isPng } from "@/runtime/generated-image-artifacts";

const MAX_BYTES = 50 * 1024 * 1024;
export type PresentationRenderInput = Readonly<{
  relativePath: string; fileName: string; mimeType: string; data: Buffer; sha256: string; page: number;
}>;
export type PresentationRenderCallback = (input: PresentationRenderInput) => Promise<{ pdf: Buffer; png: Buffer; pages: number }>;

export class PresentationRenderError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function reject(message: string): never { throw new PresentationRenderError("LOCAL_DOCUMENT_RENDER_INVALID", message); }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function verifySegments(root: string, relativePath: string) {
  let current = root;
  if (await realpath(root) !== root) reject("Workspace must be canonical.");
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) reject("Draft paths may not contain symbolic links.");
  }
}

async function saveImmutablePdf(root: string, sourceHash: string, pdf: Buffer) {
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const anchored = (handle: Awaited<ReturnType<typeof open>>, fallback: string) =>
    process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : fallback;
  async function verifyDirectory(handle: Awaited<ReturnType<typeof open>>, current: string) {
    const [pinned, currentStat] = await Promise.all([handle.stat(), lstat(current)]);
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink() || pinned.ino !== currentStat.ino || pinned.dev !== currentStat.dev || await realpath(current) !== current) reject("Review directory is unsafe.");
  }
  try {
    let current = root;
    let directory = await open(root, directoryFlags); handles.push(directory);
    await verifyDirectory(directory, current);
    for (const segment of [".aibrain-drafts", `render-${sourceHash}`]) {
      await verifyDirectory(directory, current);
      const child = path.join(anchored(directory, current), segment);
      await mkdir(child, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      const next = await open(child, directoryFlags); handles.push(next);
      current = path.join(current, segment);
      directory = next;
      await verifyDirectory(directory, current);
    }
    const target = path.join(anchored(directory, current), "document.pdf");
    try {
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(pdf); await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size !== pdf.length || !(await handle.readFile()).equals(pdf)) reject("Review PDF changed for this source hash.");
    } finally { await handle.close(); }
    await verifyDirectory(directory, current);
    return `.aibrain-drafts/render-${sourceHash}/document.pdf`;
  } finally { await Promise.all(handles.map((handle) => handle.close())); }
}

export async function renderPresentationDraft(argumentsValue: unknown, workspace: string, render: PresentationRenderCallback | undefined) {
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) reject("Render fields are invalid.");
  const args = argumentsValue as Record<string, unknown>;
  if (Object.keys(args).length !== 2 || typeof args.relativePath !== "string" || !Number.isSafeInteger(args.page) ||
      (args.page as number) < 1 || (args.page as number) > 50) reject("Render requires a draft path and page from 1 to 50.");
  const relativePath = args.relativePath;
  if (!/^\.aibrain-drafts\/.+\.(pptx|pdf)$/u.test(relativePath) || relativePath.length > 1024 ||
      relativePath.includes("\\") || /[\0\r\n]/u.test(relativePath) || relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) reject("Source must be a project-relative PPTX or PDF draft.");
  if (!render) throw new PresentationRenderError("LOCAL_DOCUMENT_RENDER_UNAVAILABLE", "Server presentation review is unavailable.");
  await verifySegments(workspace, relativePath);
  const data = await readRegularFileWithin(workspace, relativePath, MAX_BYTES);
  const fileName = path.basename(relativePath);
  const mimeType = relativePath.endsWith(".pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const validated = validateUploadedDocument({ fileName, declaredMimeType: mimeType, data });
  const sha256 = hash(data);
  const page = args.page as number;
  const result = await render({ relativePath, fileName, mimeType: validated.mediaType, data, sha256, page });
  if (!Number.isSafeInteger(result.pages) || result.pages < 1 || result.pages > 50 || page > result.pages) reject("Presentation page count is outside the review limit.");
  if (result.pdf.length > MAX_BYTES || !result.pdf.subarray(0, 5).equals(Buffer.from("%PDF-")) || result.png.length > 10 * 1024 * 1024 || !isPng(result.png)) reject("Server review returned invalid or oversized bytes.");
  await verifySegments(workspace, relativePath);
  if (hash(await readRegularFileWithin(workspace, relativePath, MAX_BYTES)) !== sha256) reject("Draft changed during rendering; review the current source again.");
  const reviewPdfPath = await saveImmutablePdf(workspace, sha256, result.pdf);
  return { relativePath, sha256, page, pages: result.pages, reviewPdfPath, png: result.png };
}
