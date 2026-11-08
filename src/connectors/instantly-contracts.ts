import type { CatalogResource } from "@/catalog/contracts";

export const INSTANTLY_CONNECTOR_ID = "instantly";
export const INSTANTLY_OPERATIONS = ["workspace", "accounts", "warmup", "campaigns", "campaign", "leads", "replies", "metrics"] as const;
export type InstantlyOperation = typeof INSTANTLY_OPERATIONS[number];
export const INSTANTLY_CATALOG_RESOURCE: Readonly<CatalogResource> = Object.freeze({
  id: INSTANTLY_CONNECTOR_ID, kind: "connector", label: "Instantly",
  credentialMode: "shared-resource", managedBy: "company", sharedResource: true,
  appId: null, connectorId: INSTANTLY_CONNECTOR_ID, mcp: null,
});
export const INSTANTLY_CREDENTIAL_REF = "server:instantly-workspace-key";
