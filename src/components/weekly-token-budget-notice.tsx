"use client";

import { useEffect, useRef, useState } from "react";
import { useUiLocale, useUiText } from "@/i18n/provider";
import { isEmployeeWeeklyBudgetResponse, type EmployeeWeeklyBudget } from "@/usage/employee-budget-contract";

export function WeeklyTokenBudgetNotice({ tenantId, userId, modalOpen = false }: {
  tenantId: string;
  userId: string;
  modalOpen?: boolean;
}) {
  const t = useUiText();
  const locale = useUiLocale();
  const [budget, setBudget] = useState<EmployeeWeeklyBudget | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [warning, setWarning] = useState<{ weekStart: string; threshold: number } | null>(null);
  const seenRef = useRef(new Map<string, number>());
  const budgetEnabledRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (document.visibilityState === "hidden" || inFlight) return;
      inFlight = true;
      try {
        const response = await fetch("/api/usage/budget", {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Budget unavailable");
        const payload: unknown = await response.json();
        if (!isEmployeeWeeklyBudgetResponse(payload)) {
          throw new Error("Invalid budget response");
        }
        if (disposed) return;
        const next = payload.budget;
        budgetEnabledRef.current = next !== null;
        setBudget(next);
        setUnavailable(Boolean(next && !next.initialized));
        if (!next || !next.initialized || next.threshold === 100 || next.threshold === 0) {
          setWarning(null);
          return;
        }
        const key = `aibrain.${tenantId}.${userId}.weekly-budget.${next.weekStart}`;
        let seen = seenRef.current.get(key) ?? 0;
        try {
          const saved = Number(localStorage.getItem(key));
          if ([25, 50, 75].includes(saved)) seen = Math.max(seen, saved);
        } catch { /* Browser storage is optional; deduplicate in memory for this visit. */ }
        if (next.threshold > seen) {
          // If several milestones passed while away, one notice shows the latest milestone.
          seenRef.current.set(key, next.threshold);
          try { localStorage.setItem(key, String(next.threshold)); } catch { /* Optional storage. */ }
          setWarning({ weekStart: next.weekStart, threshold: next.threshold });
        } else {
          setWarning((current) => current?.weekStart === next.weekStart ? current : null);
        }
      } catch {
        if (!disposed && budgetEnabledRef.current) setUnavailable(true);
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [tenantId, userId]);

  if (!budget && !unavailable) return null;
  const exhausted = budget?.initialized && budget.threshold === 100;
  const reset = budget ? new Intl.DateTimeFormat(locale, {
    dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Madrid",
  }).format(new Date(budget.resetAt)) : null;

  return (
    <section aria-label={t("Saldo semanal compartido")} className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 text-[11px] leading-5 text-[var(--text-secondary)] sm:px-5">
      {unavailable ? <p role="alert" className="font-medium text-[var(--text)]">{t("No se puede comprobar el saldo semanal. No se pueden iniciar nuevas solicitudes.")}</p> : budget?.initialized ? <>
        <p>{t("Saldo semanal disponible: {percent}%", { percent: budget.remainingPercent! })}</p>
        <p>{t("Se renueva el {date} (hora de Madrid).", { date: reset! })}</p>
        {exhausted ? <p role="alert" className="font-medium text-[var(--text)]">{t("Límite semanal agotado. Las nuevas solicitudes están bloqueadas hasta la renovación.")}</p> : warning ? <div role="status" aria-live="polite" aria-atomic="true" className="mt-1 flex items-center gap-2 font-medium text-[var(--text)]">
          <span className="min-w-0 flex-1">{t("Aviso: queda un {percent}% o menos del saldo semanal compartido.", { percent: 100 - warning.threshold })}</span>
          {!modalOpen ? <button type="button" onClick={() => setWarning(null)} className="touch-target shrink-0 rounded-lg px-2 font-medium hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" aria-label={t("Cerrar aviso de consumo semanal")}>{t("Entendido")}</button> : null}
        </div> : null}
      </> : null}
    </section>
  );
}
