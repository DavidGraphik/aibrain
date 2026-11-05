"use client";
import { useUiText, useUiLocale } from "@/i18n/provider";

import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Folder, File, HardDrive, ArrowClockwise, X } from "@phosphor-icons/react";
import { ServerFilePreview } from "./server-file-preview";
import { useModalFocus } from "@/ui/use-modal-focus";
import { isServerReference, serverDirectoryQuery, type ServerReference } from "@/documents/server-reference-contract";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
const isDrive = (item: ServerReference) => item.kind === "directory" && /^server-[^/]+\/[A-Za-z]\/?$/.test(item.path);

type Page = { navigation: boolean; results: ServerReference[]; checkedAt: string | null; nextQuery: string | null; limited: boolean };
export function ServerPicker({ projectId, selected, onSelect, onClose, returnFocus }: {
  projectId: string; selected: ServerReference[]; onSelect: (items: ServerReference[]) => void; onClose: () => void; returnFocus?: RefObject<HTMLElement | null>;
}) {
  const t = useUiText();
  const locale = useUiLocale();
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const focus = useModalFocus<HTMLDivElement>(mounted, onClose, undefined, returnFocus);
  const [query, setQuery] = useState("home");
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState(selected);
  const [previewFile, setPreviewFile] = useState<ServerReference | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/server-files?${new URLSearchParams({ projectId, query })}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        const navigation = query === "home" && data.navigation === true;
        if (!response.ok || !data.available || (!navigation && data.sourceChecked !== true)) throw new Error(data.warning || t("No se ha podido consultar Windows."));
        if (!Array.isArray(data.results)) throw new Error(t("Listado no válido."));
        const results = data.results.map((item: Record<string, unknown>) => ({ path: item.path, name: item.name, kind: item.kind, modifiedAt: item.modifiedAt, size: item.size }));
        if (!results.every(isServerReference)) throw new Error(t("Listado no válido."));
        if (!controller.signal.aborted) setPage({ navigation, results, checkedAt: data.checkedAt, nextQuery: data.nextQuery, limited: data.limited });
      }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : t("Servidor no disponible.")); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [projectId, query, revision, t]);
  const location = query.split("?")[0];
  function navigate(next: string) {
    focus.current?.focus();
    setBusy(true); setError(null); setPage(null); setQuery(next); setRevision(value => value + 1);
  }
  function toggle(item: ServerReference) {
    setSelection(current => current.some(ref => ref.path === item.path) ? current.filter(ref => ref.path !== item.path) : current.length < 5 ? [...current, item] : current);
  }
  if (!mounted) return null;
  return createPortal(<div data-testid="server-backdrop" className="fixed inset-0 z-[90] flex items-center justify-center bg-black/35 p-3" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={focus} role="dialog" aria-modal="true" aria-label={t("Server")} aria-describedby="server-description" tabIndex={-1} className="flex max-h-[85dvh] w-full max-w-3xl flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface-raised)] p-4 text-[var(--text)] shadow-xl">
      <div className="flex items-center justify-between gap-2"><h2 className="flex items-center gap-2 font-semibold">{t("Server")} <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs font-medium text-[var(--text-secondary)]">{t("Experimental")}</span></h2><button type="button" aria-label={t("Cerrar Server")} className="touch-target rounded p-2" onClick={onClose}><X size={20}/></button></div>
      <p id="server-description" className="mb-3 text-xs text-[var(--text-muted)]">{t("Archivos del servidor Windows. Selecciona hasta 5 referencias para trabajar en el chat. Los originales son de sólo lectura.")}</p>
      {previewFile ? <ServerFilePreview key={previewFile.path} projectId={projectId} file={previewFile} onBack={() => setPreviewFile(null)}/> : <>
      <div className="mb-3 flex items-center gap-2">
        <button type="button" className="touch-target rounded-lg border border-[var(--border)] px-3 py-2 text-sm" disabled={busy || location === "home"} onClick={() => location === "server:/" ? navigate("home") : navigate(location.replace(/\/$/, "").split("/").slice(0, -1).join("/").replace(/^server:$/, "server:/"))}>{t("Subir")}</button>
        <span className="min-w-0 flex-1 truncate text-sm" title={location}>{location === "home" ? t("Carpetas de trabajo") : location === "server:/" ? t("Unidades") : location.replace("server:/", "")}</span>
        <button type="button" aria-label={location === "home" ? t("Actualizar carpetas de trabajo") : t("Actualizar desde Windows")} disabled={busy} className="touch-target rounded-lg border border-[var(--border)] p-2" onClick={() => { navigate(location); }}><ArrowClockwise size={19}/></button>
      </div>
      {location === "home" ? <button type="button" className="mb-3 w-fit rounded-lg border border-[var(--border)] px-3 py-2 text-sm" onClick={() => navigate("server:/")}>{t("Explorar unidades")}</button> : <button type="button" className="mb-3 w-fit rounded-lg px-2 py-1 text-sm text-[var(--text-muted)]" onClick={() => navigate("home")}>{t("Carpetas de trabajo")}</button>}
      <div className="min-h-40 overflow-y-auto" aria-busy={busy}>
        {busy ? <p role="status" className="p-5 text-sm">{location === "home" ? t("Cargando carpetas de trabajo…") : t("Consultando Windows… Puedes cerrar esta ventana mientras se completa.")}</p> : null}
        {error ? <p role="alert" className="p-4 text-sm">{t(error)} {t("Usa Actualizar para reintentarlo. No se muestra una copia antigua.")}</p> : null}
        {page ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">{page.results.map(item => <div key={item.path} className="min-w-0 rounded-xl border border-[var(--border)] p-3">
          <button type="button" className="flex w-full flex-col items-center gap-2 rounded-lg py-3 text-sm hover:bg-[var(--surface-hover)]" aria-label={item.kind === "directory" ? t("Abrir {name}", { name: item.name }) : t("Ver {name}", { name: item.name })} onClick={() => item.kind === "directory" ? navigate(serverDirectoryQuery(item.path)) : setPreviewFile(item)}>
            {!page.navigation && isDrive(item) ? <HardDrive size={38} aria-hidden="true"/> : item.kind === "directory" ? <Folder size={38} weight="fill" className="text-sky-500"/> : <File size={34}/>}
            <span className="w-full truncate" title={item.name}>{!page.navigation && isDrive(item) ? t("Unidad {name}:", { name: item.name }) : item.name}</span>
          </button>
          {!page.navigation && !isDrive(item) ? <label className="flex cursor-pointer items-center gap-2 text-xs"><input type="checkbox" aria-label={t("Adjuntar {name}", { name: item.name })} checked={selection.some(ref => ref.path === item.path)} disabled={selection.length >= 5 && !selection.some(ref => ref.path === item.path)} onChange={() => toggle(item)}/>{t("Seleccionar")}</label> : null}
        </div>)}</div> : null}
        {page && !page.results.length ? <p className="p-4 text-sm">{page.navigation ? t("Explora las unidades para ver las carpetas disponibles.") : t("Sin elementos visibles en esta ubicación.")}</p> : null}
      </div>
      {page ? <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]"><span>{page.navigation ? t("Abre una carpeta para consultar sus archivos.") : <>{t("Consultado:")} {new Date(page.checkedAt!).toLocaleTimeString(locale)}{page.limited ? t(" · listado parcial") : ""}</>}</span>{page.nextQuery ? <button type="button" className="touch-target rounded border px-3 py-2" onClick={() => navigate(page.nextQuery!)}>{t("Siguiente página")}</button> : null}</div> : null}
      </>}
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-[var(--border)] pt-3"><span className="text-xs">{selection.length} {t("seleccionadas · las carpetas no se cargan completas")}</span><button type="button" disabled={!selection.length} className="touch-target rounded-xl bg-[var(--send-button)] px-4 py-2 text-sm text-[var(--send-button-text)] disabled:opacity-40" onClick={() => { onSelect(selection); onClose(); }}>{t("Adjuntar referencias")}</button></div>
    </div>
  </div>, document.body);
}
