import "server-only";

import type { AuthSession } from "@/auth/types";
import { loadInstallationConfig } from "@/config/installation";
import { operationalLogger } from "@/operations/server-logger";
import type { SupportRequest, SupportRequestInput, SupportReplyInput } from "@/support/contracts";
import { FileSupportRequestStore } from "@/support/store";
import { getProject, getThread } from "@/workbench/store";

type Fetcher = typeof fetch;

function telegramUrl(token: string) {
  return `https://api.telegram.org/bot${token}/sendMessage`;
}

async function notify(request: SupportRequest, fetcher: Fetcher) {
  const webhook = process.env.AIBRAIN_SUPPORT_WEBHOOK_URL?.trim();
  const telegramToken = process.env.AIBRAIN_SUPPORT_TELEGRAM_BOT_TOKEN?.trim();
  const telegramChatId = process.env.AIBRAIN_SUPPORT_TELEGRAM_CHAT_ID?.trim();
  const summary = `[AiBrain ${request.kind}] ${request.description.slice(0, 1_500)}\n${request.context.pathname}\nRequest ${request.id}`;
  if (webhook) {
    const url = new URL(webhook);
    if (url.protocol !== "https:") throw new Error("Support webhook must use HTTPS.");
    const response = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      schemaVersion: 1, requestId: request.id, kind: request.kind, description: request.description,
      context: request.context, createdAt: request.createdAt,
    }), signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Support webhook returned ${response.status}.`);
    return true;
  }
  if (telegramToken && telegramChatId) {
    const response = await fetcher(telegramUrl(telegramToken), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: telegramChatId, text: summary }), signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Telegram returned ${response.status}.`);
    return true;
  }
  return false;
}

export async function supportStoreForSession(session: AuthSession) {
  const installation = await loadInstallationConfig();
  if (session.provider !== "local" || session.tenant.id !== installation.installationId) {
    const error = new Error("La ayuda requiere una cuenta local de esta instalación.") as Error & { code: string };
    error.code = "SUPPORT_IDENTITY_REQUIRED";
    throw error;
  }
  return new FileSupportRequestStore(installation.installationId, session.user.id, installation.paths.usersRoot);
}

export async function listSupportRequests(session: AuthSession) { return (await supportStoreForSession(session)).list(); }
export async function replySupportRequest(session: AuthSession, id: string, input: SupportReplyInput) { return (await supportStoreForSession(session)).reply(id, input); }
export async function readSupportScreenshot(session: AuthSession, id: string, screenshotId: string) { return (await supportStoreForSession(session)).readScreenshot(id, screenshotId); }

export async function createSupportRequest(session: AuthSession, input: SupportRequestInput, fetcher: Fetcher = fetch) {
  const store = await supportStoreForSession(session);
  // Client-supplied UUIDs are not proof of permission to inspect a project/chat.
  try {
    if (input.context.projectId) await getProject(session, input.context.projectId);
    if (input.context.threadId) {
      const thread = await getThread(session, input.context.threadId);
      if (input.context.projectId !== null && thread.projectId !== input.context.projectId) throw new Error("Context mismatch");
    }
  } catch {
    throw Object.assign(new Error("El contexto de soporte no está disponible para esta cuenta."), { code: "SUPPORT_INPUT_INVALID" });
  }
  const request = await store.create(input);
  if (request.notification === "delivered") return request;
  try {
    const delivered = await notify(request, fetcher);
    await store.setNotification(request.id, delivered ? "delivered" : "not_configured");
  } catch (error) {
    await store.setNotification(request.id, "failed").catch(() => undefined);
    operationalLogger.warn("support.notification_failed", { error, supportRequestId: request.id, installationId: request.installationId, userId: session.user.id });
  }
  return request;
}
