import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { SHOPIFY_ADMIN_FILE_REQUEST_MAX_BYTES } from "@/connectors/shopify-admin-api";

function invalid(): never { throw Error("MODTIME_SHOPIFY_ADMIN_REQUEST_FILE_INVALID"); }

/** Read only from the actor/project workspace supplied by the trusted runtime.
 * Pin directories on Linux so a concurrent worker cannot redirect traversal.
 * The shared safe-file reader does not pin parent directories or bound a file
 * that grows while being read, so request payloads use this stricter reader. */
export async function readShopifyRequestFile(workspace: string | undefined, relativePath: unknown): Promise<unknown> {
  if (!workspace || !path.isAbsolute(workspace) || typeof relativePath !== "string" || relativePath.length > 1024 ||
      path.isAbsolute(relativePath) || relativePath.includes("\\") || /[\0\r\n]/u.test(relativePath) ||
      relativePath.split("/").some(segment => !segment || segment === "." || segment === "..")) invalid();
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const anchored = (handle: Awaited<ReturnType<typeof open>>, fallback: string) =>
    process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : fallback;
  const verify = async (handle: Awaited<ReturnType<typeof open>>, current: string) => {
    const [pinned, meta, canonical] = await Promise.all([handle.stat(), lstat(current), realpath(current)]);
    if (!meta.isDirectory() || meta.isSymbolicLink() || canonical !== current || pinned.dev !== meta.dev || pinned.ino !== meta.ino) invalid();
  };
  try {
    let current = workspace;
    let directory = await open(current, directoryFlags); handles.push(directory);
    await verify(directory, current);
    const segments = relativePath.split("/");
    for (const segment of segments.slice(0, -1)) {
      await verify(directory, current);
      const next = await open(path.join(anchored(directory, current), segment), directoryFlags); handles.push(next);
      current = path.join(current, segment); directory = next;
      await verify(directory, current);
    }
    await verify(directory, current);
    const target = path.join(anchored(directory, current), segments.at(-1)!);
    // NONBLOCK prevents a substituted FIFO/device from blocking before fstat.
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); handles.push(file);
    const meta = await file.stat();
    if (!meta.isFile() || meta.nlink !== 1 || meta.size > SHOPIFY_ADMIN_FILE_REQUEST_MAX_BYTES) invalid();
    const lexicalTarget = path.join(current, segments.at(-1)!);
    const before = await lstat(lexicalTarget);
    if (!before.isFile() || before.isSymbolicLink() || before.ino !== meta.ino || before.dev !== meta.dev) invalid();
    const bytes = Buffer.alloc(meta.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await file.stat();
    const finalPath = await lstat(lexicalTarget);
    if (length !== meta.size || after.size !== meta.size || after.nlink !== 1 || after.mtimeMs !== meta.mtimeMs || after.ctimeMs !== meta.ctimeMs ||
        finalPath.isSymbolicLink() || finalPath.ino !== meta.ino || finalPath.dev !== meta.dev) invalid();
    // Re-check the complete chain, including the root, after the bounded read.
    let verifiedPath = workspace;
    await verify(handles[0], verifiedPath);
    for (let i = 0; i < segments.length - 1; i++) {
      verifiedPath = path.join(verifiedPath, segments[i]);
      await verify(handles[i + 1], verifiedPath);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } catch { return invalid(); }
  finally { await Promise.all(handles.map(handle => handle.close())); }
}
