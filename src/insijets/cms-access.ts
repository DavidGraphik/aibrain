import { deploymentIdentity } from "@/deployment/identities";
import type { AuthSession } from "../auth/types";
export const CMS_TENANT = "insijets-demo";
export function canAccessInsiJetsCMS(session: AuthSession | null, installationId: string, now = Date.now()) {
  return Boolean(session && session.provider === "local" && installationId === CMS_TENANT &&
    session.tenant.id === CMS_TENANT && Date.parse(session.expiresAt) > now &&
    [deploymentIdentity("operator"), deploymentIdentity("cmsOwner")].includes(session.user.email.toLowerCase()));
}
export function cmsPathAllowed(path: string, method: string) {
  if (/[\\%]|(?:^|\/)\.\.?($|\/)/.test(path)) return false;
  if (method === "GET") return ["/admin", "/api/admin/content", "/api/admin/content/history", "/api/auth/session", "/app.js", "/cms-editor.js", "/app.css", "/brain-cms.css", "/language-controller.mjs"].includes(path) ||
    /^\/(?:uploads|assets|optimized|content-media)\/[-a-zA-Z0-9_.]+$/.test(path);
  return (path === "/api/admin/content" && ["POST", "PUT"].includes(method)) ||
    (["/api/admin/upload", "/api/admin/content/restore"].includes(path) && method === "POST");
}
