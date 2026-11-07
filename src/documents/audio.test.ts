import { chmod, link, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { oggOpusFixture, repairOggChecksum } from "../../tests/helpers/ogg-opus-fixture";
import { inspectOggOpus, MAX_AUDIO_BYTES } from "./audio-validation";
import { validateUploadedDocument, validateUploadedDocumentFile } from "./upload-validation";
import { DocumentPreviewService, type DocumentToolRunner } from "./preview-service";
import { FileDocumentStagingStore } from "./staging-store";
import { FileDocumentConversionGate } from "./conversion-gate";
import { ResourceLockManager } from "@/storage/resource-lock";
import { ServerTurnDocumentInputResolver } from "./turn-attachments";
import { transcribeAudio } from "./audio-transcription";

const THREAD = "11111111-1111-4111-8111-111111111111";
const UPLOAD = "22222222-2222-4222-8222-222222222222";
const tools = { soffice: "/tools/soffice", pdfinfo: "/tools/pdfinfo", pdftoppm: "/tools/pdftoppm", ffprobe: "/tools/ffprobe", audioTranscriber: "/tools/transcribe" };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() {
  const created = await mkdtemp(path.join(process.cwd(), ".audio-test-"));
  roots.push(created); return created;
}
function validate(data = oggOpusFixture(), fileName = "voice.ogg", declaredMimeType = "audio/ogg") {
  return validateUploadedDocument({ data, fileName, declaredMimeType });
}
class Runner implements DocumentToolRunner {
  calls: string[] = [];
  transcript = "Synthetic test transcript only";
  probe = { streams: [{ codec_type: "audio", codec_name: "opus", channels: 1, sample_rate: "48000" }], format: { format_name: "ogg", duration: "1.0" } };
  async run(command: string) {
    this.calls.push(command);
    return { stdout: command === tools.ffprobe ? JSON.stringify(this.probe) : this.transcript, stderr: "" };
  }
}

describe("original Ogg Opus admission", () => {
  it.each(["audio/ogg", "audio/opus", "application/ogg", "application/octet-stream", ""])("requires bytes even for browser MIME %s", (mime) => {
    expect(validate(undefined, "voice.ogg", mime)).toMatchObject({ kind: "audio", mediaType: "audio/ogg" });
  });
  it("accepts a complete mobile recording without an EOS marker", () => {
    const data = oggOpusFixture(); const last = data.subarray(91); last[5] = 0; repairOggChecksum(last);
    expect(validate(data)).toMatchObject({ kind: "audio" });
  });
  it("rejects a renamed document, mismatched MIME and traversal", () => {
    expect(() => validate(Buffer.from("pretend audio"))).toThrow();
    expect(() => validate(undefined, "voice.txt")).toThrow();
    expect(() => validate(undefined, "voice.ogg", "image/png")).toThrow();
    expect(() => validate(undefined, "../voice.ogg")).toThrow();
  });
  it("rejects oversized, truncated, corrupt, chained and non-Opus files", () => {
    const data = oggOpusFixture();
    expect(() => inspectOggOpus(Buffer.alloc(MAX_AUDIO_BYTES + 1))).toThrow();
    expect(() => inspectOggOpus(data.subarray(0, -1))).toThrow();
    expect(() => inspectOggOpus(Buffer.concat([data, data]))).toThrow();
    const corrupt = Buffer.from(data); corrupt[corrupt.length - 1] ^= 1;
    expect(() => inspectOggOpus(corrupt)).toThrow();
    const differentCodec = Buffer.from(data); differentCodec.write("vorbis", 28); repairOggChecksum(differentCodec.subarray(0, 47));
    expect(() => inspectOggOpus(differentCodec)).toThrow();
  });
  it("rejects foreign streams, sequence changes and excess duration even with valid checksums", () => {
    for (const offset of [14, 18, 6]) {
      const data = oggOpusFixture();
      const last = data.subarray(91);
      if (offset === 6) last.writeBigUInt64LE(48000n * 1900n, offset);
      else last.writeUInt32LE(500, offset);
      repairOggChecksum(last);
      expect(() => inspectOggOpus(data)).toThrow();
    }
  });
  it("accepts a private file and rejects public files, symlinks and hardlinks", async () => {
    const directory = await root(); const filePath = path.join(directory, "voice.ogg");
    await writeFile(filePath, oggOpusFixture(), { mode: 0o600 });
    const input = { fileName: "voice.ogg", declaredMimeType: "audio/ogg", filePath };
    expect(await validateUploadedDocumentFile(input)).toMatchObject({ sha256: validate().sha256 });
    if (typeof process.getuid === "function") {
      const owner = process.getuid(); const spy = vi.spyOn(process, "getuid").mockReturnValue(owner + 1);
      try { await expect(validateUploadedDocumentFile(input)).rejects.toMatchObject({ code: "UPLOAD_SOURCE_UNSAFE" }); }
      finally { spy.mockRestore(); }
    }
    await chmod(filePath, 0o644); await expect(validateUploadedDocumentFile(input)).rejects.toMatchObject({ code: "UPLOAD_SOURCE_UNSAFE" });
    await chmod(filePath, 0o600); const alias = path.join(directory, "alias");
    await symlink(filePath, alias); await expect(validateUploadedDocumentFile({ ...input, filePath: alias })).rejects.toMatchObject({ code: "UPLOAD_SOURCE_UNSAFE" });
    await link(filePath, path.join(directory, "hard")); await expect(validateUploadedDocumentFile(input)).rejects.toMatchObject({ code: "UPLOAD_SOURCE_UNSAFE" });
  });
});

describe("bounded transcription and original persistence", () => {
  async function fixture(runner: DocumentToolRunner = new Runner()) {
    const directory = await root(); const stagingRoot = path.join(directory, "staging");
    const locks = new ResourceLockManager({ rootDirectory: path.join(directory, "locks") });
    const staging = new FileDocumentStagingStore(stagingRoot, locks);
    const document = await staging.stage({ threadId: THREAD, uploadId: UPLOAD, validated: validate(), data: oggOpusFixture() });
    const service = new DocumentPreviewService({ stagingRoot, previewRoot: path.join(directory, "previews"), lockManager: locks, tools, runner,
      audioGate: new FileDocumentConversionGate({ rootDirectory: path.join(directory, "audio-gate"), maxConcurrent: 1 }), requireQpdf: false });
    return { directory, stagingRoot, staging, document, service };
  }
  it("preserves the exact original and attests one private transcript, reused without rerunning", async () => {
    const runner = new Runner(); const f = await fixture(runner);
    const preview = await f.service.create(f.document);
    expect(preview).toMatchObject({ kind: "audio", sourceSha256: f.document.sha256, files: ["preview.txt"], pages: null });
    expect(await f.service.create(f.document)).toEqual(preview); expect(runner.calls).toEqual([tools.ffprobe, tools.audioTranscriber]);
    expect(await readFile(path.join(f.stagingRoot, f.document.relativePath))).toEqual(oggOpusFixture());
    const transcriptPath = path.join(f.service.previewRoot, THREAD, UPLOAD, "preview.txt");
    expect((await lstat(transcriptPath)).mode & 0o777).toBe(0o600);
    const resolver = new ServerTurnDocumentInputResolver({ stagingRoot: f.stagingRoot, previews: f.service, pdftotext: "/tools/pdftotext" });
    expect(await resolver.resolve(f.document)).toMatchObject([{ type: "text", text: expect.stringContaining("UNTRUSTED ATTACHMENT") }]);
    expect(await resolver.resolve(f.document)).toMatchObject([{ text: expect.stringContaining(runner.transcript) }]);
    await expect(resolver.resolve({ ...f.document, sha256: "f".repeat(64) })).rejects.toThrow();
    await writeFile(transcriptPath, "tampered", { mode: 0o600 });
    await expect(f.service.read(THREAD, UPLOAD)).rejects.toMatchObject({ code: "DOCUMENT_PREVIEW_INTEGRITY_FAILED" });
  });
  it("enforces one active audio conversion across separate owner preview stores and recovers the slot", async () => {
    let release!: () => void; let started!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const active = new Promise<void>((resolve) => { started = resolve; });
    const runner = new Runner();
    const first = await fixture({ run: async (command) => {
      if (command === tools.audioTranscriber) { started(); await hold; }
      return runner.run(command);
    } });
    const secondRunner = new Runner(); const second = await fixture(secondRunner);
    const sharedSecond = new DocumentPreviewService({ stagingRoot: second.stagingRoot,
      previewRoot: second.service.previewRoot, lockManager: new ResourceLockManager({ rootDirectory: path.join(second.directory, "other-locks") }),
      tools, runner: secondRunner, requireQpdf: false,
      audioGate: new FileDocumentConversionGate({ rootDirectory: path.join(first.directory, "audio-gate"), maxConcurrent: 1 }) });
    const running = first.service.create(first.document); await active;
    try {
      await expect(sharedSecond.create(second.document)).rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_BACKPRESSURE" });
      expect(secondRunner.calls).toEqual([]);
    } finally { release(); await running; }
    await expect(sharedSecond.create(second.document)).resolves.toMatchObject({ kind: "audio", status: "ready" });
  });
  it.each(["", "\0bad", "x".repeat(1024 * 1024 + 1)])("returns no ready preview for unusable output (%#)", async (transcript) => {
    const runner = new Runner(); runner.transcript = transcript; const f = await fixture(runner);
    await expect(f.service.create(f.document)).rejects.toMatchObject({ code: "DOCUMENT_AUDIO_EMPTY" });
    expect(await readdir(path.join(f.service.previewRoot, THREAD, UPLOAD))).toEqual([]);
    expect(await readFile(path.join(f.stagingRoot, f.document.relativePath))).toEqual(oggOpusFixture());
  });
  it("does not dispatch a transcriber for malformed/multiple-stream metadata or an unavailable toolchain", async () => {
    const runner = new Runner(); runner.probe.streams.push({ ...runner.probe.streams[0] });
    const f = await fixture(runner);
    await expect(f.service.create(f.document)).rejects.toMatchObject({ code: "DOCUMENT_AUDIO_INVALID" });
    expect(runner.calls).toEqual([tools.ffprobe]);
    await expect(transcribeAudio({ source: oggOpusFixture(), inputPath: "/private/input.ogg", work: "/private", tools: { ...tools, audioTranscriber: undefined }, runner })).rejects.toMatchObject({ code: "DOCUMENT_AUDIO_UNAVAILABLE" });
  });
  it("does not start cancelled work and removes temporary files on an interrupted conversion", async () => {
    const controller = new AbortController(); const runner = new Runner(); const f = await fixture(runner); controller.abort();
    await expect(f.service.create(f.document, { signal: controller.signal })).rejects.toMatchObject({ code: "DOCUMENT_OPERATION_ABORTED" });
    expect(runner.calls).toEqual([]);
    const abort = new AbortController();
    const interrupted = await fixture({ run: async () => { abort.abort(); throw new Error("synthetic interruption"); } });
    await expect(interrupted.service.create(interrupted.document, { signal: abort.signal })).rejects.toThrow();
    expect(await readdir(path.join(interrupted.service.previewRoot, THREAD, UPLOAD))).toEqual([]);
  });
});
