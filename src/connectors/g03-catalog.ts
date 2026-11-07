import type { CatalogResource } from "@/catalog/contracts";

/** Server-provisioned read-only access; remains pending until private config and identity access exist. */
export const G03_SAGE_RESOURCE: CatalogResource = {
  id: "g03-sage", kind: "connector", label: "Sage", credentialMode: "none",
  managedBy: "graphikai", sharedResource: false, appId: null, connectorId: "g03-sage", mcp: null,
};
export const G03_SAGE_HEALTH = { status: "not_configured", statusCode: "G03_SAGE_API_PENDING" } as const;
