import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_MULTIPART_BYTES,
  parseStreamingDocumentUpload,
} from "@/documents/multipart-upload";
import { documentUploadTemporaryLockKey } from "@/documents/maintenance";
import { ResourceLockManager } from "@/storage/resource-lock";

const BOUNDARY = "aibrain-streaming-boundary";
const UPLOAD_ID = "22222222-2222-4222-8222-222222222222";

function requestFromStream(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  return new Request("http://localhost/upload", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body: stream,
    signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function prefix() {
  return Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="uploadId"\r\n\r\n${UPLOAD_ID}\r\n`
    + `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\n`
    + "Content-Type: text/plain\r\n\r\n",
  );
}

function incomingFiles(root: string) {
  return readdir(path.join(root, ".incoming")).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
}

describe("streaming multipart document intake", () => {
  let root: string;
  let locks: ResourceLockManager;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aibrain-multipart-"));
    locks = new ResourceLockManager({ rootDirectory: path.join(root, ".locks") });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("streams a chunked upload to a private disposable file", async () => {
    const chunks = [prefix(), Buffer.from("streamed notes"), Buffer.from(`\r\n--${BOUNDARY}--\r\n`)];
    const parsed = await parseStreamingDocumentUpload(requestFromStream(new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    })), root, locks);

    expect(parsed).toMatchObject({
      uploadId: UPLOAD_ID,
      fileName: "notes.txt",
      declaredMimeType: "text/plain",
      size: 14,
    });
    expect(await readFile(parsed.temporaryPath, "utf8")).toBe("streamed notes");
    await expect(new ResourceLockManager({ rootDirectory: path.join(root, ".locks") }).acquire(
      documentUploadTemporaryLockKey(parsed.temporaryPath),
      { timeoutMs: 0 },
    )).rejects.toMatchObject({ code: "STORAGE_LOCK_TIMEOUT" });
    await parsed.dispose();
    await expect(incomingFiles(root)).resolves.toEqual([]);
  });

  it("rejects oversized chunked bodies without Content-Length and cleans the partial file", async () => {
    const header = prefix();
    const closing = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    const request = requestFromStream(new ReadableStream({
      pull(controller) {
        if (sent === 0) {
          controller.enqueue(header);
        } else if (sent < Math.ceil(MAX_MULTIPART_BYTES / chunk.length) + 2) {
          controller.enqueue(chunk);
        } else {
          controller.enqueue(closing);
          controller.close();
        }
        sent += 1;
      },
    }));
    expect(request.headers.has("content-length")).toBe(false);
    await expect(parseStreamingDocumentUpload(request, root, locks)).rejects.toMatchObject({
      code: "UPLOAD_SIZE_INVALID",
    });
    await expect(incomingFiles(root)).resolves.toEqual([]);
  });

  it("preserves UTF-8 browser filenames without changing uploaded bytes", async () => {
    const fileName = "VALRESA_CLIENTES_Joel_González_ñ_客户.xlsx";
    const bytes = Buffer.from("unchanged original workbook bytes");
    const header = Buffer.from(prefix().toString().replace('filename="notes.txt"', `filename="${fileName}"`));
    const chunks = [header, bytes, Buffer.from(`\r\n--${BOUNDARY}--\r\n`)];
    const parsed = await parseStreamingDocumentUpload(requestFromStream(new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    })), root, locks);
    expect(parsed.fileName).toBe(fileName);
    expect(await readFile(parsed.temporaryPath)).toEqual(bytes);
    await parsed.dispose();
    await expect(incomingFiles(root)).resolves.toEqual([]);
  });

  it("rejects malformed multipart and removes its partial temporary", async () => {
    const chunks = [prefix(), Buffer.from("unterminated")];
    await expect(parseStreamingDocumentUpload(requestFromStream(new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    })), root, locks)).rejects.toMatchObject({ code: "UPLOAD_MULTIPART_INVALID" });
    await expect(incomingFiles(root)).resolves.toEqual([]);
  });

  it("rejects an invalid boundary before acquiring a temporary lease", async () => {
    const request = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=" },
      body: Buffer.from("invalid"),
    });
    await expect(parseStreamingDocumentUpload(request, root, locks)).rejects.toMatchObject({
      code: "UPLOAD_MULTIPART_INVALID",
    });
    await expect(readdir(path.join(root, ".locks")).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      throw error;
    })).resolves.toEqual([]);
  });

  it("rejects any third part instead of accepting fields beyond uploadId and file", async () => {
    const body = Buffer.concat([
      prefix(),
      Buffer.from("notes\r\n"),
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="extra"\r\n\r\nnope\r\n`),
      Buffer.from(`--${BOUNDARY}--\r\n`),
    ]);
    await expect(parseStreamingDocumentUpload(requestFromStream(new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    })), root, locks)).rejects.toMatchObject({ code: "UPLOAD_MULTIPART_CONTRACT_INVALID" });
    await expect(incomingFiles(root)).resolves.toEqual([]);
  });

  it("aborts an incomplete request early and removes its partial temporary", async () => {
    const abort = new AbortController();
    let sentHeader = false;
    const request = requestFromStream(new ReadableStream({
      pull(controller) {
        if (!sentHeader) {
          sentHeader = true;
          controller.enqueue(prefix());
          setTimeout(() => abort.abort(), 0);
        }
      },
    }), abort.signal);
    await expect(parseStreamingDocumentUpload(request, root, locks)).rejects.toMatchObject({ code: "UPLOAD_ABORTED" });
    await expect(incomingFiles(root)).resolves.toEqual([]);
  });

  it("keeps the route free of whole-body FormData and File buffering APIs", async () => {
    const route = await readFile(
      path.join(process.cwd(), "src/app/api/threads/[threadId]/documents/route.ts"),
      "utf8",
    );
    expect(route).not.toContain(".formData(");
    expect(route).not.toContain(".arrayBuffer(");
    expect(route).toContain("parseStreamingDocumentUpload");
    expect(route).toContain("validateUploadedDocumentFile");
    expect(route).toContain("stageFile");
  });
});
