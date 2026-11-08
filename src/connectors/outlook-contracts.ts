import type { CatalogResource } from "@/catalog/contracts";
import type { ConnectorCapabilitySnapshot } from "@/connectors/contracts";

export const OUTLOOK_CONNECTOR_ID = "outlook";
export const OUTLOOK_RESOURCE_ID = "outlook";
export const OUTLOOK_OFFLINE_SCOPE = "offline_access";
export const OUTLOOK_PROFILE_SCOPE = "User.Read";
export const OUTLOOK_MAIL_READ_SCOPE = "Mail.Read";
export const OUTLOOK_API_SCOPES = Object.freeze([OUTLOOK_PROFILE_SCOPE, OUTLOOK_MAIL_READ_SCOPE]);
export const OUTLOOK_OAUTH_SCOPES = Object.freeze([OUTLOOK_OFFLINE_SCOPE, ...OUTLOOK_API_SCOPES]);

export const OUTLOOK_CATALOG_RESOURCE: Readonly<CatalogResource> = Object.freeze({
  id: OUTLOOK_RESOURCE_ID,
  kind: "connector",
  label: "Outlook",
  credentialMode: "personal-oauth",
  managedBy: "graphikai",
  sharedResource: false,
  appId: null,
  connectorId: OUTLOOK_CONNECTOR_ID,
  mcp: null,
});

export type OutlookConnectionSnapshot = ConnectorCapabilitySnapshot & {
  accountEmail: string | null;
  connectionVersion: number | null;
  connectUrl: string | null;
  disconnectUrl: string | null;
};

export type OutlookTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scopes: string[];
  tokenType: "Bearer";
};

export type OutlookProfile = {
  id: string;
  displayName: string;
  emailAddress: string;
  tenantId: string;
};
