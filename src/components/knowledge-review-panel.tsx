"use client";
import { useUiLocale } from "@/i18n/provider";
import { useUiText } from "@/i18n/provider";
import { useEffect, useId, useRef, useState } from "react";
import { audience, object, reviewRecord, type KnowledgeAudience, type KnowledgeReviewRecord } from "@/knowledge/review-contract";

type Scope = KnowledgeAudience & { label: string; canReview: boolean };
type Page = { key: string; records: KnowledgeReviewRecord[]; connectionId: string; nextCursor: number | null };
const control = "min-h-9 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[12px] disabled:opacity-40";
const scopeKey = (s: KnowledgeAudience) => `${s.scope}:${s.scopeId ?? ""}`;
const eventLabel = (action: string) => ({ proposed: "Propuesta creada", confirm: "Confirmado", reject: "Rechazado", delete: "Retirado", corrected: "Corregido", "correction-confirmed": "Corrección confirmada", superseded: "Sustituido", "source-invalidated": "Fuente invalidada" }[action] ?? "Revisión registrada");

export function KnowledgeReviewPanel({ projectId }: { projectId: string }) {
  const locale = useUiLocale();
  const t = useUiText();
  const editorId = useId();
  const [open, setOpen] = useState(false), [scopes, setScopes] = useState<Scope[]>([]);
  const [selected, setSelected] = useState<string | null>(null), [status, setStatus] = useState("proposed");
  const [cursor, setCursor] = useState(0), [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<Page | null>(null), [error, setError] = useState<{ key: string; text: string } | null>(null);
  const [notice, setNotice] = useState<{ key: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ key: string; id: string; revision: number; content: string; reason: string } | null>(null);
  const mounted = useRef(true);
  const scope = scopes.find((s) => scopeKey(s) === selected);
  const key = `${projectId}:${selected}:${status}:${cursor}`;
  const visible = page?.key === key ? page : null;
  const errorText = error?.key === key || error?.key === "scopes" ? error.text : null;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetch(`/api/knowledge/review?projectId=${projectId}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const value: unknown = await response.json();
        if (!response.ok || !object(value) || !Array.isArray(value.scopes) || !value.scopes.every((s) => audience(s) && typeof s.label === "string" && typeof s.canReview === "boolean")) throw new Error(t("No tienes acceso a la revisión del conocimiento o el servicio no está disponible."));
        if (controller.signal.aborted) return;
        const next = value.scopes as Scope[];
        setScopes(next); setSelected((current) => current && next.some((s) => scopeKey(s) === current) ? current : next[0] ? scopeKey(next[0]) : null);
        setError(next.length ? null : { key: "scopes", text: t("No hay ámbitos documentales disponibles para esta cuenta y proyecto.") });
      }).catch((reason) => { if (!controller.signal.aborted) setError({ key: "scopes", text: reason instanceof Error ? reason.message : t("No se ha podido cargar.") }); });
    return () => controller.abort();
  }, [open, projectId, refresh, t]);

  useEffect(() => {
    if (!open || !scope) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ projectId, scope: scope.scope, status, cursor: String(cursor) });
    if (scope.scopeId) query.set("scopeId", scope.scopeId);
    void fetch(`/api/knowledge/review?${query}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const value: unknown = await response.json();
      if (!response.ok || !object(value) || !value.available || !Array.isArray(value.records) || !value.records.every(reviewRecord) || typeof value.connectionId !== "string" ||
        !(value.nextCursor === null || Number.isSafeInteger(value.nextCursor))) throw new Error(t("El índice de este ámbito no está disponible. Esto no significa que no haya documentos."));
      if (!controller.signal.aborted) { setPage({ key, records: value.records, connectionId: value.connectionId, nextCursor: value.nextCursor as number | null }); setError(null); }
    }).catch((reason) => { if (!controller.signal.aborted) setError({ key, text: reason instanceof Error ? reason.message : t("No se ha podido cargar.") }); });
    return () => controller.abort();
  }, [open, scope, projectId, status, cursor, refresh, key, t]);

  async function review(record: KnowledgeReviewRecord, decision: "confirm" | "reject" | "delete" | "correct") {
    if (busy || !scope?.canReview || !visible) return;
    if (decision === "correct" && (!draft || draft.key !== key || draft.id !== record.id || draft.revision !== record.revision || !draft.reason.trim() || !draft.content.trim())) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch("/api/knowledge/review", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, scope: scope.scope, scopeId: scope.scopeId, connectionId: visible.connectionId, recordId: record.id, revision: record.revision, decision, ...(decision === "correct" ? { content: draft!.content, reason: draft!.reason } : {}) }) });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(object(result) && typeof result.error === "string" ? result.error : t("No se ha podido guardar la revisión."));
      if (!object(result) || !result.available || !reviewRecord(result.record) || (decision === "correct" ? result.record.correction?.previousRecordId !== record.id || result.record.correction.previousRevision !== record.revision || result.record.status !== "confirmed" || result.record.id === record.id || result.record.content !== draft!.content.trim() || result.record.correction.reason !== draft!.reason.trim() || result.record.correction.previousContent !== record.content : result.record.id !== record.id)) throw new Error(t("No se ha recibido una confirmación válida. Actualiza la lista antes de repetir."));
      if (mounted.current) { setNotice({ key, text: decision === "correct" ? t("Corrección guardada y confirmada. Puedes consultarla en «Confirmado».") : t("Revisión guardada.") }); setDraft(null); setPage(null); setRefresh((v) => v + 1); }
    } catch (reason) { if (mounted.current) setError({ key, text: reason instanceof Error ? reason.message : t("No se ha podido guardar.") }); }
    finally { if (mounted.current) setBusy(false); }
  }

  return <section className="mt-7 rounded-[var(--brain-radius)] border border-[var(--border)] p-3.5" aria-label={t("Conocimiento de documentos")}>
    <h3 className="text-[13px] font-semibold">{t("Conocimiento de documentos")}</h3>
    <p className="mt-1 text-[12px] leading-5 text-[var(--text-muted)]">{t("Hechos y resúmenes propuestos a partir de archivos. Revisa las citas y sus matices antes de confirmarlos.")}</p>
    <button type="button" disabled={busy} className={`${control} mt-3`} aria-expanded={open} onClick={() => { setDraft(null); setPage(null); setScopes([]); setSelected(null); setError(null); setCursor(0); setOpen((v) => !v); }}>{open ? t("Cerrar revisión") : t("Revisar propuestas")}</button>
    {open ? <div className="mt-4 space-y-4">
      {scopes.length ? <div className="flex flex-wrap gap-2">
        <label className="flex flex-col gap-1 text-[11px]">{t("Ámbito")}<select aria-label={t("Ámbito del conocimiento")} disabled={busy} className={control} value={selected ?? ""} onChange={(event) => { setDraft(null); setSelected(event.target.value); setCursor(0); }}>{scopes.map((s) => <option key={scopeKey(s)} value={scopeKey(s)}>{s.label}</option>)}</select></label>
        <label className="flex flex-col gap-1 text-[11px]">{t("Estado")}<select aria-label={t("Estado del conocimiento")} disabled={busy} className={control} value={status} onChange={(event) => { setDraft(null); setStatus(event.target.value); setCursor(0); }}><option value="proposed">{t("Pendiente de revisión")}</option><option value="confirmed">{t("Confirmado")}</option></select></label>
      </div> : null}
      {notice?.key === key ? <p role="status" className="text-[12px] text-[var(--text-muted)]">{notice.text}</p> : null}
      {errorText ? <div role="alert" className="text-[12px] text-[var(--danger)]"><p>{errorText}</p><button type="button" disabled={busy} className={`${control} mt-2`} onClick={() => { setDraft(null); setError(null); setPage(null); setRefresh((v) => v + 1); }}>{t("Actualizar lista")}</button></div> : null}
      {!visible && !errorText ? <p role="status" className="text-[12px] text-[var(--text-muted)]">{t("Cargando propuestas…")}</p> : null}
      {visible?.records.map((record) => <article key={record.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
        <p className="text-[11px] text-[var(--text-muted)]">{record.status === "confirmed" ? t("Confirmado") : t("Pendiente de revisión")} · {record.kind === "summary" ? t("Resumen") : record.kind === "insight" ? t("Análisis") : record.kind === "decision" ? t("Decisión") : t("Hecho")}</p>
        <h4 className="mt-1 break-words text-[13px] font-semibold">{record.label} · {record.topic}</h4>
        <p className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-5">{record.content}</p>
        {record.conflicts.length ? <p className="mt-2 text-[12px] text-[var(--danger)]">{t("Hay otras propuestas sobre este mismo dato. Compara sus fuentes antes de elegir una.")}</p> : null}
        <details className="mt-3 text-[12px]"><summary className="cursor-pointer font-medium">{t("Ver fuentes (")}{record.citations.length}{t(") e historial")}</summary><div className="mt-2 space-y-3">{record.citations.map((c, i) => <div key={i}><p className="break-all text-[11px] text-[var(--text-muted)]">{c.source} · {c.locator} {" "}{t("· versión")}{" "}{c.sha256.slice(0, 12)}</p><blockquote className="mt-1 whitespace-pre-wrap border-l-2 border-[var(--border)] pl-3 leading-5">{c.quote}</blockquote></div>)}{record.correction ? <div className="rounded border border-[var(--border)] p-2"><p className="font-medium">{t("Motivo de la corrección")}</p><p className="mt-1 whitespace-pre-wrap break-words">{record.correction.reason}</p><p className="mt-2 font-medium">{t("Texto anterior")}</p><p className="mt-1 whitespace-pre-wrap break-words text-[var(--text-muted)]">{record.correction.previousContent}</p></div> : null}{record.events.map((e, i) => <p key={i} className="text-[10px] text-[var(--text-subtle)]">{eventLabel(e.action)} · {new Date(e.recorded).toLocaleString(locale)}</p>)}</div></details>
        {scope?.canReview && draft?.key === key && draft.id === record.id && draft.revision === record.revision ? <form className="mt-3 space-y-3" onSubmit={(event) => { event.preventDefault(); void review(record, "correct"); }}>
          <p className="text-[12px] leading-5 text-[var(--text-muted)]">{t("Revisa las citas antes de guardar. La corrección quedará confirmada con las mismas fuentes; el texto anterior y el motivo se conservarán.")}</p>
          <div className="flex flex-col gap-1 text-[12px]"><label htmlFor={`${editorId}-${record.id}-content`}>{t("Texto corregido")}</label><textarea id={`${editorId}-${record.id}-content`} autoFocus required maxLength={8000} disabled={busy} rows={5} className={`${control} w-full resize-y leading-5`} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></div>
          <div className="flex flex-col gap-1 text-[12px]"><label htmlFor={`${editorId}-${record.id}-reason`}>{t("Motivo de la corrección")}</label><textarea id={`${editorId}-${record.id}-reason`} required maxLength={1000} disabled={busy} rows={2} className={`${control} w-full resize-y leading-5`} value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} /></div>
          <div className="flex flex-wrap gap-2"><button type="submit" disabled={busy || !draft.reason.trim() || !draft.content.trim() || draft.content.trim() === record.content} className={`${control} font-semibold`}>{t("Guardar y confirmar corrección")}</button><button type="button" disabled={busy} className={control} onClick={() => setDraft(null)}>{t("Cancelar")}</button></div>
        </form> : scope?.canReview ? <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={busy} className={control} onClick={() => setDraft({ key, id: record.id, revision: record.revision, content: record.content, reason: "" })}>{t("Corregir")}</button>{record.status === "proposed" ? <><button type="button" disabled={busy} className={`${control} font-semibold`} onClick={() => void review(record, "confirm")}>{t("Confirmar")}</button><button type="button" disabled={busy} className={control} onClick={() => void review(record, "reject")}>{t("Rechazar")}</button></> : <button type="button" disabled={busy} className={control} onClick={() => void review(record, "delete")}>{t("Retirar del conocimiento")}</button>}</div> : <p className="mt-3 text-[11px] text-[var(--text-muted)]">{t("Tienes acceso de lectura a este ámbito.")}</p>}
      </article>)}
      {visible && !visible.records.length ? <p className="text-[12px] text-[var(--text-muted)]">{t("No hay registros disponibles en esta página. La cobertura del índice puede ser parcial.")}</p> : null}
      {visible ? <div className="flex gap-2">{cursor > 0 ? <button type="button" disabled={busy} className={control} onClick={() => { setDraft(null); setCursor(0); }}>{t("Volver al inicio")}</button> : null}{visible.nextCursor !== null ? <button type="button" disabled={busy} className={control} onClick={() => { setDraft(null); setCursor(visible.nextCursor!); }}>{t("Siguiente página")}</button> : null}</div> : null}
    </div> : null}
  </section>;
}
