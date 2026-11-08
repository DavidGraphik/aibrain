import { deploymentIdentity } from "@/deployment/identities";
import type { AuthSession } from "../auth/types";
import { canAccessInsiJetsCMS } from "./cms-access";
import {
  browseDirectory,
  DIRECTORY_KINDS,
  DirectoryError,
  exportDirectoryCSV,
  type DirectoryFilters,
  type DirectoryKind,
} from "./directory";
import { DirectoryStore } from "./directory-store";
export type DirectoryConfiguration = {
  installationId: string;
  origin: string;
  dataRoot: string;
  enabled: boolean;
  importsEnabled: boolean;
  exportsEnabled: boolean;
  allowSynthetic?: boolean;
};
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
async function boundedJSON(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new DirectoryError("JSON required", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new DirectoryError("Body required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > 8 * 1024 * 1024) {
      await reader.cancel();
      throw new DirectoryError("Import exceeds 8 MiB", 413);
    }
    chunks.push(next.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DirectoryError("Invalid JSON");
  }
}
export function parseDirectoryFilters(
  query: URLSearchParams,
): DirectoryFilters {
  const allowed = [
    "query",
    "region",
    "country",
    "city",
    "airport",
    "model",
    "category",
    "useType",
    "rating",
    "minSeats",
    "hasEmail",
    "page",
    "limit",
    "view",
  ];
  const filters: Record<string, string | number | boolean> = {};
  for (const [key, value] of query) {
    if (
      !allowed.includes(key) ||
      query.getAll(key).length !== 1 ||
      value.length > 300
    )
      throw new DirectoryError("Invalid filter");
    if (["minSeats", "page", "limit"].includes(key)) {
      const n = Number(value);
      if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(n) ||
        n < (key === "minSeats" ? 0 : 1) ||
        n > (key === "page" ? 25000 : key === "limit" ? 100 : 1000)
      )
        throw new DirectoryError("Invalid numeric filter");
      filters[key] = n;
    } else if (key === "hasEmail") {
      if (!["true", "false"].includes(value))
        throw new DirectoryError("Invalid email filter");
      filters[key] = value === "true";
    } else if (key === "view") {
      if (!DIRECTORY_KINDS.includes(value as DirectoryKind))
        throw new DirectoryError("Invalid view");
      filters[key] = value;
    } else filters[key] = value;
  }
  return filters as DirectoryFilters;
}
export async function directoryResponse(
  request: Request,
  operation: "browse" | "import" | "export",
  configuration: DirectoryConfiguration,
  session: AuthSession | null,
  openStore = () =>
    new DirectoryStore(configuration.dataRoot, configuration.allowSynthetic),
) {
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers });
  if (!session) return json({ error: "AUTH_REQUIRED" }, 401);
  if (!canAccessInsiJetsCMS(session, configuration.installationId))
    return json({ error: "DIRECTORY_ACCESS_DENIED" }, 403);
  if (
    request.headers.get("sec-fetch-site") === "cross-site" ||
    (request.method !== "GET" &&
      request.headers.get("origin") !== configuration.origin)
  )
    return json({ error: "ORIGIN_DENIED" }, 403);
  if (!configuration.enabled)
    return json({ error: "DIRECTORY_NOT_CONFIGURED" }, 503);
  if (
    operation === "import" &&
    (!configuration.importsEnabled ||
      session.user.email.toLowerCase() !== deploymentIdentity("operator"))
  )
    return json({ error: "IMPORT_NOT_AUTHORIZED" }, 403);
  if (operation === "export" && !configuration.exportsEnabled)
    return json({ error: "EXPORT_NOT_AUTHORIZED" }, 403);
  const expectedMethod = operation === "browse" ? "GET" : "POST";
  if (request.method !== expectedMethod)
    return json({ error: "METHOD_DENIED" }, 405);
  let store: DirectoryStore | undefined;
  try {
    if (operation !== "browse" && new URL(request.url).search)
      throw new DirectoryError("Query denied");
    const filters =
      operation === "browse"
        ? parseDirectoryFilters(new URL(request.url).searchParams)
        : {};
    const body = operation === "browse" ? null : await boundedJSON(request);
    if (
      operation === "import" &&
      (!body ||
        body.confirmation !== "IMPORT PUBLIC DIRECTORY" ||
        Object.keys(body).some(
          (k) => !["dataset", "confirmation", "expectedRevision"].includes(k),
        ))
    )
      throw new DirectoryError("Explicit import confirmation required");
    if (
      operation === "export" &&
      (!body ||
        body.confirmation !== "EXPORT SELECTED PUBLIC DATA" ||
        !DIRECTORY_KINDS.includes(body.kind) ||
        Object.keys(body).some(
          (k) =>
            !["kind", "ids", "confirmation", "expectedRevision"].includes(k),
        ) ||
        (body.ids !== undefined &&
          (!Array.isArray(body.ids) ||
            body.ids.length > 25000 ||
            body.ids.some(
              (id: unknown) => typeof id !== "string" || id.length > 200,
            ))))
    )
      throw new DirectoryError("Explicit export confirmation required");
    store = openStore();
    if (operation === "import")
      return json(
        store.import(body.dataset, session.user.id, body.expectedRevision),
      );
    const { dataset, revision } = store.snapshot();
    if (operation === "export") {
      if (body.expectedRevision !== revision)
        throw new DirectoryError(
          "The directory changed. Review the export again.",
          409,
        );
      const kind = body.kind as DirectoryKind;
      if (
        body.ids?.some((id: string) => !dataset[kind].some((r) => r.id === id))
      )
        throw new DirectoryError("Unknown selected source id");
      return new Response(exportDirectoryCSV(dataset, kind, body.ids), {
        headers: {
          ...headers,
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="insijets-${kind}${dataset.synthetic ? "-SYNTHETIC" : ""}-r${revision}.csv"`,
        },
      });
    }
    return json({
      ...browseDirectory(dataset, filters),
      revision,
      canImport:
        configuration.importsEnabled &&
        session.user.email.toLowerCase() === deploymentIdentity("operator"),
      canExport: configuration.exportsEnabled,
    });
  } catch (error) {
    return json(
      {
        error:
          error instanceof DirectoryError
            ? error.message
            : "Directory unavailable",
      },
      error instanceof DirectoryError ? error.status : 503,
    );
  } finally {
    store?.close();
  }
}
