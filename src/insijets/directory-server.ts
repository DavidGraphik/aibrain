import "server-only";
import { getSession } from "@/auth/session";
import { loadInstallationConfig } from "@/config/installation";
import { directoryResponse } from "./directory-api";
export async function handleDirectory(
  request: Request,
  operation: "browse" | "import" | "export",
) {
  const session = await getSession();
  if (!session)
    return Response.json(
      { error: "AUTH_REQUIRED" },
      { status: 401, headers: { "Cache-Control": "private, no-store" } },
    );
  const installation = await loadInstallationConfig();
  return directoryResponse(
    request,
    operation,
    {
      installationId: installation.installationId,
      origin: new URL(installation.publicUrl).origin,
      dataRoot: installation.paths.dataRoot,
      enabled: process.env.AIBRAIN_INSIJETS_DIRECTORY_ENABLED === "true",
      importsEnabled:
        process.env.AIBRAIN_INSIJETS_DIRECTORY_IMPORT_ENABLED === "true",
      exportsEnabled:
        process.env.AIBRAIN_INSIJETS_DIRECTORY_EXPORT_ENABLED === "true",
    },
    session,
  );
}
