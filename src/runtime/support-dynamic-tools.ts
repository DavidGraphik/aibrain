import "server-only";
import { createHash } from "node:crypto";
import type { DynamicToolCallParams } from "../../contracts/codex/0.162.1/types/v2/DynamicToolCallParams";
import type { DynamicToolCallResponse } from "../../contracts/codex/0.162.1/types/v2/DynamicToolCallResponse";
import type { AuthSession } from "@/auth/types";
import type { ChatInputAttachment } from "@/lib/chat-contract";
import { loadInstallationConfig } from "@/config/installation";
import { parseSupportRequestInput, type SupportRequest } from "@/support/contracts";
import { FileSupportRequestStore } from "@/support/store";
import { createSupportRequest } from "@/support/server-service";
import { SUPPORT_NAMESPACE } from "./support-tool-contract";
import { supportReference, supportRequestId } from "./support-reference";
import { publicActivityText } from "@/ui/public-activity";

const PRIVATE_INSTALLATIONS = new Set(["trinalum-production", "g03-production", "insijets-demo", "modtime"]);
export function supportAvailable(installationId: string) { return PRIVATE_INSTALLATIONS.has(installationId); }
const result = (success: boolean, value: unknown): DynamicToolCallResponse => ({ success, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] });
/** Project only case fields needed for support. Identity/context, client keys,
 * worker evidence and attachment IDs are never needed by chat consumers. */
function caseForChat(request: SupportRequest) {
  const reference = supportReference(request.id);
  return {
    id: reference, reference,
    kind: request.kind, status: request.status,
    description: publicActivityText(request.description, 10_000),
    createdAt: request.createdAt, updatedAt: request.updatedAt,
    messages: (request.messages ?? []).map(message => ({
      author: message.author, body: publicActivityText(message.body, 10_000), createdAt: message.createdAt,
    })),
    screenshots: (request.screenshots ?? []).map(image => ({
      name: publicActivityText(image.name, 160), mimeType: image.mimeType, size: image.size,
    })),
  };
}
function identity(value: unknown) {
  const h = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export type SupportToolContext = {
  session?: AuthSession; installationId: string; userId: string; runtimeThreadId: string; runtimeTurnId: string;
  projectId: string | null; threadId: string; humanMessage: string; screenshots: ChatInputAttachment[]; backgroundExecution: boolean;
  documentImages?: Array<{ id: string; name: string; mimeType: string; size: number; load: () => Promise<Buffer> }>;
};
export async function handleSupportTool(params: DynamicToolCallParams, context: SupportToolContext): Promise<DynamicToolCallResponse> {
  const session = context.session;
  if (params.namespace !== SUPPORT_NAMESPACE || !session || session.provider !== "local" || context.backgroundExecution ||
      !supportAvailable(context.installationId) || session.tenant.id !== context.installationId || session.user.id !== context.userId ||
      !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now() ||
      params.threadId !== context.runtimeThreadId || params.turnId !== context.runtimeTurnId || !context.humanMessage.trim()) {
    return result(false, { code: "SUPPORT_IDENTITY_INVALID" });
  }
  try {
    const args = params.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("arguments");
    const keys = Object.keys(args);
    const config = await loadInstallationConfig();
    if (config.installationId !== context.installationId) return result(false, { code: "SUPPORT_IDENTITY_INVALID" });
    const store = new FileSupportRequestStore(config.installationId, session.user.id, config.paths.usersRoot);
    if (params.tool === "list" && keys.length === 0) {
      const requests = (await store.list()).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return result(true, { untrustedData: true, requests: requests.slice(0, 30).map(caseForChat), hasMore: requests.length > 30, inbox: "/?support=open" });
    }
    if (params.tool === "read" && keys.every(k => k === "id") && supportRequestId(args.id) !== null) {
      const request = (await store.list()).find(item => item.id === supportRequestId(args.id));
      return request ? result(true, { untrustedData: true, request: caseForChat(request) }) : result(false, { code: "SUPPORT_NOT_FOUND" });
    }
    if (params.tool === "reply" && keys.every(k => ["id", "body"].includes(k)) && supportRequestId(args.id) !== null && typeof args.body === "string") {
      const request = await store.reply(supportRequestId(args.id)!, { body: args.body, clientRequestId: identity([context.runtimeTurnId, "reply", args]) });
      return result(true, { untrustedData: true, request: caseForChat(request) });
    }
    if (params.tool === "create" && keys.every(k => ["kind", "description", "screenshotIndices"].includes(k))) {
      const sources = [
        ...context.screenshots.map(image => ({ ...image, load: async () => image.dataUrl })),
        ...(context.documentImages ?? []).map(image => ({ ...image, load: async () => `data:${image.mimeType};base64,${(await image.load()).toString("base64")}` })),
      ];
      const indices = args.screenshotIndices ?? sources.slice(0, 3).map((_, index) => index);
      if (!Array.isArray(indices) || indices.length > 3 || new Set(indices).size !== indices.length || indices.some(i => !Number.isInteger(i) || typeof i !== "number" || i < 0 || !sources[i])) throw new Error("screenshots");
      const input = parseSupportRequestInput({ kind: args.kind, description: args.description,
        clientRequestId: identity([context.runtimeTurnId, "create", args]),
        context: { pathname: "/", projectId: context.projectId, threadId: context.threadId, viewport: "desktop" },
        screenshots: await Promise.all(indices.map(async i => { const image = sources[i as number]; return { name: image.name, mimeType: image.mimeType, dataUrl: await image.load() }; })),
      });
      if (!input) throw new Error("input");
      return result(true, { received: true, ...caseForChat(await createSupportRequest(session, input)), message: "Solicitud recibida. El seguimiento y las respuestas aparecen en Ayuda de AiBrain." });
    }
    return result(false, { code: "SUPPORT_ARGUMENTS_INVALID" });
  } catch { return result(false, { code: "SUPPORT_REQUEST_FAILED", message: "No se ha podido tramitar la solicitud de soporte. No se ha marcado como resuelta." }); }
}
