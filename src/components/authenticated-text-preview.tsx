"use client";
import { useUiText } from "@/i18n/provider";

import { useEffect, useState } from "react";
import { ArrowClockwise, SpinnerGap, WarningCircle } from "@phosphor-icons/react";

const MAXIMUM_TEXT_BYTES = 2 * 1024 * 1024;

export function AuthenticatedTextPreview({ previewUrl, title }: { previewUrl: string; title: string }) {
  const t = useUiText();
  const [reload, setReload] = useState(0);
  const source = `${previewUrl}:${reload}`;
  const [state, setState] = useState<{ source: string; status: "loading" | "ready" | "error"; content?: string }>({ source, status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    if (!previewUrl.startsWith("/api/")) {
      queueMicrotask(() => setState({ source, status: "error" }));
      return () => controller.abort();
    }
    void fetch(previewUrl, { cache: "no-store", credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("text unavailable");
        const declared = Number(response.headers.get("Content-Length") ?? "0");
        if (declared && (!Number.isSafeInteger(declared) || declared > MAXIMUM_TEXT_BYTES)) throw new Error("text too large");
        const content = await response.text();
        if (new TextEncoder().encode(content).byteLength > MAXIMUM_TEXT_BYTES) throw new Error("text too large");
        if (!controller.signal.aborted) setState({ source, status: "ready", content });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ source, status: "error" });
      });
    return () => controller.abort();
  }, [previewUrl, reload, source]);

  const visible = state.source === source ? state : { source, status: "loading" as const };

  if (visible.status === "loading") {
    return <div className="flex min-h-64 items-center justify-center gap-2 text-[12px] text-[var(--text-subtle)]" role="status"><SpinnerGap size={16} className="motion-safe:animate-spin" />{t("Cargando representación segura…")}</div>;
  }
  if (visible.status === "error") {
    return <div className="px-8 text-center" role="alert"><WarningCircle size={22} className="mx-auto text-[var(--danger)]" /><p className="mt-3 text-[12px] font-semibold text-[var(--text)]">{t("No se ha podido mostrar el texto")}</p><button type="button" className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-full border border-[var(--border)] px-3 text-[11px] font-medium text-[var(--text)]" onClick={() => setReload((current) => current + 1)}><ArrowClockwise size={13} />{t("Reintentar")}</button></div>;
  }
  return <pre aria-label={title} tabIndex={0} className="scrollbar-thin max-h-[460px] w-full overflow-auto whitespace-pre-wrap break-words p-4 text-left font-mono text-[12px] leading-5 text-[var(--text)]"><code>{visible.content}</code></pre>;
}
