export const SUPPORT_KINDS = ["bug", "request", "help"] as const;
export type SupportKind = typeof SUPPORT_KINDS[number];
export const SUPPORT_STATUSES = ["queued", "investigating", "working", "verifying", "resolved", "escalated", "declined", "needs_information"] as const;
export type SupportStatus = typeof SUPPORT_STATUSES[number];
export const SUPPORT_SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const SUPPORT_SCREENSHOT_MAX_COUNT = 3;
export const SUPPORT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type SafeSupportContext = { pathname: string; projectId: string | null; threadId: string | null; viewport: "mobile" | "desktop" };
export type SupportScreenshotInput = { name: string; mimeType: "image/png" | "image/jpeg" | "image/webp"; dataUrl: string };
export type SupportScreenshot = { id: string; name: string; mimeType: SupportScreenshotInput["mimeType"]; size: number };
export type SupportMessage = { id: string; author: "user" | "support"; body: string; createdAt: string; clientRequestId?: string };
export type SupportResolutionEvidence = { revision: string; installationId: string; checkedAt: string; url: string };
export type SupportRequestInput = { kind: SupportKind; description: string; context: SafeSupportContext; clientRequestId?: string; screenshots?: SupportScreenshotInput[] };
export type SupportReplyInput = { body: string; clientRequestId: string };
export type SupportRequest = Omit<SupportRequestInput, "screenshots"> & {
  schemaVersion: 1; id: string; installationId: string; userId: string; createdAt: string;
  notification: "not_configured" | "delivered" | "failed";
  status: SupportStatus; updatedAt: string; messages: SupportMessage[]; screenshots: SupportScreenshot[];
  evidence?: SupportResolutionEvidence;
};
export function isSupportRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
export function validSupportText(value: unknown, limit = 10_000): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= limit && !/\p{C}/u.test(value.replace(/[\n\r\t]/g, ""));
}
export function parseSupportReplyInput(value: unknown): SupportReplyInput | null {
  if (!isSupportRecord(value) || Object.keys(value).some((key) => !["body", "clientRequestId"].includes(key)) || !validSupportText(value.body) || typeof value.clientRequestId !== "string" || !SUPPORT_UUID.test(value.clientRequestId)) return null;
  return { body: value.body.trim(), clientRequestId: value.clientRequestId };
}
export function parseSupportRequestInput(value: unknown): SupportRequestInput | null {
  if (!isSupportRecord(value) || Object.keys(value).some((key) => !["kind", "description", "context", "clientRequestId", "screenshots"].includes(key)) || !SUPPORT_KINDS.includes(value.kind as SupportKind) || !validSupportText(value.description) || !isSupportRecord(value.context)) return null;
  const context = value.context;
  if (Object.keys(context).some((key) => !["pathname", "projectId", "threadId", "viewport"].includes(key)) || typeof context.pathname !== "string" || !context.pathname.startsWith("/") || context.pathname.startsWith("//") || context.pathname.length > 300 || /[?#\p{C}]/u.test(context.pathname) || (context.projectId !== null && (typeof context.projectId !== "string" || !SUPPORT_UUID.test(context.projectId))) || (context.threadId !== null && (typeof context.threadId !== "string" || !SUPPORT_UUID.test(context.threadId))) || (context.viewport !== "mobile" && context.viewport !== "desktop") || (value.clientRequestId !== undefined && (typeof value.clientRequestId !== "string" || !SUPPORT_UUID.test(value.clientRequestId)))) return null;
  const screenshots: SupportScreenshotInput[] = [];
  if (value.screenshots !== undefined) {
    if (!Array.isArray(value.screenshots) || value.screenshots.length > SUPPORT_SCREENSHOT_MAX_COUNT) return null;
    for (const shot of value.screenshots) {
      if (!isSupportRecord(shot) || Object.keys(shot).some((key) => !["name", "mimeType", "dataUrl"].includes(key)) || typeof shot.name !== "string" || !shot.name.trim() || shot.name.length > 160 || /[/\\\p{C}]/u.test(shot.name) || !["image/png", "image/jpeg", "image/webp"].includes(String(shot.mimeType)) || typeof shot.dataUrl !== "string" || shot.dataUrl.length > Math.ceil(SUPPORT_SCREENSHOT_MAX_BYTES / 3) * 4 + 50 || !new RegExp(`^data:${shot.mimeType};base64,[A-Za-z0-9+/]+={0,2}$`).test(shot.dataUrl)) return null;
      screenshots.push({ name: shot.name, mimeType: shot.mimeType as SupportScreenshotInput["mimeType"], dataUrl: shot.dataUrl });
    }
  }
  return { kind: value.kind as SupportKind, description: value.description.trim(), context: { pathname: context.pathname, projectId: context.projectId as string | null, threadId: context.threadId as string | null, viewport: context.viewport }, ...(value.clientRequestId ? { clientRequestId: value.clientRequestId as string } : {}), ...(value.screenshots !== undefined ? { screenshots } : {}) };
}
