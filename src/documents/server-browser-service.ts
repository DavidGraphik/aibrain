import "server-only";
import { randomUUID } from "node:crypto";
import type { AuthSession } from "@/auth/types";
import { installationForLibraryResource } from "@/library/server-resource-access";
import { resolveProjectAccess } from "@/workbench/shared-access";
import { resolveServerTurnPermissions } from "@/runtime/permission-turn";
import { EnterpriseDocumentNetwork } from "./enterprise-document-network";
import { ServerBrowseInflight } from "./server-browse-inflight";
import { ServerDocumentFiles } from "./server-files";
import { isSpreadsheetPreview } from "./spreadsheet-preview";

const inFlight = new ServerBrowseInflight();

export async function originalServerForSession(session: AuthSession, projectId: string, sourcePath: string, signal?: AbortSignal) {
  const config = await installationForLibraryResource(session);
  if (config.installationId !== "g03-production") throw new Error("ORIGINAL_NOT_SUPPORTED");
  await resolveProjectAccess(session, projectId);
  const permissions = await resolveServerTurnPermissions(config, {
    installationId: config.installationId, userId: session.user.id, projectId, turnId: randomUUID(),
  });
  const network = new EnterpriseDocumentNetwork(config);
  const roots = await network.rootsForTurn({ userId: session.user.id, projectId, permissions });
  if (signal?.aborted) throw new Error("SERVER_PREVIEW_CANCELLED");
  const key = JSON.stringify(["original", config.installationId, session.user.id, projectId, roots, sourcePath]);
  const result = await inFlight.run(key, () => new ServerDocumentFiles(network, { userId: session.user.id }).readOriginal(roots, { scope: "company", path: sourcePath }));
  await resolveProjectAccess(session, projectId);
  if (!result?.available || result.sourceChecked !== true || typeof result.base64 !== "string") throw new Error("READ_UNAVAILABLE");
  return { bytes: Buffer.from(result.base64, "base64"), sha256: String(result.sha256) };
}

/** Read-only, request-scoped preview. A path is never an access grant. */
export async function previewServerForSession(session: AuthSession, projectId: string, sourcePath: string, signal?: AbortSignal) {
  const config = await installationForLibraryResource(session);
  await resolveProjectAccess(session, projectId);
  const permissions = await resolveServerTurnPermissions(config, {
    installationId: config.installationId, userId: session.user.id, projectId, turnId: randomUUID(),
  });
  const network = new EnterpriseDocumentNetwork(config);
  const roots = await network.rootsForTurn({ userId: session.user.id, projectId, permissions });
  if (signal?.aborted) throw new Error("SERVER_PREVIEW_CANCELLED");
  const key = JSON.stringify(["preview", config.installationId, session.user.id, projectId, roots, sourcePath]);
  const result = await inFlight.run(key, () => new ServerDocumentFiles(network, { userId: session.user.id }).read(roots, { scope: "company", path: sourcePath }));
  await resolveProjectAccess(session, projectId);
  if (!result?.available || result.sourceChecked !== true || typeof result.content !== "string") {
    // Expose only the safe format category; never relay upstream diagnostics,
    // credentials or filesystem paths to the preview client.
    const error = result?.error === "SERVER_FORMAT_NOT_READABLE" ? "SERVER_FORMAT_NOT_READABLE"
      : result?.error === "SERVER_REQUEST_DENIED" ? "UNSUPPORTED_OR_DENIED" : "READ_UNAVAILABLE";
    return { available: false, error };
  }
  const next = result.nextPath;
  const base = sourcePath.split("?")[0];
  return { available: true, path: sourcePath, content: result.content,
    checkedAt: result.checkedAt, modifiedAt: result.modifiedAt, sha256: result.sha256,
    nextPath: typeof next === "string" && next.startsWith(base + "?part=") && /^part=[1-9][0-9]{0,2}(?:&sha256=[a-f0-9]{64})?$/.test(next.slice(base.length + 1)) ? next : null,
    truncated: result.truncated === true,
    coverage: typeof result.coverage === "object" && result.coverage !== null &&
      "documentCompleteInResponse" in result.coverage && typeof result.coverage.documentCompleteInResponse === "boolean" &&
      "versionBound" in result.coverage && typeof result.coverage.versionBound === "boolean"
      ? { documentCompleteInResponse: result.coverage.documentCompleteInResponse, versionBound: result.coverage.versionBound } : null,
    preview: isSpreadsheetPreview(result.preview) ? result.preview : null };
}

export async function browseServerForSession(session: AuthSession, projectId: string, query: string, signal?: AbortSignal) {
  const config = await installationForLibraryResource(session);
  // Project membership is checked before source descriptors or company files.
  await resolveProjectAccess(session, projectId);
  const permissions = await resolveServerTurnPermissions(config, {
    installationId: config.installationId, userId: session.user.id, projectId, turnId: randomUUID(),
  });
  const network = new EnterpriseDocumentNetwork(config);
  const roots = await network.rootsForTurn({ userId: session.user.id, projectId, permissions });
  if (signal?.aborted) return { available: false, error: "SERVER_BROWSE_CANCELLED" };
  if (query === "home") return await new ServerDocumentFiles(network, { userId: session.user.id }).navigation(roots)
    ?? { available: false, warning: "No tienes acceso al servidor en este proyecto." };
  // An HTTP disconnect must not orphan the Windows operation and make a reopen
  // start a competing session. Every subscriber has independently passed ACLs.
  // Include resolved roots so a permissions change cannot reuse an older grant.
  const key = JSON.stringify([config.installationId, session.user.id, projectId, roots, query]);
  const result = await inFlight.run(key, () => new ServerDocumentFiles(network, { userId: session.user.id }).search(roots, query, 50, true));
  if (result?.available && Array.isArray(result.results)) {
    return { ...result, results: result.results.map(entry => {
      const item = entry as Record<string, unknown>;
      const sourcePath = String(item.path);
      return { path: sourcePath, name: decodeURIComponent(sourcePath.replace(/\/$/, "").split("/").at(-1)!),
        kind: item.kind, modifiedAt: item.modifiedAt ?? null, size: item.size };
    }) };
  }
  return result ?? { available: false, warning: "No tienes acceso al servidor en este proyecto." };
}
