"use client";
import { useUiText } from "@/i18n/provider";

import { FileTextIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DocumentAnchor { page: number; quote: string }

/** Page counts and anchors are optional: source metadata does not supply them. */
export function DocumentReference({ title, url, snippet, citationIndex, pages, anchors = [], activePage, onJump, className }: {
  title: string;
  url?: string | null;
  snippet?: string | null;
  citationIndex?: number;
  pages?: number;
  anchors?: readonly DocumentAnchor[];
  activePage?: number;
  onJump?: (page: number) => void;
  className?: string;
}) {
  const t = useUiText();
  const content = <>
    <FileTextIcon className="size-4 shrink-0 text-[var(--text-secondary)]" />
    <span className="min-w-0 flex-1">
      <span className="block break-words text-[12px] font-medium text-[var(--text)]">{title}</span>
      <span className="block text-[11px] text-[var(--text-muted)]">{pages === undefined ? t("Archivo adjunto") : `${pages} ${pages === 1 ? t("página") : t("páginas")}`}</span>
    </span>
    {citationIndex ? <span className="text-[11px] tabular-nums text-[var(--text-muted)]">{citationIndex}</span> : null}
  </>;
  const row = "flex min-h-11 items-center gap-2 rounded-lg px-1.5 py-1.5 focus-visible:ring-2 focus-visible:ring-[var(--focus)]";
  return (
    <div data-slot="document-reference" className={cn("min-w-0", className)}>
      {url ? <a href={url} target="_blank" rel="noreferrer" className={cn(row, "hover:bg-[var(--surface-hover)]")} aria-label={t("Abrir fuente {p0}: {p1}", { p0: citationIndex ?? "", p1: title })}>{content}</a> : <div className={row} aria-label={`Fuente ${citationIndex ?? ""}: ${title}`}>{content}</div>}
      {snippet ? <p className="mb-2 pl-7 text-[12px] leading-relaxed break-words text-[var(--text-muted)]">{snippet}</p> : null}
      {anchors.map((anchor, index) => <button key={`${anchor.page}-${index}`} type="button" disabled={!onJump} aria-current={anchor.page === activePage || undefined} onClick={() => onJump?.(anchor.page)} className="block min-h-11 w-full rounded-lg px-3 py-2 text-left text-[12px] text-[var(--text-secondary)] enabled:hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]"><span className="font-medium">{t("Pág.")}{" "}{anchor.page}</span><span className="block break-words">{anchor.quote}</span></button>)}
    </div>
  );
}
