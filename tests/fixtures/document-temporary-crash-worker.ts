import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseStreamingDocumentUpload } from "../../src/documents/multipart-upload";
import { DocumentPreviewService, type DocumentToolRunner } from "../../src/documents/preview-service";
import { ResourceLockManager } from "../../src/storage/resource-lock";

const [userRoot, mode] = process.argv.slice(2);
if (!userRoot || (mode !== "upload" && mode !== "preview")) {
  process.stderr.write("document-temporary-crash-worker requires user root and upload|preview mode\n");
  process.exit(64);
}

const THREAD_ID = "10000000-0000-4000-8000-000000000001";
const UPLOAD_ID = "20000000-0000-4000-8000-000000000001";
const lockManager = new ResourceLockManager({
  rootDirectory: path.join(userRoot, "state", ".locks", "documents"),
  staleAfterMs: 120,
  heartbeatIntervalMs: 25,
});

function event(name: string, extra: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ event: name, processId: process.pid, mode, ...extra })}\n`);
}

async function waitForEntry(directory: string, predicate: (name: string) => boolean) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const found = (await readdir(directory).catch(() => [] as string[])).find(predicate);
    if (found) return path.join(directory, found);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("temporary was not created");
}

async function crashDuringUpload() {
  const stagingRoot = path.join(userRoot, "staging");
  const boundary = "aibrain-crash-upload-boundary";
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="uploadId"\r\n\r\n${UPLOAD_ID}\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="partial.txt"\r\n`
    + "Content-Type: text/plain\r\n\r\npartial-body",
  );
  const request = new Request("http://localhost/upload", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(prefix);
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  void parseStreamingDocumentUpload(request, stagingRoot, lockManager);
  const incomingRoot = path.join(stagingRoot, ".incoming");
  const temporaryPath = await waitForEntry(incomingRoot, (name) => name.endsWith(".upload"));
  event("temporary-ready", { temporaryPath });
}

async function crashDuringPreview() {
  const stagingRoot = path.join(userRoot, "staging");
  const relativePath = path.posix.join("threads", THREAD_ID, "uploads", UPLOAD_ID, "input.docx");
  const source = Buffer.from("synthetic office source");
  const sourcePath = path.join(stagingRoot, relativePath);
  await mkdir(path.dirname(sourcePath), { recursive: true, mode: 0o700 });
  await writeFile(sourcePath, source, { mode: 0o600 });
  const runner: DocumentToolRunner = {
    async run() {
      await new Promise(() => { setInterval(() => undefined, 1_000); });
      return { stdout: "", stderr: "" };
    },
  };
  const previewRoot = path.join(userRoot, "state", "document-previews");
  const service = new DocumentPreviewService({
    stagingRoot,
    previewRoot,
    lockManager,
    runner,
    requireQpdf: false,
    tools: { soffice: "/synthetic/soffice", pdfinfo: "/synthetic/pdfinfo", pdftoppm: "/synthetic/pdftoppm" },
  });
  void service.create({
    schemaVersion: 1,
    uploadId: UPLOAD_ID,
    threadId: THREAD_ID,
    fileName: "input.docx",
    relativePath,
    kind: "docx",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: source.length,
    sha256: createHash("sha256").update(source).digest("hex"),
    status: "staged",
    createdAt: new Date().toISOString(),
  });
  const previewDirectory = path.join(previewRoot, THREAD_ID, UPLOAD_ID);
  const temporaryPath = await waitForEntry(previewDirectory, (name) => name.startsWith(".work-"));
  event("temporary-ready", { temporaryPath });
}

async function main() {
  if (mode === "upload") await crashDuringUpload();
  else await crashDuringPreview();
  await new Promise(() => { setInterval(() => undefined, 1_000); });
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
