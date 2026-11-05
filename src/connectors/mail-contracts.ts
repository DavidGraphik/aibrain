import type { CatalogResource } from "@/catalog/contracts";
export const MAIL_CONNECTOR_ID = "mail";
export const MAIL_RESOURCE_ID = "mail";
// The existing catalog calls per-user secrets personal-oauth; password entry
// is selected by the connector's connectionMethod rather than this legacy enum.
// Keep the installed catalog identity stable; the capability supplies the display label.
export const MAIL_CATALOG_RESOURCE: Readonly<CatalogResource> = Object.freeze({ id: MAIL_RESOURCE_ID, kind: "connector", label: "Correo Nominalia", credentialMode: "personal-oauth", managedBy: "graphikai", sharedResource: false, appId: null, connectorId: MAIL_CONNECTOR_ID, mcp: null });
export type MailCredentials = { email: string; password: string };
export type MailMessageRef = { folder: string; uid: string; uidValidity: string };
export type MailDraftRef = MailMessageRef & { fingerprint: string };
export type MailAttachment = { filename: string; contentType: string; dataBase64: string };
export type MailPayload = { from: string; to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; attachments: MailAttachment[]; messageId: string; inReplyTo?: string; references?: string; draft?: MailDraftRef };
export type MailOperation = "verify" | "folders" | "list" | "search" | "read" | "attachment" | "reply" | "draft_payload" | "draft" | "send" | "flags" | "move";
export type MailTransport = (operation: MailOperation, credentials: MailCredentials, args: Record<string, unknown>) => Promise<unknown>;
export class MailConnectorError extends Error {
  constructor(readonly code: string, readonly status = 400) { super("No se ha podido completar la operación de correo."); this.name = "MailConnectorError"; }
}
export function mailErrorCode(error: unknown) { return error instanceof MailConnectorError ? error.code : "MAIL_REQUEST_FAILED"; }
export function isMailRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
