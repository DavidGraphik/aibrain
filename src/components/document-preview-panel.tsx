"use client";
import { useUiText } from "@/i18n/provider";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowsIn, ArrowsOut, CaretLeft, CaretRight, DownloadSimple, FileDoc, FilePdf, FilePpt, FileText, FileXls, Minus, Plus, WarningCircle, X } from "@phosphor-icons/react";
import type { DocumentArtifact } from "@/lib/chat-contract";
import { AuthenticatedPdfPreview } from "@/components/authenticated-pdf-preview";
import { AuthenticatedTextPreview } from "@/components/authenticated-text-preview";
import { AuthenticatedSpreadsheetPreview } from "@/components/authenticated-spreadsheet-preview";
import { AuthenticatedDocumentPagePreview } from "@/components/authenticated-document-page-preview";
import { useModalFocus } from "@/ui/use-modal-focus";

function documentIcon(kind: DocumentArtifact["kind"]) {
  if (kind === "docx") return <FileDoc size={17} />;
  if (kind === "xlsx" || kind === "xls") return <FileXls size={17} />;
  if (kind === "pptx") return <FilePpt size={17} />;
  if (kind === "text") return <FileText size={17} />;
  return <FilePdf size={17} />;
}

export function DocumentPreviewPanel(props: { artifact: DocumentArtifact; onClose: () => void }) {
  return <DocumentPreviewContent key={`${props.artifact.id}:${props.artifact.previewUrl}`} {...props} />;
}

function DocumentPreviewContent({ artifact, onClose }: {
  artifact: DocumentArtifact;
  onClose: () => void;
}) {
  const t = useUiText();
  const workbook = artifact.kind === "xlsx";
  const gridUrl = workbook && artifact.previewUrl?.endsWith("?preview=1")
    ? artifact.previewUrl.replace(/\?preview=1$/u, "?grid=1") : null;
  const [workbookView, setWorkbookView] = useState<"formatted" | "data">("formatted");
  const [loaded, setLoaded] = useState(artifact.kind === "text" || artifact.previewFormat === "spreadsheet");
  const [failureReason, setFailureReason] = useState<string | null>(null);
  const [failed, setFailed] = useState(!artifact.previewUrl);
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(artifact.pages);
  const [zoom, setZoom] = useState(100);
  const [fullscreen, setFullscreen] = useState(false);
  const previewKind = artifact.kind === "pdf" ? "PDF" : "documento";
  const [mobileOverlay, setMobileOverlay] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const modal = mobileOverlay || fullscreen;
  const exitModal = useCallback(() => { if (fullscreen) setFullscreen(false); else onClose(); }, [fullscreen, onClose]);
  const panelRef = useModalFocus<HTMLElement>(modal, exitModal, closeButtonRef);
  const handleLoad = useCallback(() => setLoaded(true), []);
  const handleError = useCallback((error: Error) => { setFailureReason(error.message); setFailed(true); }, []);
  // Generated workbooks support the same authenticated page renderer as other
  // Office documents. Do not depend on a browser's native PDF plugin to show them.
  // Explicit deliveries may not have page metadata yet, including historic messages.
  const richPages = !(workbook && workbookView === "data") && Boolean(artifact.previewUrl?.match(/^\/api\/threads\/[^/]+\/artifacts\/[^/?]+\?preview=1$/) ||
    (pageCount && artifact.previewUrl?.startsWith("/api/threads/")));

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 1279px)");
    const sync = () => setMobileOverlay(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !panelRef.current?.contains(target) ||
          target.closest("input, textarea, select, [contenteditable]:not([contenteditable=\"false\"])") ||
          event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      if (["ArrowLeft", "ArrowRight", "+", "=", "-"].includes(event.key)) event.preventDefault();
      if (event.key === "ArrowLeft" && page > 1) setPage((current) => current - 1);
      if (event.key === "ArrowRight" && pageCount && page < pageCount) setPage((current) => current + 1);
      if (event.key === "+" || event.key === "=") setZoom((current) => Math.min(200, current + 25));
      if (event.key === "-") setZoom((current) => Math.max(50, current - 25));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pageCount, page, panelRef]);

  const retry = () => {
    if (!artifact.previewUrl) return;
    setLoaded(artifact.kind === "text" || artifact.previewFormat === "spreadsheet" || (workbook && workbookView === "data"));
    setFailed(false);
    setFailureReason(null);
    setReload((current) => current + 1);
  };

  return (
    <aside
      ref={panelRef}
      aria-label={t("Vista previa de {p0}", { p0: artifact.name })}
      aria-modal={modal ? "true" : undefined}
      role={modal ? "dialog" : undefined}
      tabIndex={modal ? -1 : undefined}
      className={`document-preview-panel fixed inset-0 z-50 flex min-w-0 flex-col bg-[var(--surface)] ${fullscreen ? "xl:fixed xl:inset-0 xl:z-[80] xl:w-auto" : "xl:static xl:z-auto xl:w-[min(48vw,720px)] xl:shrink-0 xl:border-l xl:border-[var(--border)]"}`}
    >
      <header className="flex min-h-[52px] shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-3.5 pt-[env(safe-area-inset-top)] xl:h-[52px] xl:pt-0">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--surface-muted)] text-[var(--text-secondary)]">{documentIcon(artifact.previewFormat === "spreadsheet" ? "xlsx" : artifact.kind)}</span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13px] font-semibold text-[var(--text)]">{artifact.name}</h2>
          <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">{artifact.previewFormat === "spreadsheet" || (workbook && workbookView === "data") ? t("Excel · vista de datos") : workbook ? t("Excel · vista con formato") : artifact.kind.toUpperCase()}{!workbook && pageCount ? ` · ${pageCount} ${pageCount === 1 ? t("página") : t("páginas")}` : ""}</p>
        </div>
        {gridUrl ? <button type="button" className="touch-target rounded-md border border-[var(--border)] px-2 text-[11px] font-medium text-[var(--text-secondary)]" onClick={() => {
          setWorkbookView((current) => current === "formatted" ? "data" : "formatted");
          setLoaded(workbookView === "formatted");
          setFailed(false);
        }}>{workbookView === "formatted" ? t("Datos") : t("Formato")}</button> : null}
        <button type="button" className="touch-target grid size-9 place-items-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]" aria-label={fullscreen ? t("Salir de pantalla completa") : t("Pantalla completa")} onClick={() => setFullscreen((current) => !current)}>{fullscreen ? <ArrowsIn size={17} /> : <ArrowsOut size={17} />}</button>
        <a href={artifact.url} download={artifact.previewFormat === "spreadsheet" ? `${artifact.name}.preview.json` : artifact.name} className="touch-target grid size-9 place-items-center rounded-lg text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] active:scale-[0.98]" aria-label={artifact.previewFormat === "spreadsheet" ? t("Descargar datos de la vista previa") : t("Descargar {p0}", { p0: artifact.name })} title={t("Descargar")}><DownloadSimple size={17} /></a>
        <button ref={closeButtonRef} type="button" className="touch-target grid size-9 place-items-center rounded-lg text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] active:scale-[0.98]" aria-label={t("Cerrar vista previa")} onClick={onClose}><X size={17} /></button>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--surface-muted)] p-2 pb-[max(.5rem,env(safe-area-inset-bottom))] md:p-3 xl:pb-3">
        {!loaded && !failed ? (
          <div className="absolute inset-2 z-10 overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-5 md:inset-3" role="status" aria-label={t("Cargando vista previa del {p0}", { p0: previewKind })}>
            <div className="mx-auto h-full max-w-[520px] animate-pulse rounded-md bg-white p-10 shadow-[var(--shadow-sm)]">
              <div className="h-5 w-2/3 rounded bg-[var(--surface-muted)]" />
              <div className="mt-8 space-y-3"><div className="h-3 rounded bg-[var(--surface-muted)]" /><div className="h-3 rounded bg-[var(--surface-muted)]" /><div className="h-3 w-5/6 rounded bg-[var(--surface-muted)]" /></div>
            </div>
          </div>
        ) : null}
        {failed ? (
          <div className="grid h-full place-items-center rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-8 text-center" role="alert">
            <div className="max-w-64"><WarningCircle size={24} className="mx-auto text-[var(--danger)]" /><p className="mt-3 text-[13px] font-semibold text-[var(--text)]">{t("No se ha podido mostrar el")}{" "}{previewKind}</p><p className="mt-1.5 text-[12px] leading-5 text-[var(--text-muted)]">{failureReason ?? t("Puedes volver a intentarlo o descargar el archivo original.")}</p><button type="button" className="touch-target mt-4 inline-flex min-h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[12px] font-medium text-[var(--text)] hover:bg-[var(--surface-hover)] active:scale-[0.98]" onClick={retry}><ArrowClockwise size={14} />{t("Reintentar")}</button></div>
          </div>
        ) : artifact.previewUrl && artifact.previewFormat === "spreadsheet" ? (
          <AuthenticatedSpreadsheetPreview key={`${artifact.id}:${reload}`} previewUrl={artifact.previewUrl} />
        ) : gridUrl && workbookView === "data" ? (
          <AuthenticatedSpreadsheetPreview key={`${artifact.id}:${reload}`} previewUrl={gridUrl} />
        ) : artifact.previewUrl && artifact.kind === "text" ? (
          <AuthenticatedTextPreview key={`${artifact.id}:${reload}`} previewUrl={artifact.previewUrl} title={t("Documento {p0}", { p0: artifact.name })} />
        ) : artifact.previewUrl && richPages ? (
          <AuthenticatedDocumentPagePreview
            key={`${artifact.id}:${reload}:${page}`}
            previewUrl={artifact.previewUrl}
            page={page}
            zoom={zoom}
            title={t("Documento {p0}", { p0: artifact.name })}
            onLoad={handleLoad}
            onError={handleError}
            onPageCount={setPageCount}
          />
        ) : artifact.previewUrl ? (
          <AuthenticatedPdfPreview
            key={`${artifact.id}:${reload}`}
            previewUrl={artifact.previewUrl}
            title={t("Documento {p0}", { p0: artifact.name })}
            className={`h-full w-full rounded-xl border border-[var(--border)] bg-white shadow-[var(--shadow-sm)] transition-opacity duration-200 ${loaded ? "opacity-100" : "opacity-0"}`}
            onLoad={handleLoad}
            onError={handleError}
          />
        ) : null}
      </div>
      {richPages ? <nav className="flex shrink-0 items-center justify-center gap-1 border-t border-[var(--border-subtle)] bg-[var(--surface)] px-2 py-1.5" aria-label={t("Navegación del documento")}>
        <button type="button" disabled={page <= 1} className="touch-target grid size-10 place-items-center rounded-lg disabled:opacity-30" aria-label={t("Página anterior")} onClick={() => setPage((current) => Math.max(1, current - 1))}><CaretLeft size={17} /></button>
        <span className="min-w-14 text-center text-[12px] tabular-nums">{page} / {pageCount ?? "…"}</span>
        <button type="button" disabled={!pageCount || page >= pageCount} className="touch-target grid size-10 place-items-center rounded-lg disabled:opacity-30" aria-label={t("Página siguiente")} onClick={() => setPage((current) => Math.min(pageCount ?? current, current + 1))}><CaretRight size={17} /></button>
        <button type="button" disabled={zoom <= 50} className="touch-target grid size-10 place-items-center rounded-lg disabled:opacity-30" aria-label={t("Alejar")} onClick={() => setZoom((current) => Math.max(50, current - 25))}><Minus size={16} /></button>
        <span className="w-10 text-center text-[12px] tabular-nums">{zoom}%</span>
        <button type="button" disabled={zoom >= 200} className="touch-target grid size-10 place-items-center rounded-lg disabled:opacity-30" aria-label={t("Acercar")} onClick={() => setZoom((current) => Math.min(200, current + 25))}><Plus size={16} /></button>
      </nav> : null}
    </aside>
  );
}
