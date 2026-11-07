import type { CatalogResource } from "@/catalog/contracts";
import type { ConnectorCapabilitySnapshot } from "@/connectors/contracts";

export const GMAIL_CONNECTOR_ID = "gmail";
export const GMAIL_RESOURCE_ID = "gmail";
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_MINIMUM_SCOPES = Object.freeze([GMAIL_READONLY_SCOPE]);

export const GMAIL_CATALOG_RESOURCE: Readonly<CatalogResource> = Object.freeze({
  id: GMAIL_RESOURCE_ID,
  kind: "connector",
  label: "Gmail",
  credentialMode: "personal-oauth",
  managedBy: "graphikai",
  sharedResource: false,
  appId: null,
  connectorId: GMAIL_CONNECTOR_ID,
  mcp: null,
});

export type GmailConnectionSnapshot = ConnectorCapabilitySnapshot & {
  accountEmail: string | null;
  connectionVersion: number | null;
  connectUrl: string | null;
  disconnectUrl: string | null;
};

export type GmailTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scopes: string[];
  tokenType: "Bearer";
};

export type GmailProfile = {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
};
