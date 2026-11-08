"use client";
import { useEffect, useRef, useState } from "react";
import { useUiText } from "@/i18n/provider";
import { AuthenticatedPdfPreview } from "./authenticated-pdf-preview";
import { SpreadsheetTable } from "./authenticated-spreadsheet-preview";
import { isSpreadsheetPreview, type SpreadsheetPreview } from "@/documents/spreadsheet-preview";
import type { ServerReference } from "@/documents/server-reference-contract";

type Preview = { path: string; content: string; sha256: string; nextPath: string | null; truncated: boolean; preview: SpreadsheetPreview | null };
export function ServerFilePreview({ projectId, file, onBack }: { projectId: string; file: ServerReference; onBack: () => void }) {
  const t = useUiText();
  const pdf = /\.pdf$/i.test(file.name);
  const originalUrl = `/api/server-files/original?${new URLSearchParams({ projectId, path: file.path })}`;
  const [path, setPath] = useState(file.path);
  const [retry, setRetry] = useState(0);
  const [pages, setPages] = useState<string[]>([]);
  const [state, setState] = useState<{ data?: Preview; error?: string }>({});
  const sourceHash = useRef<string | null>(null);
  useEffect(() => {
    if (pdf) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/server-files/preview?${new URLSearchParams({ projectId, path })}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok || !data.available || data.path !== path || typeof data.content !== "string" || !/^[a-f0-9]{64}$/.test(data.sha256)) throw Error(data.error === "SERVER_FORMAT_NOT_READABLE" ? "UNSUPPORTED_FORMAT" : "READ_UNAVAILABLE");
        if (sourceHash.current && sourceHash.current !== data.sha256) throw Error("SOURCE_CHANGED");
        if (!controller.signal.aborted) {
          sourceHash.current = data.sha256;
          setState({ data: { ...data, preview: isSpreadsheetPreview(data.preview) ? data.preview : null } });
        }
      } catch (error) {
        if (!controller.signal.aborted) setState({ error: error instanceof Error ? error.message : "READ_UNAVAILABLE" });
      }
    })();
    return () => controller.abort();
  }, [projectId, path, retry, pdf]);
  const button = "touch-target rounded-lg border border-[var(--border)] px-3 py-2 text-sm";
  const changePage = (next: string) => { setState({}); setPath(next); };
  return <section className="flex min-h-0 flex-1 flex-col gap-3" aria-label={t("Vista previa del servidor")}>
    <div className="flex items-center gap-3"><button className={button} onClick={onBack}>{t("Volver a la carpeta")}</button><h3 className="min-w-0 break-words font-semibold">{file.name}</h3></div>
    <p className="text-xs text-[var(--text-muted)]">{t("Vista de lectura. El original no se modifica. Word se muestra como texto extraído; las macros no se ejecutan.")}</p>
    {pdf ? <AuthenticatedPdfPreview previewUrl={originalUrl} title={file.name} maximumBytes={16 * 1024 * 1024} className="h-[52dvh] min-h-72 w-full"/> : null}
    {!pdf && !state.data && !state.error ? <p role="status">{t("Leyendo el archivo desde Windows…")}</p> : null}
    {state.error ? <div role="alert"><p>{state.error === "UNSUPPORTED_FORMAT" ? t("Este formato todavía no tiene vista previa. El archivo no se ha ejecutado ni modificado.") : state.error === "SOURCE_CHANGED" ? t("El archivo ha cambiado. Vuelve a abrirlo para leer una única versión.") : t("No se ha podido leer este archivo. Puede faltar permiso, no estar disponible o ser un formato no compatible. No se muestra una copia antigua.")}</p>{state.error !== "UNSUPPORTED_FORMAT" ? <button className={button} onClick={() => { setState({}); sourceHash.current = null; setPages([]); setPath(file.path); setRetry(n => n + 1); }}>{t("Reintentar")}</button> : null}</div> : null}
    {state.data ? <>
      {state.data.preview ? <div className="h-[48dvh] min-h-64"><SpreadsheetTable preview={state.data.preview}/></div> : <pre className="min-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--border)] p-4 text-sm">{state.data.content}</pre>}
      {state.data.truncated ? <p role="status" className="text-xs">{t("Vista parcial. Continúa a la siguiente parte para leer el resto.")}</p> : null}
      <nav className="flex items-center gap-3" aria-label={t("Partes del archivo")}>
        <button className={button} disabled={!pages.length} onClick={() => { const previous = pages.at(-1)!; setPages(p => p.slice(0, -1)); changePage(previous); }}>{t("Parte anterior")}</button>
        <span>{pages.length + 1}</span>
        <button className={button} disabled={!state.data.nextPath} onClick={() => { setPages(p => [...p, path]); changePage(state.data!.nextPath!); }}>{t("Siguiente parte")}</button>
      </nav>
    </> : null}
  </section>;
}
