"use client";
import { useUiText } from "@/i18n/provider";

import { useEffect, useMemo, useState } from "react";
import { ChartBar, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { isVisualizationSpec, type VisualizationSpec } from "@/artifacts/contracts";

function responseSpec(value: unknown): VisualizationSpec | null {
  if (!value || typeof value !== "object" || !("snapshot" in value) || !value.snapshot ||
      typeof value.snapshot !== "object" || !("content" in value.snapshot) || !value.snapshot.content ||
      typeof value.snapshot.content !== "object" || !("kind" in value.snapshot.content) ||
      value.snapshot.content.kind !== "visualization" || !("spec" in value.snapshot.content) ||
      !isVisualizationSpec(value.snapshot.content.spec)) return null;
  return value.snapshot.content.spec;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(value);
}

export function SafeVisualizationPreview({ artifactId, title }: { artifactId: string; title: string }) {
  const t = useUiText();
  const [spec, setSpec] = useState<VisualizationSpec | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [seriesIndex, setSeriesIndex] = useState(0);
  const [focusedRow, setFocusedRow] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) {
        setLoading(true);
        setFailed(false);
      }
      return fetch(`/api/artifacts/${encodeURIComponent(artifactId)}`, { cache: "no-store", signal: controller.signal });
    })
      .then(async (response) => response.ok ? responseSpec(await response.json()) : null)
      .then((next) => {
        if (controller.signal.aborted) return;
        setSpec(next);
        setFailed(!next);
        setSeriesIndex(0);
        setFocusedRow(null);
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [artifactId]);

  const bounds = useMemo(() => {
    if (!spec) return { lower: 0, range: 1 };
    const values = spec.rows.map((row) => row.values[seriesIndex]);
    const lower = Math.min(0, ...values);
    const upper = Math.max(0, ...values);
    return { lower, range: upper - lower || 1 };
  }, [seriesIndex, spec]);

  if (loading) return <div role="status" aria-busy="true" className="flex h-full min-h-64 items-center justify-center gap-2 text-[12px] text-[var(--text-subtle)]"><SpinnerGap size={16} className="motion-safe:animate-spin" />{t("Preparando visualización…")}</div>;
  if (failed || !spec) return <div role="alert" className="grid min-h-64 place-items-center px-8 text-center"><div><WarningCircle size={24} className="mx-auto text-[var(--danger)]" /><p className="mt-3 text-[12px] text-[var(--text-secondary)]">{t("No se ha podido abrir esta visualización.")}</p></div></div>;

  return (
    <div className="w-full p-4 sm:p-6" aria-label={t("Visualización interactiva: {p0}", { p0: title })}>
      <div className="flex items-center gap-2"><ChartBar size={18} className="text-[var(--text-secondary)]" /><h4 className="text-[14px] font-semibold text-[var(--text)]">{spec.title}</h4></div>
      {spec.series.length > 1 ? <div className="mt-4 flex flex-wrap gap-1" role="tablist" aria-label={t("Series")} onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='tab']"));
        const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (current + 1) % tabs.length : (current - 1 + tabs.length) % tabs.length;
        tabs[next]?.focus();
        tabs[next]?.click();
      }}>
        {spec.series.map((series, index) => <button key={series.name} id={`visualization-series-${artifactId}-${index}`} type="button" role="tab" aria-selected={seriesIndex === index} aria-controls={`visualization-data-${artifactId}`} tabIndex={seriesIndex === index ? 0 : -1} className={`touch-target min-h-10 rounded-full px-3 text-[12px] font-medium ${seriesIndex === index ? "bg-[var(--text)] text-[var(--surface)]" : "bg-[var(--surface-muted)] text-[var(--text-secondary)]"}`} onClick={() => { setSeriesIndex(index); setFocusedRow(null); }}>{series.name}</button>)}
      </div> : null}
      <div id={`visualization-data-${artifactId}`} role={spec.series.length > 1 ? "tabpanel" : undefined} aria-labelledby={spec.series.length > 1 ? `visualization-series-${artifactId}-${seriesIndex}` : undefined} className="mt-5 space-y-2.5">
        {spec.rows.map((row, index) => {
          const value = row.values[seriesIndex];
          const start = ((Math.min(value, 0) - bounds.lower) / bounds.range) * 100;
          const width = Math.max(1, (Math.abs(value) / bounds.range) * 100);
          const active = focusedRow === index;
          return <button key={`${row.label}-${index}`} type="button" aria-pressed={active} className="touch-target group grid min-h-11 w-full grid-cols-[minmax(70px,140px)_1fr_auto] items-center gap-3 text-left" onClick={() => setFocusedRow(active ? null : index)}>
            <span className="truncate text-[12px] font-medium text-[var(--text-secondary)]" title={row.label}>{row.label}</span>
            <span className="relative h-5 overflow-hidden rounded-full bg-[var(--surface-muted)]"><span className="absolute inset-y-0 rounded-full bg-[var(--brain-accent)] transition-[width,filter] group-hover:brightness-110" style={{ left: `${start}%`, width: `${width}%` }} /></span>
            <span className={`min-w-14 text-right text-[12px] tabular-nums ${active ? "font-semibold text-[var(--text)]" : "text-[var(--text-subtle)]"}`}>{formatNumber(value)}</span>
          </button>;
        })}
      </div>
      <p className="mt-4 text-[12px] leading-5 text-[var(--text-subtle)]">{t("Selecciona una barra para fijar su valor. Los datos proceden de la respuesta indicada.")}</p>
    </div>
  );
}
