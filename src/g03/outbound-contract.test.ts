import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, onTestFailed } from "vitest";
import { parseInstallationConfig } from "@/config/installation-schema";
import { EnterpriseDocumentNetwork } from "@/documents/enterprise-document-network";
import { ServerDocumentFiles } from "@/documents/server-files";
import type { ResolvedPermissions } from "@/permissions";
import { G03PublicationClient } from "./publication-client";

const processes: ChildProcess[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
  // Only temporary fixture directories created by this test are removed.
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

it.each([1, 2])("native AiBrain file client uses actual relay protocol %i (v2 has 69.3-minute skew), with authorized roots and offline denial", async (protocol) => {
  let phase = "prepare";
  let diagnostic = "";
  onTestFailed(() => { console.error(`Synthetic relay phase: ${phase}; stderr: ${diagnostic}`); });
  const root = await realpath(await mkdtemp("/tmp/g03-contract-"));
  directories.push(root);
  const dataRoot = path.join(root, "data");
  const config = parseInstallationConfig({
    schemaVersion: 1, installationId: "g03-contract-test", companyName: "Synthetic G03", companySlug: "g03",
    publicUrl: "https://example.test", branding: { productName: "Test", logoPath: "/logo.svg", faviconPath: "/favicon.svg", accentColor: "#123456" },
    paths: { dataRoot, companyContextRoot: path.join(dataRoot, "context"), usersRoot: path.join(dataRoot, "users"),
      sourceReadRoot: path.join(root, "source"), publishWriteRoot: path.join(root, "publish"), backupsRoot: path.join(dataRoot, "backups") },
  });
  const network = new EnterpriseDocumentNetwork(config);
  const userId = "00000000-0000-4000-8000-000000000001";
  const projectId = "00000000-0000-4000-8000-000000000002";
  const permissions: ResolvedPermissions = {
    schemaVersion: 1, installationId: config.installationId, userId, projectId,
    roleId: null, turnId: "00000000-0000-4000-8000-000000000003", resolvedAt: new Date().toISOString(), fingerprint: "a".repeat(64),
    sources: [], developerInstructions: "Synthetic test", rules: [{ ruleId: "documents.company.read", action: "consult", effect: "allow",
      instruction: "Test", sourceScope: "installation", sourcePolicyVersion: 1, precedence: 100 }],
  };
  const roots = await network.rootsForTurn({ userId, projectId, permissions });
  const socketDirectory = path.join(dataRoot, "locks/server-files");
  await mkdir(socketDirectory, { recursive: true, mode: 0o750 });
  await chmod(socketDirectory, 0o750);
  await writeFile(path.join(socketDirectory, "g03.json"), JSON.stringify({
    schemaVersion: 1, installationId: config.installationId, connectionId: "g03", scope: "company", mode: "read-only",
    entryPoints: [{ label: "Produccio", path: "server-g03/M/G03/PRODUCCIO" }],
  }), { mode: 0o640 });
  const child = spawn("python3", ["deployments/g03/outbound/native_contract_fixture.py", socketDirectory, "--synthetic-test-only",
    ...(protocol === 2 ? ["--clock-skew-v2"] : [])], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(child);
  child.stderr?.on("data", data => { diagnostic = (diagnostic + String(data)).slice(-2048); });
  phase = "start relay";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic relay did not start")), 5000);
    child.once("error", reject);
    child.stdout?.on("data", (data) => {
      if (data.toString().includes("SYNTHETIC_READY")) { clearTimeout(timer); resolve(); }
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Synthetic relay exited: ${code}`)); });
  });
  const files = new ServerDocumentFiles(network, { ownerUid: process.getuid?.() ?? 0, timeoutMs: 4000 });
  phase = "browse/read and denied paths";
  await expect(files.navigation(roots)).resolves.toMatchObject({
    available: true, sourceChecked: false, results: [{ path: "server-g03/M/G03/PRODUCCIO" }],
  });
  await expect(files.search(roots, "server:/M/G03/PRODUCCIO", 50, true)).resolves.toMatchObject({
    available: true, sourceChecked: true, results: [{ path: "server-g03/M/G03/PRODUCCIO/prova.txt", kind: "file" }],
  });
  await expect(files.read(roots, { scope: "company", path: "server-g03/M/G03/PRODUCCIO/prova.txt" })).resolves.toMatchObject({
    available: true, sourceChecked: true, content: "Document sintètic G03",
  });
  await expect(files.search(roots, "server:/C/Windows", 50, true)).resolves.toMatchObject({ available: false });
  await expect(files.search(roots, "server:/M/G03/PRODUCCIO/absent", 50, true)).resolves.toMatchObject({ available: false });
  const deniedRoots = await network.rootsForTurn({ userId, projectId, permissions: {
    ...permissions, rules: permissions.rules.map(rule => ({ ...rule, effect: "deny" as const })),
  } });
  await expect(files.search(deniedRoots, "server:/M/G03/PRODUCCIO", 50, true)).resolves.toBeNull();
  const publisher = new G03PublicationClient({ installationId: config.installationId, socketDirectory,
    ownerUid: process.getuid?.() ?? 0, timeoutMs: 4000 });
  const target = "server-g03/M/G03/PRODUCCIO/prova.txt";
  phase = "snapshot and replace";
  const snapshot = await publisher.snapshot(target);
  expect(snapshot.exists).toBe(true);
  if (protocol === 2) expect(snapshot.mtimeMs! - Date.now()).toBeGreaterThan(60 * 60_000);
  const updated = Buffer.from("Edited synthetic G03 document");
  const binding = { path: target, operationId: randomUUID(), actorId: userId, projectId,
    writeOperation: "replace" as const, expectedSha256: snapshot.sha256,
    sha256: createHash("sha256").update(updated).digest("hex") };
  expect(await publisher.publish(binding, updated)).toMatchObject({ status: "committed", backupId: binding.operationId });
  expect(await publisher.receipt(binding)).toMatchObject({ status: "committed", sha256: binding.sha256 });
  expect(await publisher.snapshot(target)).toMatchObject({ exists: true, sha256: binding.sha256 });
  const newTarget = "server-g03/M/G03/PRODUCCIO/new.txt";
  phase = "create and conflict";
  expect(await publisher.snapshot(newTarget)).toEqual({ exists: false, size: null, sha256: null, mtimeMs: null });
  expect(await publisher.publish({ ...binding, operationId: randomUUID(), path: newTarget,
    writeOperation: "create", expectedSha256: null }, updated)).toMatchObject({ status: "committed", backupId: null });
  await expect(publisher.publish({ ...binding, operationId: randomUUID() }, updated)).rejects.toMatchObject({ code: "PUBLICATION_ORIGINAL_CONFLICT" });
  await expect(publisher.snapshot("server-g03/C/Windows/forbidden.txt")).rejects.toThrow();
  phase = "graceful relay shutdown";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic relay shutdown did not finish.")), 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
  phase = "offline denial";
  await expect(files.search(roots, "server:/M/G03/PRODUCCIO", 50, true)).resolves.toMatchObject({ available: false });
}, 15000);
