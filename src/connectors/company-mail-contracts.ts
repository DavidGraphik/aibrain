import type { CatalogResource } from "@/catalog/contracts";
import type { GmailConnectionSnapshot } from "@/connectors/gmail-contracts";

export const COMPANY_MAIL_CONNECTOR_ID = "company-mail";
export const COMPANY_MAIL_SCOPES = Object.freeze(["imap:read", "local:invoice-import"]);
export const COMPANY_MAIL_CATALOG_RESOURCE: Readonly<CatalogResource> = Object.freeze({
  id: COMPANY_MAIL_CONNECTOR_ID, kind: "connector", label: "Correo de empresa",
  credentialMode: "personal-credential", managedBy: "graphikai", sharedResource: false,
  appId: null, connectorId: COMPANY_MAIL_CONNECTOR_ID, mcp: null,
});
export type CompanyMailSnapshot = GmailConnectionSnapshot;
export type CompanyMailCredential = { email: string; password: string; folder: string; since: string };
export class CompanyMailError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = "CompanyMailError"; }
}
export function validMailDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function parseCompanyMailCredential(value: unknown, emailDomain: string): CompanyMailCredential {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "email,folder,password,since") throw new CompanyMailError("MAIL_INPUT_INVALID", "Completa los datos del buzón.");
  const v = value as Record<string, unknown>;
  if (typeof v.email !== "string" || v.email.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/u.test(v.email) || v.email.split("@")[1] !== emailDomain ||
      typeof v.password !== "string" || v.password.length < 1 || v.password.length > 1024 || /[\r\n\0]/u.test(v.password) ||
      typeof v.folder !== "string" || v.folder.length < 1 || v.folder.length > 200 || /[\u0000-\u001f\u007f]/u.test(v.folder) || !validMailDate(v.since)) {
    throw new CompanyMailError("MAIL_INPUT_INVALID", "Revisa el correo, la contraseña, la carpeta y la fecha inicial.");
  }
  return { email: v.email, password: v.password, folder: v.folder, since: v.since };
}
