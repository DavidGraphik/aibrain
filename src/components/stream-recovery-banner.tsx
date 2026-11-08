"use client";
import { useUiText } from "@/i18n/provider";
import { WarningCircle } from "@phosphor-icons/react";

export function StreamRecoveryBanner({ attempt, paused = false, admissionUnconfirmed = false, onRetry }: { attempt: number | null; paused?: boolean; admissionUnconfirmed?: boolean; onRetry?: () => void }) {
  const t = useUiText();
  if (attempt === null && !paused) return null;
  return (
    <div className="menu-enter flex min-h-11 items-center justify-center gap-2 rounded-[18px] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-4 py-2.5 text-center text-[12px] text-[var(--text-secondary)] shadow-[var(--shadow-popover)]" role="status" aria-live="polite">
      <WarningCircle size={15} className="shrink-0 text-[var(--text-subtle)]" />
      <span>{admissionUnconfirmed ? t("La solicitud aún no está confirmada. Los reintentos están pausados; la parada del servidor no está confirmada.") : paused ? t("No se puede comprobar la respuesta ahora. El trabajo y los resultados guardados se conservan.")
        : attempt === 0 ? t("Recuperando la respuesta guardada…")
        : <>{t("Reconectando la respuesta (intento")} {attempt}{t("). El historial se conserva.")}</>}</span>
      {paused && !admissionUnconfirmed && onRetry ? <button type="button" className="min-h-9 shrink-0 rounded-full border border-[var(--border-strong)] px-3 font-medium text-[var(--text)]" onClick={onRetry}>{t("Reconectar respuesta")}</button> : null}
    </div>
  );
}
