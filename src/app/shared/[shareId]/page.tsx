import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/auth/session";
import { MarkdownMessage } from "@/components/markdown-message";
import { loadInstallationConfig } from "@/config/installation";
import { ConversationShareStore } from "@/workbench/conversation-share-store";

export const dynamic = "force-dynamic";

export default async function SharedConversationPage({
  params,
}: {
  params: Promise<{ shareId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { shareId } = await params;
  let productName = "la aplicación";
  let share;
  try {
    const installation = await loadInstallationConfig();
    productName = installation.branding.productName;
    share = await new ConversationShareStore(installation.paths.dataRoot).read(session, shareId);
  } catch {
    notFound();
  }
  return (
    <main className="min-h-dvh bg-[var(--canvas)] px-4 py-6 text-[var(--text)] md:px-8 md:py-10">
      <div className="mx-auto max-w-[768px]">
        <header className="mb-8 border-b border-[var(--border)] pb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="rounded-full bg-[var(--surface-muted)] px-3 py-1 text-[11px] font-medium text-[var(--text-muted)]">Copia interna · solo equipo autenticado</span>
            <Link href="/" className="rounded-full px-3 py-2 text-[12px] font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]">Volver a {productName}</Link>
          </div>
          <p className="mt-6 text-[12px] font-medium text-[var(--text-muted)]">{share.projectName}</p>
          <h1 className="mt-1 text-[28px] font-semibold tracking-[-.03em]">{share.title}</h1>
          <p className="mt-2 text-[11px] text-[var(--text-subtle)]">Compartida por {share.createdBy.name} · {new Date(share.createdAt).toLocaleString("es-ES")}</p>
        </header>
        <div className="space-y-8">
          {share.messages.map((message) => message.role === "user" ? (
            <article key={message.id} className="flex justify-end">
              <div className="min-w-0 max-w-[86%] whitespace-pre-wrap rounded-[22px] bg-[var(--user-message)] px-4 py-2.5 text-[16px] leading-6 text-[var(--user-message-text)] [overflow-wrap:anywhere] md:max-w-[70%]">{message.content}</div>
            </article>
          ) : (
            <article key={message.id} className="max-w-[76ch] text-[16px] leading-7">
              <MarkdownMessage>{message.content || "_(sin contenido)_"}</MarkdownMessage>
            </article>
          ))}
        </div>
      </div>
    </main>
  );
}
