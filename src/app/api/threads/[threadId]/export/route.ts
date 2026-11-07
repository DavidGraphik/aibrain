import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { conversationJson, conversationMarkdown, safeExportName } from "@/workbench/conversation-export";
import { workbenchErrorResponse } from "@/workbench/http";
import { getProject, getThread } from "@/workbench/store";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => key !== "format") || params.getAll("format").length !== 1) {
    return NextResponse.json({ error: "Format d’exportació no vàlid." }, { status: 400 });
  }
  const format = params.get("format");
  if (format !== "markdown" && format !== "json") {
    return NextResponse.json({ error: "Format d’exportació no vàlid." }, { status: 400 });
  }
  const { threadId } = await context.params;
  try {
    const thread = await getThread(session, threadId);
    const project = await getProject(session, thread.projectId);
    const content = format === "markdown"
      ? conversationMarkdown(project, thread)
      : conversationJson(project, thread);
    const extension = format === "markdown" ? "md" : "json";
    return new Response(content, {
      headers: {
        "Content-Type": format === "markdown" ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeExportName(thread.title)}.${extension}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return workbenchErrorResponse(error, "No s’ha pogut exportar la conversa.");
  }
}
