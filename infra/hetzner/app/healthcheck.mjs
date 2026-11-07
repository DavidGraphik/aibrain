import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";

async function requireAccess(filePath, mode) {
  await access(filePath, mode);
}

async function requireReadOnlyDirectory(directory) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("unsafe source root");
  await requireAccess(directory, constants.R_OK | constants.X_OK);
  try {
    await requireAccess(directory, constants.W_OK);
  } catch {
    return;
  }
  throw new Error("source root is writable");
}

async function requireWritableDirectory(directory) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("unsafe writable root");
  await requireAccess(directory, constants.R_OK | constants.W_OK | constants.X_OK);
}

try {
  const config = await lstat("/etc/aibrain/installation.json");
  if (!config.isFile() || config.isSymbolicLink()) throw new Error("unsafe config");
  await Promise.all([
    requireWritableDirectory("/var/lib/aibrain/data"),
    requireWritableDirectory("/var/lib/aibrain/data/backups"),
    requireWritableDirectory("/var/lib/aibrain-restores"),
    requireWritableDirectory("/srv/aibrain/publish-rw"),
    requireReadOnlyDirectory("/srv/aibrain/source-ro"),
  ]);
  try {
    await lstat("/var/run/docker.sock");
    throw new Error("docker socket is present");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const response = await fetch("http://127.0.0.1:3000/api/health/ready", {
    redirect: "manual",
    signal: AbortSignal.timeout(3_000),
  });
  if (response.status !== 200) throw new Error("server error");
  const payload = await response.json();
  if (payload?.schemaVersion !== 1 || payload?.status !== "ready") throw new Error("invalid health response");
} catch {
  process.stderr.write("AIBRAIN_HEALTHCHECK_FAILED\n");
  process.exit(1);
}
