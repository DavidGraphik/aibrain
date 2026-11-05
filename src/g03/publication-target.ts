/** Logical paths only. Neither browser nor model receives host paths or sockets. */
export const G03_DOCUMENT_ROOTS = [
  "M/G03/ADMINISTRACIO", "C/Compartida", "M/G03/G03", "M/G03-JKV", "M/G03/JUAN",
  "M/G03/PLANOLS", "M/G03/PRODUCCIO", "M/G03/PROJECTES", "M/G03/QUALITAT", "M/G03/RAFAEL",
] as const;

export function g03PublicationTarget(value: string) {
  if (typeof value !== "string" || value.length > 500 || !value.startsWith("server-g03/")) {
    throw new Error("PUBLICATION_PATH_INVALID");
  }
  const parts = value.slice(11).split("/").map((part) => decodeURIComponent(part));
  if (parts.length < 3 || !/^[A-Z]$/.test(parts[0])) throw new Error("PUBLICATION_PATH_INVALID");
  for (const part of parts.slice(1)) {
    if (!part || part.length > 255 || part.startsWith(".") || /[\\/:*?<>|"%\p{C}]/u.test(part) || /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(part) ||
        /(^|[._ -])(secrets?|credentials?|passwords?|passwd|tokens?|private.?key|backups?|c[oò]pies|copias)([._ -]|$)/iu.test(part)) {
      throw new Error("PUBLICATION_PATH_INVALID");
    }
  }
  const decoded = parts.join("/");
  if (!G03_DOCUMENT_ROOTS.some((root) => decoded.toLowerCase().startsWith(root.toLowerCase() + "/")) ||
      !/\.(pdf|docx|xlsx|txt|csv|md)$/i.test(parts.at(-1)!)) throw new Error("PUBLICATION_PATH_INVALID");
  return "server-g03/" + parts.map(encodeURIComponent).join("/");
}
