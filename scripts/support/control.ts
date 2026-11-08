// Operator-only stdin bridge. It is deliberately not an HTTP route or a chat tool.
import { readdir } from "node:fs/promises";
import { loadInstallationConfig } from "../../src/config/installation";
import { FileLocalUserStore } from "../../src/auth/local-user-store";
import { FileSupportRequestStore } from "../../src/support/store";

const PRIVATE_INSTALLATIONS = new Set(["trinalum-production", "g03-production", "insijets-demo", "modtime"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 64 * 1024) throw new Error("Support control input too large.");
  }
  const request = JSON.parse(input) as Record<string, unknown>;
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Invalid control input.");
  const installation = await loadInstallationConfig();
  if (!PRIVATE_INSTALLATIONS.has(installation.installationId) || request.installationId !== installation.installationId) {
    throw new Error("Support installation mismatch.");
  }
  const userStore = new FileLocalUserStore(installation.paths.usersRoot);
  if (request.operation === "protocol") {
    return { schemaVersion: 1, installationId: installation.installationId, publicUrl: installation.publicUrl, operations: ["list", "get", "claim", "renew", "update", "screenshot", "revision"] };
  }
  if (request.operation === "list") {
    const result = [];
    const entries = await readdir(installation.paths.usersRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      const user = await userStore.read(entry.name);
      if (!user?.enabled) continue;
      const store = new FileSupportRequestStore(installation.installationId, entry.name, installation.paths.usersRoot);
      for (const ticket of await store.list()) {
        if (["queued", "investigating", "working", "verifying"].includes(ticket.status)) result.push(ticket);
        if (result.length >= 100) break;
      }
      if (result.length >= 100) break;
    }
    return { requests: result };
  }
  if (request.operation === "revision") {
    const revision = process.env.AIBRAIN_REVISION?.trim() ?? "";
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Runtime revision unavailable.");
    return { revision, installationId: installation.installationId };
  }
  if (typeof request.userId !== "string" || !UUID.test(request.userId) || !(await userStore.read(request.userId))?.enabled) {
    throw new Error("Support user unavailable.");
  }
  const store = new FileSupportRequestStore(installation.installationId, request.userId, installation.paths.usersRoot);
  if (request.operation === "get") {
    if (typeof request.requestId !== "string" || !UUID.test(request.requestId)) throw new Error("Invalid support request.");
    return { request: (await store.list()).find((ticket) => ticket.id === request.requestId) ?? null };
  }
  if (request.operation === "claim") {
    if (typeof request.owner !== "string" || !UUID.test(request.owner)) throw new Error("Invalid support owner.");
    if (request.requestId !== undefined && (typeof request.requestId !== "string" || !UUID.test(request.requestId))) throw new Error("Invalid support request.");
    return { claim: await store.claim(request.owner, 120_000, request.requestId as string | undefined) };
  }
  if (typeof request.requestId !== "string" || !UUID.test(request.requestId)) throw new Error("Invalid support request.");
  if (request.operation === "screenshot") {
    if (typeof request.screenshotId !== "string" || !UUID.test(request.screenshotId)) throw new Error("Invalid screenshot.");
    const screenshot = await store.readScreenshot(request.requestId, request.screenshotId);
    if (!screenshot) throw new Error("Screenshot unavailable.");
    return { id: screenshot.id, mimeType: screenshot.mimeType, base64: screenshot.data.toString("base64") };
  }
  if (typeof request.token !== "string" || !UUID.test(request.token)) throw new Error("Invalid support lease.");
  if (request.operation === "renew") {
    if (request.leaseMs !== undefined && request.leaseMs !== 900_000) throw new Error("Invalid verification lease.");
    await store.renew(request.requestId, request.token, request.leaseMs === 900_000 ? 900_000 : 120_000);
    return { renewed: true };
  }
  if (request.operation === "update") {
    if (!request.update || typeof request.update !== "object" || Array.isArray(request.update)) throw new Error("Invalid update.");
    const update = request.update as Parameters<FileSupportRequestStore["update"]>[2];
    if (update.status === "resolved") {
      if (update.evidence?.revision !== process.env.AIBRAIN_REVISION?.trim()) throw new Error("Resolution must match the active runtime revision.");
    }
    return { request: await store.update(request.requestId, request.token, update) };
  }
  throw new Error("Unknown support control operation.");
}

main().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error: unknown) => {
  // Never echo stdin, paths, credentials or a stack from the operator boundary.
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "SUPPORT_CONTROL_FAILED";
  process.stderr.write(`${JSON.stringify({ error: code })}\n`);
  process.exitCode = 1;
});
