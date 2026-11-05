import { createHash } from "node:crypto";

export function publicationBarrierLock(installationId: string) {
  return `document-publication-barrier:${installationId}`;
}

export function publicationTargetLock(installationId: string, targetRelativePath: string) {
  const targetHash = createHash("sha256").update(targetRelativePath).digest("hex");
  return `document-publication-target:${installationId}:${targetHash}`;
}
