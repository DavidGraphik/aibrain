"use client";
import { useUiLocale } from "@/i18n/provider";
import { useUiText } from "@/i18n/provider";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpenText, Check, ClockCounterClockwise, Plus, Trash, X } from "@phosphor-icons/react";
import type { MemoryKind, MemoryRecord } from "@/memory/types";
import type { GovernedMemoryRecord, MemoryProposal, MemoryScope } from "@/memory/proposal-store";
import {
  confirmMemoryProposal,
  createExplicitMemory,
  deleteGovernedMemory,
  listMemoryGovernance,
  listExplicitMemories,
  rejectMemoryProposal,
  restoreGovernedMemory,
  revokeExplicitMemory,
  updateGovernedMemory,
} from "@/ui/memory-ui-adapter";
import { useModalFocus } from "@/ui/use-modal-focus";
import { KnowledgeReviewPanel } from "@/components/knowledge-review-panel";

function memoryDate(value: string, locale: "en" | "es" | "ca" = "es") {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

function kindLabel(kind: MemoryKind) {
  return kind === "decision" ? "Decisión" : "Recordatorio";
}

function scopeLabel(scope: MemoryScope) { return scope === "private" ? "Privada" : scope === "project" ? "Proyecto" : "Empresa"; }

export function MemoryPanel({ open, projectId, productName, onClose, embedded = false }: { open: boolean; projectId: string | null; productName: string; onClose: () => void; embedded?: boolean }) {
  const t = useUiText();
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);
  const [governed, setGoverned] = useState<GovernedMemoryRecord[]>([]);
  const [allowCompanyScope, setAllowCompanyScope] = useState(false);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<MemoryKind>("recollection");
  const [revokeTarget, setRevokeTarget] = useState<MemoryRecord | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [undoMemory, setUndoMemory] = useState<{ memory: GovernedMemoryRecord; projectId: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GovernedMemoryRecord | null>(null);
  const undoButtonRef = useRef<HTMLButtonElement>(null);

  const cancelDeleteConfirmation = useCallback(() => {
    const memoryId = deleteTarget?.memoryId;
    setDeleteTarget(null);
    if (memoryId) requestAnimationFrame(() => document.getElementById(`governed-memory-delete-${memoryId}`)?.focus());
  }, [deleteTarget]);
  const closeOrCancelDelete = useCallback(() => {
    if (deleteTarget) cancelDeleteConfirmation();
    else onClose();
  }, [cancelDeleteConfirmation, deleteTarget, onClose]);
  const panelRef = useModalFocus(open && !embedded, closeOrCancelDelete);

  const activeMemories = useMemo(() => memories.filter((memory) => memory.status === "active"), [memories]);
  const revokedMemories = useMemo(() => memories.filter((memory) => memory.status === "revoked"), [memories]);
  const projectDataIsCurrent = loadedProjectId === projectId;
  const visibleProposals = projectDataIsCurrent ? proposals : [];
  const visibleGoverned = projectDataIsCurrent ? governed : [];
  const activeGoverned = visibleGoverned.filter((memory) => memory.status === "active");
  const deletedGoverned = visibleGoverned.filter((memory) => memory.status === "deleted");
  const updatingProject = loadedProjectId !== undefined && !projectDataIsCurrent;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const requestedProjectId = projectId;
    setLoading(true);
    setError(null);
    try {
      const [explicit, governance] = await Promise.all([
        listExplicitMemories(signal),
        projectId ? listMemoryGovernance(projectId, signal) : Promise.resolve({ proposals: [], memories: [], allowCompanyScope: false }),
      ]);
      setMemories(explicit);
      setProposals(governance.proposals);
      setGoverned(governance.memories);
      setAllowCompanyScope(governance.allowCompanyScope);
      setUndoMemory((current) => {
        if (!current || current.projectId !== requestedProjectId) return current;
        const latest = governance.memories.find((memory) => memory.memoryId === current.memory.memoryId);
        return latest?.status === "deleted" ? { memory: latest, projectId: current.projectId } : null;
      });
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : t("No se ha podido cargar la memoria."));
    } finally {
      if (!signal?.aborted) {
        setLoadedProjectId(requestedProjectId);
        setLoading(false);
      }
    }
  }, [projectId, t]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const frame = requestAnimationFrame(() => void refresh(controller.signal));
    return () => {
      cancelAnimationFrame(frame);
      controller.abort();
    };
  }, [open, refresh]);

  const runGovernance = async (operation: () => Promise<unknown>) => {
    if (saving || !projectId) return;
    setSaving(true); setError(null);
    try { await operation(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("No se ha podido actualizar la propuesta.")); }
    finally { setSaving(false); }
  };

  const save = async () => {
    if (!content.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const memory = await createExplicitMemory({ kind, content });
      setMemories((current) => [memory, ...current.filter((item) => item.memoryId !== memory.memoryId)]);
      setContent("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("No se ha podido guardar la memoria."));
    } finally {
      setSaving(false);
    }
  };

  const revoke = async () => {
    if (!revokeTarget || !revokeReason.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const memory = await revokeExplicitMemory(revokeTarget.memoryId, revokeReason);
      setMemories((current) => current.map((item) => item.memoryId === memory.memoryId ? memory : item));
      setRevokeTarget(null);
      setRevokeReason("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("No se ha podido revocar la memoria."));
    } finally {
      setSaving(false);
    }
  };

  const deleteMemory = async (memory: GovernedMemoryRecord) => {
    if (saving || !projectId) return;
    setSaving(true);
    setError(null);
    try {
      const deleted = await deleteGovernedMemory(memory, projectId);
      setGoverned((current) => current.map((item) => item.memoryId === deleted.memoryId ? deleted : item));
      setUndoMemory({ memory: deleted, projectId });
      setDeleteTarget(null);
      requestAnimationFrame(() => undoButtonRef.current?.focus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("No se ha podido eliminar la memoria."));
    } finally {
      setSaving(false);
    }
  };

  const restoreMemory = async (memory: GovernedMemoryRecord) => {
    if (saving || !projectId) return;
    setSaving(true);
    setError(null);
    try {
      const restored = await restoreGovernedMemory(memory, projectId);
      setGoverned((current) => current.map((item) => item.memoryId === restored.memoryId ? restored : item));
      setUndoMemory((current) => current?.memory.memoryId === restored.memoryId ? null : current);
      requestAnimationFrame(() => document.getElementById(`governed-memory-edit-${restored.memoryId}`)?.focus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("No se ha podido restaurar la memoria."));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;
  return (
    <div className={embedded ? "relative" : "fixed inset-0 z-50 flex justify-end bg-[var(--overlay)] backdrop-blur-[2px]"}>
      {!embedded ? <button className="absolute inset-0" aria-label={t("Cerrar memoria")} onClick={closeOrCancelDelete} /> : null}
      <aside ref={panelRef} tabIndex={embedded ? undefined : -1} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-labelledby="memory-title" className={embedded ? "relative flex w-full flex-col" : "panel-enter relative flex h-full w-full max-w-[460px] flex-col border-l border-[var(--border)] bg-[var(--surface-raised)] shadow-[var(--shadow-lg)]"}>
        {!embedded ? <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-5">
          <div className="flex items-center gap-2"><BookOpenText size={16} /><h2 id="memory-title" className="text-[13px] font-semibold text-[var(--text)]">{t("Memoria")}</h2></div>
          <button type="button" aria-label={t("Cerrar memoria")} className="rounded-md p-1.5 text-[var(--text-subtle)] hover:bg-[var(--surface-hover)]" onClick={closeOrCancelDelete}><X size={16} /></button>
        </header> : <h2 id="memory-title" className="sr-only">{t("Memoria")}</h2>}

        <div className={embedded ? "min-h-0" : "scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-6"}>
          <p className="rounded-[var(--brain-radius)] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3 text-[12px] leading-5 text-[var(--text-muted)]">
            {productName} {" "}{t("extrae en segundo plano preferencias, hechos estables y decisiones útiles al terminar cada turno. Filtra secretos y datos efímeros; puedes corregir o eliminar cualquier recuerdo.")}{" "}</p>

          {updatingProject ? <p className="mt-3 text-[11px] text-[var(--text-muted)]">{t("Actualizando memoria…")}</p> : null}
          {projectDataIsCurrent && allowCompanyScope && projectId ? <KnowledgeReviewPanel key={projectId} projectId={projectId} /> : null}

          {visibleProposals.some((proposal) => proposal.status === "pending") ? <section className="mt-6"><div className="flex items-center justify-between"><h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-subtle)]">{t("Propuestas pendientes")}</h3><span className="text-[10px] text-[var(--text-subtle)]">{t("No guardadas")}</span></div><p className="mt-2 text-[10px] leading-4 text-[var(--text-muted)]">{t("Revisa contenido, alcance y procedencia. Rechazar nunca crea una memoria.")}</p><div className="mt-3 space-y-3">{visibleProposals.filter((proposal) => proposal.status === "pending").map((proposal) => <ProposalCard key={proposal.proposalId} proposal={proposal} allowCompanyScope={allowCompanyScope} disabled={saving || !projectId} onConfirm={(content, scope) => void runGovernance(() => confirmMemoryProposal({ proposalId: proposal.proposalId, projectId: projectId!, content, scope }))} onReject={() => void runGovernance(() => rejectMemoryProposal(proposal.proposalId, projectId!))} />)}</div></section> : null}

          {undoMemory?.projectId === projectId && projectDataIsCurrent ? <div className="mt-4 flex min-h-11 items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[11px] shadow-[var(--shadow-sm)]"><span role="status" className="min-w-0 flex-1 text-[var(--text-secondary)]">{t("Memoria eliminada. Ya no se usará en futuras conversaciones.")}</span><button ref={undoButtonRef} type="button" disabled={saving} onClick={() => void restoreMemory(undoMemory.memory)} className="touch-target shrink-0 rounded-lg px-2 font-semibold text-[var(--brain-accent-on-soft)] hover:bg-[var(--brain-accent-soft)] disabled:opacity-40">{t("Deshacer")}</button><button type="button" aria-label={t("Ocultar aviso")} onClick={() => setUndoMemory(null)} className="touch-target grid size-9 shrink-0 place-items-center rounded-lg text-[var(--text-subtle)] hover:bg-[var(--surface-hover)]"><X size={14} /></button></div> : null}

          {activeGoverned.length ? <section className="mt-7"><div className="flex items-center justify-between"><h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-subtle)]">{t("Memoria automática y gobernada")}</h3><span className="text-[10px] tabular-nums text-[var(--text-subtle)]">{activeGoverned.length}</span></div><div className="mt-3 space-y-2">{activeGoverned.map((memory) => <GovernedCard key={memory.memoryId} memory={memory} disabled={saving || !projectId} confirmingDelete={deleteTarget?.memoryId === memory.memoryId} onUpdate={(content) => void runGovernance(() => updateGovernedMemory(memory, projectId!, content))} onRequestDelete={() => setDeleteTarget(memory)} onCancelDelete={cancelDeleteConfirmation} onDelete={() => void deleteMemory(memory)} />)}</div></section> : null}

          {deletedGoverned.length ? <section className="mt-7"><div className="flex items-center justify-between"><h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-subtle)]">{t("Eliminadas")}</h3><span className="text-[10px] tabular-nums text-[var(--text-subtle)]">{deletedGoverned.length}</span></div><p className="mt-2 text-[10px] leading-4 text-[var(--text-muted)]">{t("No se usan en conversaciones. Puedes restaurarlas cuando quieras.")}</p><div className="mt-3 space-y-2">{deletedGoverned.map((memory) => <DeletedGovernedCard key={memory.memoryId} memory={memory} disabled={saving || !projectId} onRestore={() => void restoreMemory(memory)} />)}</div></section> : null}

          <section className="mt-6">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-subtle)]">{t("Añadir memoria")}</h3>
            <div className="mt-3 rounded-[var(--brain-radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
              <div className="flex gap-2" role="group" aria-label={t("Tipo de memoria")}>
                {(["recollection", "decision"] as const).map((option) => <button key={option} type="button" aria-pressed={kind === option} onClick={() => setKind(option)} className={`min-h-9 rounded-lg px-3 text-[11px] font-medium ${kind === option ? "bg-[var(--brain-accent-soft)] text-[var(--brain-accent-on-soft)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]"}`}>{t(kindLabel(option) ?? "")}</button>)}
              </div>
              <label className="sr-only" htmlFor="memory-content">{t("Memoria a guardar")}</label>
              <textarea id="memory-content" value={content} maxLength={32_000} rows={4} placeholder={t("Por ejemplo: el horario de atención se confirma siempre antes de publicar.")} onChange={(event) => setContent(event.target.value)} className="mt-3 w-full resize-y rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2.5 text-[12px] leading-5 text-[var(--text)] outline-none focus:border-[var(--brain-accent)]" />
              <div className="mt-3 flex items-center justify-between gap-3"><span className="text-[10px] text-[var(--text-subtle)]">{t("También puedes añadir un recuerdo manual.")}</span><button type="button" disabled={saving || !content.trim()} onClick={() => void save()} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-[var(--brain-accent)] px-3 text-[11px] font-semibold text-[var(--brain-contrast)] disabled:opacity-40"><Plus size={13} />{saving ? t("Guardando…") : t("Guardar")}</button></div>
            </div>
          </section>

          {error ? <div role="alert" className="mt-4 flex items-center justify-between gap-3 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[11px] text-[var(--danger)]"><span>{error}</span><button type="button" disabled={loading} onClick={() => void refresh()} className="shrink-0 rounded-md px-2 py-1 font-semibold hover:bg-[var(--surface-hover)] disabled:opacity-40">{t("Reintentar")}</button></div> : null}

          <section className="mt-7">
            <div className="flex items-center justify-between"><h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-subtle)]">{t("Activas")}</h3><span className="text-[10px] tabular-nums text-[var(--text-subtle)]">{activeMemories.length}</span></div>
            {loading || loadedProjectId === undefined ? <p className="mt-3 text-[11px] text-[var(--text-muted)]">{t("Cargando memoria…")}</p> : error ? null : activeMemories.length ? <div className="mt-3 space-y-2">{activeMemories.map((memory) => <MemoryCard key={memory.memoryId} memory={memory} onRevoke={() => { setRevokeTarget(memory); setRevokeReason(""); }} />)}</div> : <EmptyState />}
          </section>

          {revokedMemories.length ? <section className="mt-7"><div className="flex items-center justify-between"><h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-subtle)]">{t("Revocadas")}</h3><span className="text-[10px] tabular-nums text-[var(--text-subtle)]">{revokedMemories.length}</span></div><div className="mt-3 space-y-2 opacity-70">{revokedMemories.map((memory) => <MemoryCard key={memory.memoryId} memory={memory} />)}</div></section> : null}
        </div>

        {revokeTarget ? <footer className={`${embedded ? "mt-4 rounded-[var(--brain-radius)] border" : "border-t"} border-[var(--border-subtle)] bg-[var(--surface)] p-4`}><p className="text-[12px] font-semibold text-[var(--text)]">{t("¿Revocar esta memoria?")}</p><label className="sr-only" htmlFor="revoke-reason">{t("Motivo de la revocación")}</label><input id="revoke-reason" value={revokeReason} maxLength={2_000} placeholder={t("Motivo de la revocación")} onChange={(event) => setRevokeReason(event.target.value)} className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-[12px] text-[var(--text)] outline-none focus:border-[var(--brain-accent)]" /><div className="mt-3 flex justify-end gap-2"><button type="button" onClick={() => setRevokeTarget(null)} className="min-h-9 rounded-lg px-3 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">{t("Cancelar")}</button><button type="button" disabled={saving || !revokeReason.trim()} onClick={() => void revoke()} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-[var(--danger)] px-3 text-[11px] font-semibold text-white disabled:opacity-40"><Trash size={13} />{saving ? t("Revocando…") : t("Revocar")}</button></div></footer> : null}
      </aside>
    </div>
  );
}

function ProposalCard({ proposal, allowCompanyScope, disabled, onConfirm, onReject }: { proposal: MemoryProposal; allowCompanyScope: boolean; disabled: boolean; onConfirm: (content: string, scope: MemoryScope) => void; onReject: () => void }) {
  const locale = useUiLocale();
  const t = useUiText();
  const [content, setContent] = useState(proposal.content);
  const [scope, setScope] = useState<MemoryScope>(proposal.proposedScope === "company" && !allowCompanyScope ? "private" : proposal.proposedScope);
  return <article className="rounded-[var(--brain-radius)] border border-[var(--brain-accent)] bg-[var(--surface)] p-3"><textarea aria-label={t("Contenido propuesto")} value={content} maxLength={32_000} rows={3} onChange={(event) => setContent(event.target.value)} className="w-full resize-y rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 text-[12px] leading-5" /><div className="mt-2 flex items-center gap-2"><label className="text-[10px] text-[var(--text-muted)]">{t("Alcance")}{" "}<select value={scope} onChange={(event) => setScope(event.target.value as MemoryScope)} className="ml-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1"><option value="private">{t("Privada")}</option><option value="project">{t("Proyecto")}</option>{allowCompanyScope ? <option value="company">{t("Empresa")}</option> : null}</select></label></div><p className="mt-2 text-[9px] leading-4 text-[var(--text-subtle)]">{t("Procedencia: chat")}{" "}{proposal.provenance.threadId} {" "}{t("· herramientas:")}{" "}{proposal.provenance.toolNames.join(", ") || "ninguna registrada"} · {new Date(proposal.provenance.capturedAt).toLocaleString(locale)}</p><div className="mt-3 flex justify-end gap-2"><button type="button" disabled={disabled} onClick={onReject} className="min-h-8 rounded-lg px-3 text-[10px] font-semibold text-[var(--danger)]">{t("Rechazar")}</button><button type="button" disabled={disabled || !content.trim()} onClick={() => onConfirm(content, scope)} className="min-h-8 rounded-lg bg-[var(--brain-accent)] px-3 text-[10px] font-semibold text-[var(--brain-contrast)]">{t("Confirmar y guardar")}</button></div></article>;
}

function GovernedCard({ memory, disabled, confirmingDelete, onUpdate, onRequestDelete, onCancelDelete, onDelete }: { memory: GovernedMemoryRecord; disabled: boolean; confirmingDelete: boolean; onUpdate: (content: string) => void; onRequestDelete: () => void; onCancelDelete: () => void; onDelete: () => void }) {
  const t = useUiText();
  const [editing, setEditing] = useState(false); const [content, setContent] = useState(memory.content);
  const textareaId = `governed-memory-${memory.memoryId}`;
  return <article className="rounded-[var(--brain-radius)] border border-[var(--border)] bg-[var(--surface)] p-3"><div className="flex items-start gap-2"><span className="rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 text-[9px] font-semibold">{t(scopeLabel(memory.scope) ?? "")}</span>{editing ? <div className="min-w-0 flex-1"><label htmlFor={textareaId} className="mb-1 block text-[10px] font-medium text-[var(--text-muted)]">{t("Contenido de la memoria")}</label><textarea id={textareaId} value={content} rows={3} maxLength={32_000} onChange={(event) => setContent(event.target.value)} className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5 text-[12px]" /></div> : <p className="min-w-0 flex-1 whitespace-pre-wrap text-[12px] leading-5">{memory.content}</p>}</div><p className="mt-2 text-[9px] text-[var(--text-subtle)]">{t("Revisión")}{" "}{memory.revision} · {memory.provenance.sourceType === "background-conversation" ? t("extraída automáticamente") : t("guardada desde conversación")}</p>{confirmingDelete ? <div role="group" aria-label={t("Confirmar eliminación")} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancelDelete(); } }} className="mt-3 rounded-xl bg-[var(--danger-soft)] p-3"><p className="text-[11px] font-semibold text-[var(--text)]">{t("¿Eliminar esta memoria?")}</p><p className="mt-1 text-[10px] leading-4 text-[var(--text-muted)]">{t("Dejará de usarse, pero podrás restaurarla después.")}</p><div className="mt-3 flex justify-end gap-2"><button autoFocus type="button" disabled={disabled} onClick={onCancelDelete} className="touch-target min-h-9 rounded-lg px-3 text-[10px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">{t("Cancelar")}</button><button type="button" disabled={disabled} onClick={onDelete} className="touch-target min-h-9 rounded-lg bg-[var(--danger)] px-3 text-[10px] font-semibold text-white disabled:opacity-40">{t("Eliminar memoria")}</button></div></div> : <div className="mt-2 flex justify-end gap-2">{editing ? <><button type="button" onClick={() => { setEditing(false); setContent(memory.content); }} className="touch-target min-h-9 px-2 text-[10px]">{t("Cancelar")}</button><button type="button" disabled={disabled || !content.trim()} onClick={() => { onUpdate(content); setEditing(false); }} className="touch-target min-h-9 px-2 text-[10px] font-semibold text-[var(--brain-accent)]">{t("Guardar edición")}</button></> : <><button id={`governed-memory-edit-${memory.memoryId}`} type="button" disabled={disabled} onClick={() => setEditing(true)} className="touch-target min-h-9 px-2 text-[10px]">{t("Editar")}</button><button id={`governed-memory-delete-${memory.memoryId}`} type="button" disabled={disabled} onClick={onRequestDelete} className="touch-target min-h-9 px-2 text-[10px] text-[var(--danger)]">{t("Eliminar")}</button></>}</div>}</article>;
}

function DeletedGovernedCard({ memory, disabled, onRestore }: { memory: GovernedMemoryRecord; disabled: boolean; onRestore: () => void }) {
  const locale = useUiLocale();
  const t = useUiText();
  return <article className="rounded-[var(--brain-radius)] border border-[var(--border)] bg-[var(--surface)] p-3 opacity-80"><div className="flex items-start gap-2"><span className="rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 text-[9px] font-semibold">{t(scopeLabel(memory.scope) ?? "")}</span><p className="min-w-0 flex-1 whitespace-pre-wrap text-[12px] leading-5 text-[var(--text-muted)]">{memory.content}</p></div><div className="mt-2 flex items-center justify-between gap-3"><p className="text-[9px] text-[var(--text-subtle)]">{t("Eliminada")}{" "}{memory.deletedAt ? memoryDate(memory.deletedAt, locale) : ""}</p><button type="button" disabled={disabled} onClick={onRestore} className="touch-target min-h-9 rounded-lg px-3 text-[10px] font-semibold text-[var(--brain-accent-on-soft)] hover:bg-[var(--brain-accent-soft)] disabled:opacity-40">{t("Restaurar")}</button></div></article>;
}

function EmptyState() {
  const t = useUiText();
  return <div className="mt-3 rounded-[var(--brain-radius)] border border-dashed border-[var(--border)] px-4 py-5 text-center"><Check size={17} className="mx-auto text-[var(--positive)]" /><p className="mt-2 text-[11px] font-medium text-[var(--text)]">{t("Aún no hay memorias guardadas")}</p><p className="mt-1 text-[10px] leading-4 text-[var(--text-muted)]">{t("Añade solo información que sea útil en futuras conversaciones.")}</p></div>;
}

function MemoryCard({ memory, onRevoke }: { memory: MemoryRecord; onRevoke?: () => void }) {
  const locale = useUiLocale();
  const t = useUiText();
  return <article className="rounded-[var(--brain-radius)] border border-[var(--border)] bg-[var(--surface)] p-3"><div className="flex items-start gap-2"><span className="mt-0.5 rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--text-secondary)]">{t(kindLabel(memory.kind) ?? "")}</span><p className="min-w-0 flex-1 whitespace-pre-wrap text-[12px] leading-5 text-[var(--text)]">{memory.content}</p>{onRevoke ? <button type="button" aria-label={t("Revocar memoria")} onClick={onRevoke} className="rounded-md p-1 text-[var(--text-subtle)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"><Trash size={14} /></button> : null}</div><p className="mt-2 flex items-center gap-1 text-[10px] text-[var(--text-subtle)]"><ClockCounterClockwise size={11} />{memory.status === "revoked" ? t("Revocada") : t("Guardada")} {memoryDate(memory.status === "revoked" ? memory.revokedAt ?? memory.createdAt : memory.createdAt, locale)}</p></article>;
}
