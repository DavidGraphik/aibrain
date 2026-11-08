import type { DynamicToolCallParams } from "../../contracts/codex/0.162.1/types/v2/DynamicToolCallParams";
import type { DynamicToolCallResponse } from "../../contracts/codex/0.162.1/types/v2/DynamicToolCallResponse";
import type { DynamicToolSpec } from "../../contracts/codex/0.162.1/types/v2/DynamicToolSpec";
import type { InstallationConfig } from "@/config/installation-schema";
import { readGmailMessage, searchGmail } from "@/connectors/gmail-api";
import { withGmailReadAccess } from "@/connectors/gmail-server-service";

export const AIBRAIN_GMAIL_TOOL_NAMESPACE = "aibrain_gmail";
export const GMAIL_DYNAMIC_TOOLS: readonly DynamicToolSpec[] = Object.freeze([{
  type: "namespace",
  name: AIBRAIN_GMAIL_TOOL_NAMESPACE,
  description: "Read the authenticated employee's connected Gmail when relevant to their request. Read-only; user access and server policy are verified for every call.",
  tools: [
    { type: "function", name: "search", description: "Search Gmail with Gmail query syntax. Read-only.", inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 500 }, maxResults: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"], additionalProperties: false } },
    { type: "function", name: "read", description: "Read one Gmail message by its id. Read-only.", inputSchema: { type: "object", properties: { messageId: { type: "string", minLength: 4, maxLength: 200 } }, required: ["messageId"], additionalProperties: false } },
  ],
}]);

function result(success: boolean, value: unknown): DynamicToolCallResponse { return { success, contentItems: [{ type: "inputText", text: typeof value === "string" ? value : JSON.stringify(value) }] }; }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }

export async function handleGmailDynamicToolCall(params: DynamicToolCallParams, context: { config: Readonly<InstallationConfig>; installationId: string; userId: string; runtimeThreadId: string; runtimeTurnId: string; gmailSelected: boolean; fetcher?: typeof fetch }): Promise<DynamicToolCallResponse> {
  if (params.namespace !== AIBRAIN_GMAIL_TOOL_NAMESPACE || (params.tool !== "search" && params.tool !== "read")) return result(false, "Gmail tool is not supported.");
  if (!context.gmailSelected) return result(false, "Gmail connection is not available or verified for this user.");
  if (context.installationId !== context.config.installationId || params.threadId !== context.runtimeThreadId || params.turnId !== context.runtimeTurnId || !record(params.arguments)) return result(false, "Gmail tool identity does not match this turn.");
  try {
    if (params.tool === "search") {
      if (typeof params.arguments.query !== "string" || params.arguments.query.trim().length === 0 || params.arguments.query.length > 500 || !(params.arguments.maxResults === undefined || Number.isSafeInteger(params.arguments.maxResults) && Number(params.arguments.maxResults) >= 1 && Number(params.arguments.maxResults) <= 20)) return result(false, "Gmail search arguments are invalid.");
      const query = params.arguments.query.trim();
      const maxResults = Number(params.arguments.maxResults ?? 10);
      return result(true, await withGmailReadAccess(context.config, context.userId, (accessToken) => searchGmail(context.fetcher ?? fetch, accessToken, query, maxResults), context.fetcher));
    }
    if (typeof params.arguments.messageId !== "string") return result(false, "Gmail message id is invalid.");
    const messageId = params.arguments.messageId;
    return result(true, await withGmailReadAccess(context.config, context.userId, (accessToken) => readGmailMessage(context.fetcher ?? fetch, accessToken, messageId), context.fetcher));
  } catch (error) { return result(false, error && typeof error === "object" && "code" in error && error.code === "GMAIL_REAUTH_REQUIRED" ? "Gmail requires reconnecting your own account: /api/connectors/gmail/oauth/start" : error instanceof Error ? error.message : "Gmail request failed."); }
}
