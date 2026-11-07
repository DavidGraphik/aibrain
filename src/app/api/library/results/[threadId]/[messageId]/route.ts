import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { contentDisposition } from "@/library/http";
import { getThread } from "@/workbench/store";
import { isUuid } from "@/workbench/types";

export const runtime = "nodejs";

function safeStem(value: string) {
  return value.normalize("NFKD").replace(/[^A-Za-z0-9 -]/g, "-").replace(/\s+/g, "-")
    .replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "resultado";
}
export async function GET(
  _request: Request,
  context: { params: Promise<{ threadId: string; messageId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const { threadId, messageId } = await context.params;
  if (!isUuid(threadId) || !isUuid(messageId)) {
    return NextResponse.json({ error: "Resultado no válido." }, { status: 400 });
  }
  try {
    const thread = await getThread(session, threadId);
    const message = thread.messages.find((candidate) =>
      candidate.id === messageId && candidate.role === "assistant" && candidate.status !== "streaming");
    if (!message?.content.trim()) {
      return NextResponse.json({ error: "Resultado no encontrado." }, { status: 404 });
    }
    const fileName = `${safeStem(thread.title)}.md`;
    const markdown = `# ${thread.title}\n\n${message.content.trim()}\n`;
    return new Response(markdown, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": contentDisposition(fileName, "attachment"),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "Resultado no encontrado." }, { status: 404 });
  }
}
