import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { stageLegacyExcelUpload } from "@/documents/legacy-excel-upload";
import { FileDocumentConversionGate } from "@/documents/conversion-gate";
import { DocumentPreviewService } from "@/documents/preview-service";
import { FileDocumentStagingStore } from "@/documents/staging-store";
import { prepareTurnDocumentWorkspaceInputs, ServerTurnDocumentInputResolver } from "@/documents/turn-attachments";
import { ResourceLockManager } from "@/storage";

assert.equal(process.getuid?.(), 10001);
assert.equal(process.env.AIBRAIN_SYNTHETIC_ACCEPTANCE, "1");
const root = "/var/lib/aibrain/data"; // CI supplies only an empty disposable tmpfs.
for (const passive of [true, false]) {
const userId = randomUUID(), threadId = randomUUID(), uploadId = randomUUID();
const userRoot = path.join(root, "users", userId);
const vaultRoot = path.join(root, "server", "legacy-excel-originals", userId);
const stagingRoot = path.join(userRoot, "staging");
const workspace = path.join(userRoot, "workspace");
const sourceRoot = path.join(root, "server", "passive-acceptance", userId);
const sourcePath = path.join(sourceRoot, "source.xls");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
try {
  await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await copyFile(`/usr/local/share/aibrain/${passive ? "legacy-passive-links-macros" : "legacy-autofilter"}.xls`, sourcePath);
  const { chmod } = await import("node:fs/promises");
  await chmod(sourcePath, 0o600);
  const original = await readFile(sourcePath);
  assert.equal(original.includes(Buffer.from("INERT_TEST_VBA_PAYLOAD")), passive);
  const locks = new ResourceLockManager({ rootDirectory: path.join(userRoot, "state", ".locks") });
  const gate = new FileDocumentConversionGate({ rootDirectory: path.join(root, "locks", "document-conversions") });
  const vault = new FileDocumentStagingStore(vaultRoot, locks);
  const staging = new FileDocumentStagingStore(stagingRoot, locks);
  const upload = { filePath: sourcePath, fileName: "fixture.xls", declaredMimeType: "application/octet-stream", threadId, uploadId, size: original.length };
  const options = { reader: "/usr/local/bin/aibrain-xls-passive", soffice: "/usr/local/bin/aibrain-soffice", conversionGate: gate, originals: vault, staging, locks };
  const document = await stageLegacyExcelUpload(upload, options);
  const retry = await stageLegacyExcelUpload(upload, options);
  assert.equal(retry.sha256, document.sha256);
  const recovered = await staging.readById(threadId, uploadId);
  assert.equal(Boolean(recovered.legacyExcel), passive);
  if (passive) assert.equal(recovered.legacyExcel?.originalSha256, hash(original));
  const storedOriginal = await vault.resolveContentById(threadId, uploadId);
  assert.deepEqual(await readFile(storedOriginal.absolutePath), original);
  const derived = await staging.resolveContentById(threadId, uploadId);
  assert(!derived.absolutePath.startsWith(vaultRoot));
  const zip = await JSZip.loadAsync(await readFile(derived.absolutePath));
  let formulaCount = 0;
  for (const entry of Object.values(zip.files).filter(entry => !entry.dir)) {
    const xml = await entry.async("string");
    assert(!/<hyperlink|TargetMode="External"|INERT_TEST_VBA_PAYLOAD/.test(xml));
    formulaCount += (xml.match(/<f(?:\s|>)/g) ?? []).length;
  }
  assert.equal(formulaCount, passive ? 0 : 3);
  const previews = new DocumentPreviewService({
    stagingRoot, previewRoot: path.join(userRoot, "state", "document-previews"), lockManager: locks,
    conversionGate: gate, requireQpdf: true,
    tools: { soffice: "/usr/local/bin/aibrain-soffice", pdfinfo: "/usr/local/bin/aibrain-pdfinfo", pdftoppm: "/usr/local/bin/aibrain-pdftoppm", qpdf: "/usr/local/bin/aibrain-qpdf" },
  });
  const preview = await previews.create(document);
  assert.equal(preview.kind, "xlsx");
  assert.equal(preview.pages, passive ? 2 : 1);
  const resolver = new ServerTurnDocumentInputResolver({ stagingRoot, previews, pdftotext: "/usr/local/bin/aibrain-pdftotext", workspaceXlsx: true, conversionGate: gate });
  const inputs = await resolver.resolve(recovered);
  assert.equal(JSON.stringify(inputs).includes("no verificados"), passive);
  const turn = await prepareTurnDocumentWorkspaceInputs({ documents: [{ document: recovered, absolutePath: derived.absolutePath, codexInputs: inputs }], projectWorkspace: workspace, stagingRoot });
  assert.deepEqual(await readFile(path.join(turn.directory!, "input-1.xlsx")), await readFile(derived.absolutePath));
  assert.equal(JSON.stringify(turn.codexInputs).includes("Stored formula results are unverified"), passive);
  assert.equal(hash(await readFile(sourcePath)), hash(original));
  console.log(JSON.stringify({ mode: passive ? "passive" : "native", result: "passed", retryStable: true, formulaCount, sourceUnchanged: true, originalOutsideStaging: true, valuesAvailableToChat: true, formulaCachesUnverified: passive, previewPages: preview.pages, noMacrosOrExternalLinks: true, cellContentsReported: false }));
} finally {
  await rm(userRoot, { recursive: true, force: true });
  await rm(vaultRoot, { recursive: true, force: true });
  await rm(sourceRoot, { recursive: true, force: true });
}
}
