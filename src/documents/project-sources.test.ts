import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectSourceStore, resolveProjectSourceDocuments } from "./project-sources";
import { validateUploadedDocument } from "./upload-validation";
import { prepareTurnDocumentWorkspaceInputs } from "./turn-attachments";
import { DurableTurnSubmission } from "@/runtime/turn-submission-store";
import type { InstallationConfig } from "@/config/installation-schema";
import type { ResolvedPermissions } from "@/permissions";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("retains the complete reference across conversations and restart without modifying its original", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-sources-")); roots.push(root);
  const config = { paths: { dataRoot: root } } as InstallationConfig;
  const { staging } = projectSourceStore(config, id(1));
  const bytes = Buffer.from("price rows\n".repeat(5000) + "FINAL_PRICE=42.79");
  const validated = validateUploadedDocument({ fileName: "prices.txt", declaredMimeType: "text/plain", data: bytes });
  await staging.stage({ threadId: id(2), uploadId: id(3), validated, data: bytes });
  const sources = [{ id: id(3), kind: "file" as const, name: "prices.txt", status: "ready" as const, excerpt: null, url: null }];
  const permissions = { rules: [{ ruleId: "documents.read", action: "consult", effect: "allow" }] } as unknown as ResolvedPermissions;
  const input = { config, ownerUserId: id(1), projectId: id(2), sources, permissions };
  for (const thread of [id(4), id(5)]) {
    const resolved = await resolveProjectSourceDocuments(input);
    const workspace = path.join(root, thread); await mkdir(workspace, { mode: 0o700 });
    const options = { userRoot: root, workspace, installationId: "test", userId: id(1), projectId: id(2), threadId: thread, assistantMessageId: id(6), binding: "a".repeat(64) };
    const submission = await DurableTurnSubmission.open(options);
    const prepared = await submission.prepareInputs(onDirectoryCreated => prepareTurnDocumentWorkspaceInputs({ documents: [],
      referenceDocuments: resolved.documents, referenceRoot: resolved.root, projectWorkspace: workspace, stagingRoot: resolved.root, onDirectoryCreated }));
    const copy = path.join(prepared.directory!, "reference-1.txt");
    expect(await readFile(copy)).toEqual(bytes);
    await submission.close();
    const restarted = await DurableTurnSubmission.open(options);
    try { await restarted.validateWorkingCopies(); } finally { await restarted.close(); }
  }
  const document = await staging.readById(id(2), id(3));
  expect(await readFile(path.join(staging.rootDirectory, document.relativePath))).toEqual(bytes);
  await expect(resolveProjectSourceDocuments({ ...input, ownerUserId: id(7) })).rejects.toThrow();
  await expect(resolveProjectSourceDocuments({ ...input, projectId: id(8) })).rejects.toThrow();
  await expect(resolveProjectSourceDocuments({ ...input, permissions: { rules: [{ ruleId: "documents.read", action: "consult", effect: "deny" }] } as unknown as ResolvedPermissions })).rejects.toThrow(/permiso/);
  await writeFile(path.join(staging.rootDirectory, document.relativePath), "tampered", { mode: 0o600 });
  const resolved = await resolveProjectSourceDocuments(input);
  await expect(prepareTurnDocumentWorkspaceInputs({ documents: [], referenceDocuments: resolved.documents, referenceRoot: resolved.root,
    projectWorkspace: path.join(root, id(4)), stagingRoot: resolved.root })).rejects.toThrow(/changed/);
});
