"use client";

import { useEffect, useState } from "react";
import { useUiText } from "@/i18n/provider";
import type { SupportRequest } from "@/support/contracts";

/** Only this authenticated user's endpoint is read; no ticket content is saved in browser storage. */
export function SupportInboxNotice({ accountKey, open, onOpen }: { accountKey: string; open: boolean; onOpen: () => void }) {
  const t = useUiText();
  const [latest, setLatest] = useState("");
  const [seen, setSeen] = useState("");
  useEffect(() => {
    const key = `aibrain.support.seen.${accountKey}`;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let saved = "";
    try { saved = localStorage.getItem(key) ?? ""; } catch { /* A private inbox also works without browser storage. */ }
    const refresh = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      controller?.abort(); controller = new AbortController();
      const activeController = controller;
      try {
        const response = await fetch("/api/support", { cache: "no-store", signal: activeController.signal });
        if (response.status === 401 || response.status === 403) { stopped = true; return; }
        if (response.ok) {
          const value = await response.json() as { requests?: SupportRequest[] };
          if (!stopped && !activeController.signal.aborted && Array.isArray(value.requests)) {
            setSeen(saved);
            const date = value.requests.flatMap(r => r.messages ?? []).filter(m => m.author === "support")
              .map(m => m.createdAt).filter(d => Number.isFinite(Date.parse(d))).sort().at(-1) ?? "";
            setLatest(date);
            if (open && date) { setSeen(date); try { localStorage.setItem(key, date); } catch { /* optional */ } }
          }
        }
      } catch { /* Keep the last real notification; never imply delivery succeeded on a failed fetch. */ }
      if (!stopped && !activeController.signal.aborted) timer = setTimeout(() => void refresh(), 30_000);
    };
    const visibility = () => { clearTimeout(timer); controller?.abort(); if (document.visibilityState !== "hidden") void refresh(); };
    const requested = new URLSearchParams(window.location.search).get("support") === "open";
    if (requested) onOpen();
    void refresh(); document.addEventListener("visibilitychange", visibility);
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", visibility); };
  }, [accountKey, open, onOpen]);
  if (open || !latest || latest <= seen) return null;
  return <button type="button" onClick={onOpen} role="status" aria-label={t("Tienes una respuesta de soporte")} className="touch-target m-2 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-left text-xs text-[var(--text)]">{t("Tienes una respuesta de soporte")}</button>;
}
