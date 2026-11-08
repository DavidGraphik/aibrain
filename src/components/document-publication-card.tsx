"use client";
import { useUiText } from "@/i18n/provider";

import { FileArrowUp, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import type { DocumentPublicationDraft } from "@/ui/publication-ui-adapter";
import { isSafePublicationTarget } from "@/ui/publication-ui-adapter";

const terminalCopy: Record<"published" | "declined" | "expired" | "conflict", string> = {
  published: "Publicado y versionado",
  declined: "Publicación rechazada",
  expired: "La confirmación ha caducado. Prepara una nueva publicación.",
  conflict: "El original ha cambiado. Revisa el documento antes de intentarlo de nuevo.",
};

export function DocumentPublicationCard({
  draft,
  onFreeze,
  onDecide,
  readOnly = false,
}: {
  draft: DocumentPublicationDraft;
  onFreeze: (draftId: string, targetRelativePath: string) => Promise<void>;
  onDecide: (draftId: string, action: "confirm" | "decline") => Promise<void>;
  readOnly?: boolean;
}) {
  const t = useUiText();
  const [target, setTarget] = useState(draft.targetRelativePath);
  const busy = draft.phase === "freezing" || draft.phase === "deciding";
  const uncertain = draft.phase === "uncertain";
  const awaiting = draft.phase === "awaiting_confirmation" || uncertain;
  const terminal = draft.phase === "published" || draft.phase === "declined" ||
    draft.phase === "expired" || draft.phase === "conflict";

  return (
    <section className="mt-3 max-w-[420px] rounded-lg border border-[var(--border)] bg-[var(--surface-raised)]" role="group" aria-label={t("Publicación de {p0}", { p0: draft.fileName })}>
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[var(--surface-muted)] text-[var(--text-muted)]"><FileArrowUp size={15} /></span>
        <div className="min-w-0 flex-1"><p className="truncate text-body-2-semibold text-[var(--text)]">{draft.fileName}</p><p className="mt-0.5 text-caption-1-regular text-[var(--text-muted)]">{t("Documento preparado ·")}{" "}{Math.ceil(draft.size / 1024)} {" "}{t("KB")}</p></div>
      </div>

      {draft.phase === "ready" || draft.phase === "error" ? (
        <div className="border-t border-[var(--border-subtle)] px-3 py-2.5">
          {readOnly ? <><p className="text-caption-1-medium text-[var(--text-muted)]">{t("Destino oficial")}</p><p className="mt-1.5 break-words text-body-2-regular text-[var(--text)]">{target}</p></> : <label className="block text-caption-1-medium text-[var(--text-muted)]">{t("Destino oficial")}{" "}<input aria-label={t("Destino de {p0}", { p0: draft.fileName })} value={target} onChange={(event) => setTarget(event.target.value)} className="mt-1.5 min-h-10 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 text-body-regular text-[var(--text)] outline-none focus:border-[var(--brain-accent)]" />
          </label>}
          {draft.error ? <p className="mt-2 flex items-start gap-1.5 text-body-2-regular text-[var(--danger)]" role="alert"><WarningCircle size={15} className="mt-0.5 shrink-0" />{draft.error}</p> : null}
          {readOnly ? <p className="mt-2 text-body-2-regular text-[var(--text-muted)]" role="status">{t("Solo un editor del proyecto puede preparar esta publicación.")}</p> : <div className="mt-2 flex justify-end"><button type="button" disabled={!isSafePublicationTarget(target) || busy} className="touch-target min-h-10 rounded-md bg-[var(--text)] px-3 text-body-2-semibold text-[var(--surface)] transition-[opacity,transform] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40" onClick={() => void onFreeze(draft.id, target)}>{t("Preparar publicación")}</button></div>}
        </div>
      ) : null}

      {draft.phase === "freezing" ? <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] px-3 py-2.5 text-body-2-regular text-[var(--text-muted)]" role="status"><SpinnerGap size={14} className="shrink-0 motion-safe:animate-spin" />{t("Verificando candidato, permisos y versión original…")}</div> : null}

      {awaiting && draft.operation ? (
        <div className="border-t border-[var(--border-subtle)] px-3 py-2.5">
          <p className="text-body-2-regular text-[var(--text-muted)]">{uncertain ? t("El resultado del guardado está pendiente de comprobación. Consultaremos la misma operación sin volver a escribir el documento.") : draft.operation.original.exists ? t("Sustituirá el original y conservará una versión recuperable.") : t("Creará un documento oficial nuevo.")}</p>
          <p className="mt-1 truncate text-caption-1-medium text-[var(--text)]">{draft.operation.targetRelativePath}</p>
          {draft.error ? <p className="mt-2 flex items-start gap-1.5 text-body-2-regular text-[var(--danger)]" role="alert"><WarningCircle size={15} className="mt-0.5 shrink-0" />{draft.error}</p> : null}
          {readOnly ? <p className="mt-2 text-body-2-regular text-[var(--text-muted)]" role="status">{t("Esperando la decisión de un editor del proyecto.")}</p> : <div className="mt-2 flex justify-end gap-1.5">{!uncertain ? <button type="button" className="touch-target min-h-10 rounded-md px-3 text-body-2-medium text-[var(--text)] transition-[background-color,opacity,transform] hover:bg-[var(--surface-muted)] active:scale-[0.97]" onClick={() => void onDecide(draft.id, "decline")}>{t("Rechazar")}</button> : null}<button type="button" className="touch-target min-h-10 rounded-md bg-[var(--brain-accent-strong)] px-3 text-body-2-semibold text-[var(--brain-contrast)] transition-[opacity,transform] active:scale-[0.97]" onClick={() => void onDecide(draft.id, "confirm")}>{uncertain ? t("Comprobar guardado") : t("Publicar")}</button></div>}
        </div>
      ) : null}

      {draft.phase === "deciding" ? <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] px-3 py-2.5 text-body-2-regular text-[var(--text-muted)]" role="status"><SpinnerGap size={14} className="shrink-0 motion-safe:animate-spin" />{t("Aplicando la decisión de forma segura…")}</div> : null}
      {terminal ? <div className="border-t border-[var(--border-subtle)] px-3 py-2.5 text-body-2-medium text-[var(--text)]" role="status">{terminalCopy[draft.phase as keyof typeof terminalCopy]}</div> : null}
    </section>
  );
}
