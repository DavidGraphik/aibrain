"use client";
import { useUiText } from "@/i18n/provider";

import { GlobeIcon, SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ShimmerLabel } from "@/lib/surfaces";

export interface WebSearchResult {
  id: string;
  title: string;
  domain: string | null;
  url: string | null;
  citationIndex?: number;
}

/** Results come from source events; no inferred queries, counts or destinations. */
export function WebSearch({ query, results, searching = false, className }: {
  query?: string;
  results: readonly WebSearchResult[];
  searching?: boolean;
  className?: string;
}) {
  const t = useUiText();
  if (!query && !searching && results.length === 0) return null;
  return (
    <div data-slot="web-search" aria-busy={searching || undefined} className={cn("min-w-0", className)}>
      {query ? <p className="flex items-start gap-2 py-2 text-[12px] break-words text-[var(--text-secondary)]"><SearchIcon className="mt-0.5 size-4 shrink-0" />{query}</p> : null}
      {searching ? <ShimmerLabel className="text-[12px] text-[var(--text-muted)]">{t("Buscando en la web")}</ShimmerLabel> : null}
      {results.map((result) => {
        const content = <>
          <GlobeIcon className="size-4 shrink-0 text-[var(--text-secondary)]" />
          <span className="min-w-0 flex-1"><span className="block break-words text-[12px] font-medium text-[var(--text)]">{result.title}</span><span className="block break-all text-[11px] text-[var(--text-muted)]">{result.domain ?? t("Fuente web")}</span></span>
          {result.citationIndex ? <span className="text-[11px] tabular-nums text-[var(--text-muted)]">{result.citationIndex}</span> : null}
        </>;
        const row = "flex min-h-11 items-center gap-2 rounded-lg px-1.5 py-1.5 focus-visible:ring-2 focus-visible:ring-[var(--focus)]";
        return result.url
          ? <a key={result.id} href={result.url} target="_blank" rel="noreferrer" className={cn(row, "hover:bg-[var(--surface-hover)]")} aria-label={t("Abrir fuente {p0}: {p1}", { p0: result.citationIndex ?? "", p1: result.title })}>{content}</a>
          : <div key={result.id} className={row} aria-label={`Fuente ${result.citationIndex ?? ""}: ${result.title}`}>{content}</div>;
      })}
    </div>
  );
}
