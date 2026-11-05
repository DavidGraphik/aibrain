import { NextResponse } from "next/server";
import { isSameOriginMutation } from "@/auth/request-security";
import { getSession } from "@/auth/session";
import { loadInstallationConfig } from "@/config/installation";
import { ConversationShareStore } from "@/workbench/conversation-share-store";
import { workbenchErrorResponse } from "@/workbench/http";
import { getProject, getThread } from "@/workbench/store";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const { threadId } = await context.params;
  try {
    const thread = await getThread(session, threadId);
    const project = await getProject(session, thread.projectId);
    const installation = await loadInstallationConfig();
    const share = await new ConversationShareStore(installation.paths.dataRoot).create(session, project, thread);
    return NextResponse.json({
      share: { id: share.id, createdAt: share.createdAt, url: `/shared/${share.id}` },
    }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return workbenchErrorResponse(error, "No s’ha pogut compartir la conversa.");
  }
}
