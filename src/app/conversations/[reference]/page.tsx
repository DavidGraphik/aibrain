import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/auth/session";
import { MarkdownMessage } from "@/components/markdown-message";
import { publicAssistantText } from "@/ui/public-activity";
import { publicReferencesForResults } from "@/lib/public-references";
import { readConversationReference } from "@/workbench/conversation-reference";
import { WorkbenchNotFoundError } from "@/workbench/errors";

export const dynamic = "force-dynamic";

/** Live read-only source, never a public share or a copied conversation. */
export default async function ConversationReferencePage({ params }: { params: Promise<{ reference: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { reference } = await params;
  const thread = await readConversationReference(session, reference).catch(error => {
    if (error instanceof WorkbenchNotFoundError) notFound();
    throw error;
  });
  return (
    <main className="min-h-dvh bg-[var(--canvas)] px-4 py-6 text-[var(--text)] md:px-8 md:py-10">
      <div className="mx-auto max-w-[768px]">
        <header className="mb-8 border-b border-[var(--border)] pb-6">
          <Link href="/">Volver a mis chats</Link>
          <p className="mt-6 text-sm text-[var(--text-muted)]">Conversación original · solo lectura{thread.status === "archived" ? " · archivada" : ""}</p>
          <h1 className="mt-2 text-2xl font-semibold">{thread.title}</h1>
        </header>
        <div className="space-y-8">
          {thread.messages.map(message => (
            <article key={message.id} className="min-w-0 [overflow-wrap:anywhere]">
              <p className="mb-2 text-sm text-[var(--text-muted)]">{message.role === "user" ? "Usuario" : "Asistente"} · <time dateTime={message.createdAt}>{message.createdAt}</time></p>
              {message.role === "user" ? <p className="whitespace-pre-wrap">{message.content}</p> : <MarkdownMessage>{publicAssistantText(message.content, "el asistente", 128_000, {
                publicReferences: publicReferencesForResults(message.toolResults), privateReferences: [message.id, thread.id, thread.projectId],
              })}</MarkdownMessage>}
              {message.attachments.length ? <ul className="mt-2 text-sm">{message.attachments.map(attachment => <li key={attachment.id}>{attachment.name}</li>)}</ul> : null}
            </article>
          ))}
        </div>
      </div>
    </main>
  );
}
