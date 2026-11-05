"use client";
import type { UiText } from "@/i18n/messages";
import { useUiLocale } from "@/i18n/provider";
import { useUiText } from "@/i18n/provider";

import { BookOpenText, CalendarBlank, CaretDown, File, Globe, LinkSimple } from "@phosphor-icons/react";
import { WebSearch } from "@/components/assistant-ui/elements/web-search";
import { DocumentReference } from "@/components/assistant-ui/elements/document-reference";
import type { TurnSource } from "@/lib/chat-contract";

function sourceLabel(source: TurnSource, t: UiText) {
  return source.domain ?? (source.kind === "file" ? t("Archivo adjunto") : t("Aplicación"));
}

function sourceIcon(source: TurnSource, size = 14) {
  return source.kind === "web"
    ? <Globe size={size} />
    : source.kind === "file" ? <File size={size} /> : <LinkSimple size={size} />;
}

export function TurnSourceChips({ sources }: { sources: readonly TurnSource[] }) {
  const t = useUiText();
  if (sources.length === 0) return null;
  return (
    <section aria-label={t("Fuentes de la respuesta")} className="mt-4">
      <details className="group/sources">
        <summary className="-ml-1 flex min-h-8 w-fit cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-[12px] font-medium text-[var(--text-muted)] outline-none transition-colors hover:text-[var(--text)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]">
          <BookOpenText size={15} />
          <span>{t("Fuentes")}</span>
          <span className="rounded-full bg-[var(--surface-muted)] px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">{sources.length}</span>
          <CaretDown size={13} className="transition-transform duration-150 group-open/sources:rotate-180" />
        </summary>
        <ol className="mt-1 grid gap-0.5" aria-label={t("Lista de fuentes de la respuesta")}>
          {sources.map((source, index) => {
            if (source.kind === "web") return <li key={source.id}><WebSearch results={[{ id: source.id, title: source.title, domain: source.domain, url: source.url, citationIndex: index + 1 }]} /></li>;
            if (source.kind === "file") return <li key={source.id}><DocumentReference title={source.title} url={source.url} snippet={source.snippet} citationIndex={index + 1} /></li>;
            const content = (
              <>
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--surface-muted)] text-[var(--text-secondary)]">{sourceIcon(source, 13)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium text-[var(--text)]">{source.title}</span>
                  <span className="block truncate text-[10px] text-[var(--text-subtle)]">{sourceLabel(source, t)}</span>
                </span>
                <span className="grid size-5 shrink-0 place-items-center rounded-md bg-[var(--surface-muted)] text-[10px] font-semibold tabular-nums text-[var(--text-muted)]">{index + 1}</span>
              </>
            );
            const className = "group/source flex min-h-10 items-center gap-2 rounded-lg px-1.5 py-1 outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]";
            return <li key={source.id}>{source.url ? (
              <a href={source.url} target="_blank" rel="noreferrer" className={className} aria-label={t("Abrir fuente {p0}: {p1}", { p0: index + 1, p1: source.title })}>{content}</a>
            ) : (
              <div className={className} aria-label={t("Fuente {p0}: {p1}", { p0: index + 1, p1: source.title })}>{content}</div>
            )}</li>;
          })}
        </ol>
      </details>
    </section>
  );
}

export function TurnSourceList({ sources }: { sources: readonly TurnSource[] }) {
  const locale = useUiLocale();
  const t = useUiText();
  if (sources.length === 0) {
    return (
      <div className="grid min-h-52 place-items-center px-5 py-8 text-center">
        <div className="max-w-60">
          <span className="mx-auto grid size-10 place-items-center rounded-xl bg-[var(--surface-muted)] text-[var(--text-secondary)]"><Globe size={18} /></span>
          <p className="mt-3 text-[12px] font-semibold text-[var(--text)]">{t("Sin fuentes verificables")}</p>
          <p className="mt-1.5 text-[11px] leading-5 text-[var(--text-muted)]">{t("Este turno no ha entregado URLs ni archivos como metadatos. La aplicación no crea citas a partir del texto de la respuesta.")}</p>
        </div>
      </div>
    );
  }
  return (
    <ol aria-label={t("Fuentes del turno")} className="space-y-2.5">
      {sources.map((source, index) => (
        <li key={source.id} className="rounded-[16px] border border-[var(--border)] bg-[var(--surface-raised)] p-3">
          <div className="flex items-start gap-2.5">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-[var(--surface-muted)] text-[var(--text-secondary)]">{sourceIcon(source)}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <p className="text-[12px] font-semibold leading-5 text-[var(--text)]">{index + 1}. {source.title}</p>
                <span className="shrink-0 rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[9px] font-medium text-[var(--text-muted)]">{sourceLabel(source, t)}</span>
              </div>
              {source.snippet ? <p className="mt-1.5 text-[11px] leading-[18px] text-[var(--text-muted)]">{source.snippet}</p> : null}
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-[var(--text-subtle)]">
                {source.publishedAt ? <span className="inline-flex items-center gap-1"><CalendarBlank size={11} />{new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(source.publishedAt))}</span> : null}
                {source.url ? <a href={source.url} target="_blank" rel="noreferrer" className="inline-flex min-h-8 items-center gap-1 rounded-full px-2 font-medium text-[var(--brain-accent)] hover:bg-[var(--surface-hover)]"><LinkSimple size={11} />{t("Abrir fuente")}</a> : <span>{t("Fuente local, sin enlace")}</span>}
              </div>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
