/** A source reference is data, never an access grant or a copied document. */
export type ServerReference = {
  path: string;
  name: string;
  kind: "file" | "directory";
  modifiedAt: string | null;
  size: number;
};

export function isServerReference(value: unknown): value is ServerReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== "kind,modifiedAt,name,path,size" ||
      typeof v.path !== "string" || v.path.length > 1024 ||
      !/^server-[a-z0-9][a-z0-9-]{0,62}\/[A-Za-z](?:\/|$)/.test(v.path) ||
      typeof v.name !== "string" || !v.name || v.name.length > 255 || /[\p{C}]/u.test(v.name) ||
      (v.kind !== "file" && v.kind !== "directory") ||
      !(v.modifiedAt === null || typeof v.modifiedAt === "string" && Number.isFinite(Date.parse(v.modifiedAt))) ||
      !Number.isSafeInteger(v.size) || Number(v.size) < 0) return false;
  try {
    return v.path.replace(/\/$/, "").split("/").slice(2).every(raw => {
      const part = decodeURIComponent(raw);
      return !!part && !part.startsWith(".") && !/[\\/:*?<>|"\p{C}]/u.test(part) && !/[. ]$/.test(part);
    });
  } catch { return false; }
}

export function isServerReferenceList(value: unknown): value is ServerReference[] {
  return Array.isArray(value) && value.length <= 5 && value.every(isServerReference) &&
    new Set(value.map(item => item.path.toLowerCase())).size === value.length;
}

export function serverDirectoryQuery(path: string) {
  return `server:/${path.split("/").slice(1).join("/")}`;
}
