import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { FileDocumentConversionGate } from "@/documents/conversion-gate";
import { DocumentPreviewService } from "@/documents/preview-service";
import { FileDocumentStagingStore } from "@/documents/staging-store";
import { validateUploadedDocument } from "@/documents/upload-validation";
import { ResourceLockManager } from "@/storage";
import { handleLocalDocumentDynamicToolCall, type LocalDocumentDynamicToolContext } from "@/runtime/documents/dynamic-tools";

// Offline synthetic acceptance. CI must provide an empty disposable data tmpfs.
assert.equal(process.getuid?.(), 10001, "Run as the image runtime user");
assert.equal(process.env.AIBRAIN_SYNTHETIC_ACCEPTANCE, "1", "Synthetic acceptance must be explicitly enabled");
const userId = randomUUID();
const projectId = randomUUID();
const threadId = randomUUID();
const turnId = randomUUID();
const uploadId = randomUUID();
const dataRoot = "/var/lib/aibrain/data";
const root = path.join(dataRoot, "users", userId);
const workspace = path.join(root, "workspace", "projects", projectId);
const state = path.join(root, "state");
const sourcePath = ".aibrain-drafts/acceptance.pptx";
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
let conversions = 0;

try {
  await mkdir(path.join(workspace, ".aibrain-drafts"), { recursive: true, mode: 0o700 });
  const require = createRequire(import.meta.url);
  const PptxGenJS = require("/usr/local/share/aibrain/pptxgenjs.cjs");
  const deck = new PptxGenJS();
  deck.layout = "LAYOUT_WIDE";
  for (const marker of ["SERVER REVIEW FIRST", "SERVER REVIEW SECOND"]) {
    const slide = deck.addSlide();
    slide.background = { color: "182E3A" };
    slide.addText(marker, { x: .7, y: .7, w: 11.7, h: 1, fontSize: 30, color: "FFFFFF" });
    slide.addShape(deck.ShapeType.rect, { x: .7, y: 2.2, w: 5, h: 3, fill: { color: "397C66" } });
  }
  await deck.writeFile({ fileName: path.join(workspace, sourcePath) });
  const original = await readFile(path.join(workspace, sourcePath));
  const sourceHash = hash(original);
  const locks = new ResourceLockManager({ rootDirectory: path.join(state, ".locks") });
  const stagingRoot = path.join(root, "staging");
  const staging = new FileDocumentStagingStore(stagingRoot, locks);
  const previews = new DocumentPreviewService({
    stagingRoot, previewRoot: path.join(state, "document-previews"), lockManager: locks,
    conversionGate: new FileDocumentConversionGate({ rootDirectory: path.join(state, "conversion-gate") }),
    requireQpdf: true,
    tools: { soffice: "/usr/local/bin/aibrain-soffice", pdfinfo: "/usr/local/bin/aibrain-pdfinfo", pdftoppm: "/usr/local/bin/aibrain-pdftoppm", qpdf: "/usr/local/bin/aibrain-qpdf" },
  });
  const context: LocalDocumentDynamicToolContext = {
    installationId: "synthetic-render", userId, projectId, projectWorkspace: workspace,
    receiptRoot: path.join(state, "receipts"), runtimeThreadId: "synthetic-thread", runtimeTurnId: "synthetic-turn",
    sourceThreadId: threadId, sourceTurnId: turnId,
    installation: { installationId: "synthetic-render", paths: {
      dataRoot, usersRoot: path.join(dataRoot, "users"), companyContextRoot: path.join(root, "company"),
      sourceReadRoot: path.join(root, "source"), publishWriteRoot: path.join(root, "publish"), backupsRoot: path.join(root, "backups"),
    } },
    permissions: { schemaVersion: 1, installationId: "synthetic-render", userId, roleId: null,
      projectId, turnId, resolvedAt: new Date().toISOString(), fingerprint: "a".repeat(64), sources: [],
      rules: [{ ruleId: "tools.execute", action: "execute", effect: "allow", instruction: "Synthetic local review", sourceScope: "installation", sourcePolicyVersion: 1, precedence: 100 }],
      developerInstructions: "Synthetic acceptance only" },
    renderPresentation: async (input) => {
      conversions += 1;
      try {
      assert.equal(input.sha256, sourceHash);
      const validated = validateUploadedDocument({ fileName: input.fileName, declaredMimeType: input.mimeType, data: input.data });
      const staged = await staging.stage({ threadId, uploadId, validated, data: input.data });
      const preview = await previews.create(staged);
      assert.equal(preview.pages, 2);
      const pdf = await previews.readFile(threadId, uploadId, "document.pdf");
      const png = await previews.renderPage(threadId, uploadId, input.page);
      return { pdf, png, pages: preview.pages! };
      } catch (error) {
        // Synthetic fixtures only: never enable this diagnostic in product code.
        const diagnostic = error as { name?: string; code?: string; message?: string; stderr?: string; stack?: string };
        console.error(JSON.stringify({ phase: "synthetic-render-callback", name: diagnostic.name, code: diagnostic.code, message: diagnostic.message, stderr: diagnostic.stderr, stack: diagnostic.stack }));
        throw error;
      }
    },
  };
  const request = { threadId: context.runtimeThreadId, turnId: context.runtimeTurnId, callId: "review-1", namespace: "aibrain_documents", tool: "render", arguments: { relativePath: sourcePath, page: 1 } };
  const denied = await handleLocalDocumentDynamicToolCall(request, { ...context, permissions: { ...context.permissions, userId: randomUUID() } });
  assert.equal(denied.response.success, false);
  assert.equal(conversions, 0, "Wrong user must be rejected before conversion");
  assert.deepEqual(denied.artifacts, []);

  for (const page of [1, 2]) {
    const result = await handleLocalDocumentDynamicToolCall({ ...request, callId: `review-${page}`, arguments: { relativePath: sourcePath, page } }, context);
    if (!result.response.success) {
      console.error(JSON.stringify({ phase: "synthetic-render-tool", conversions, response: result.response }));
    }
    assert.equal(result.response.success, true, JSON.stringify(result.response));
    assert.deepEqual(result.artifacts, [], "Review must not deliver a customer artifact");
    const text = result.response.contentItems.find((item) => item.type === "inputText");
    assert.ok(text && text.type === "inputText");
    const metadata = JSON.parse(text.text);
    assert.equal(metadata.sha256, sourceHash);
    assert.equal(metadata.pages, 2);
    assert.equal(metadata.page, page);
    assert.ok(metadata.reviewPdfPath.startsWith(".aibrain-drafts/"));
    const pdf = await PDFDocument.load(await readFile(path.join(workspace, metadata.reviewPdfPath)));
    assert.equal(pdf.getPageCount(), 2);
    const image = result.response.contentItems.find((item) => item.type === "inputImage");
    assert.ok(image && image.type === "inputImage");
    assert.ok(image.imageUrl.startsWith("data:image/png;base64,"));
    const png = Buffer.from(image.imageUrl.split(",")[1]!, "base64");
    assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    assert.ok(png.length > 1000);
  }
  assert.equal(hash(await readFile(path.join(workspace, sourcePath))), sourceHash, "Review must not mutate source");
  await mkdir(path.join(workspace, "documents"));
  await copyFile(path.join(workspace, sourcePath), path.join(workspace, "documents", "final.pptx"));
  const delivered = await handleLocalDocumentDynamicToolCall({ ...request, tool: "deliver", callId: "delivery-final", arguments: { relativePath: "documents/final.pptx" } }, context);
  assert.equal(delivered.response.success, true, JSON.stringify(delivered.response));
  assert.equal(delivered.artifacts.length, 1);
  const repeated = await handleLocalDocumentDynamicToolCall({ ...request, tool: "deliver", callId: "delivery-repeat", arguments: { relativePath: "documents/final.pptx" } }, context);
  assert.deepEqual(repeated.artifacts, delivered.artifacts);
  console.log(JSON.stringify({ status: "passed", tool: "aibrain_documents.render", pdfPages: 2, pngResponses: 2, reviewArtifacts: 0, explicitDeliveries: 1, wrongUserRejectedBeforeConversion: true, sourceHashVerified: true }));
} finally {
  await rm(root, { recursive: true, force: true });
}
