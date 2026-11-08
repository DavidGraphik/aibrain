import path from "node:path";

/** Redact known roots before finding public word boundaries, including a
 * trailing incomplete root. This is not an arbitrary-secret detector. */
export function privateWorkspaceSafeText(value: string, roots: readonly string[]) {
  const knownRoots = [...new Set(roots.filter((root) => path.isAbsolute(root)))]
    .sort((left, right) => right.length - left.length);
  let sanitized = "";
  for (let index = 0; index < value.length;) {
    const nextRoot = value.indexOf(path.sep, index);
    if (nextRoot === -1) {
      sanitized += value.slice(index);
      break;
    }
    sanitized += value.slice(index, nextRoot);
    index = nextRoot;
    const remaining = value.slice(index);
    // Check partial longer roots before substituting a complete shorter root.
    // A lone slash has no private material and may be public URL punctuation.
    if (remaining.length > 1 && knownRoots.some((root) => root.length > remaining.length && root.startsWith(remaining))) break;
    const root = knownRoots.find((candidate) => remaining.startsWith(candidate));
    sanitized += root ? "." : value[index];
    index += root?.length ?? 1;
  }
  return sanitized.replace(
    /\/var\/lib\/aibrain\/data\/users\/[^/\s"'<>]+\/workspace(?=\/|\s|$)/giu,
    ".",
  );
}
