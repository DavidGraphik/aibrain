import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export class UnsafeFilePathError extends Error {}

function insideRoot(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function readRegularFileWithin(
  root: string,
  relativePath: string,
  maximumBytes: number,
) {
  if (!path.isAbsolute(root) || path.isAbsolute(relativePath) || !Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new UnsafeFilePathError("Invalid safe-file boundary.");
  }

  const lexicalTarget = path.resolve(root, relativePath);
  if (!insideRoot(root, lexicalTarget)) {
    throw new UnsafeFilePathError("Path escapes the allowed root.");
  }

  const [canonicalRoot, metadata] = await Promise.all([
    realpath(root),
    lstat(lexicalTarget),
  ]);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new UnsafeFilePathError("Only regular files are readable.");
  }
  if (metadata.size > maximumBytes) {
    throw new UnsafeFilePathError("File exceeds the safe read limit.");
  }

  const canonicalTarget = await realpath(lexicalTarget);
  if (!insideRoot(canonicalRoot, canonicalTarget)) {
    throw new UnsafeFilePathError("Resolved file escapes the allowed root.");
  }

  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(lexicalTarget, constants.O_RDONLY | noFollow);
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile() || openedMetadata.size !== metadata.size || openedMetadata.size > maximumBytes) {
      throw new UnsafeFilePathError("File changed during validation.");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
