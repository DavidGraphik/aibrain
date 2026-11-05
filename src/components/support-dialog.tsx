"use client";
import { useUiText } from "@/i18n/provider";

import { Bug, Lightbulb, Question, SpinnerGap, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { SupportKind, SupportRequest } from "@/support/contracts";
import { useModalFocus } from "@/ui/use-modal-focus";

type ScreenshotDraft = { name: string; mimeType: string; dataUrl: string };
type Submission = { fingerprint: string; id: string };
const MAX_SCREENSHOTS = 3;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const choices: Array<{ id: SupportKind; label: string; icon: typeof Bug }> = [
  { id: "bug", label: "Bug", icon: Bug },
  { id: "request", label: "Request", icon: Lightbulb },
  { id: "help", label: "Ayuda", icon: Question },
];
const statusLabels: Record<string, string> = {
  queued: "Recibida", investigating: "En revisión", working: "En curso", verifying: "Comprobando",
  resolved: "Resuelta", escalated: "Revisión especializada", declined: "No aplicada", needs_information: "Necesitamos más información",
};

async function readScreenshot(file: File): Promise<ScreenshotDraft> {
  if (!IMAGE_TYPES.has(file.type)) throw new Error("Usa capturas PNG, JPEG o WebP.");
  if (!file.size || file.size > MAX_SCREENSHOT_BYTES) throw new Error("Cada captura puede ocupar hasta 2 MB.");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("No se ha podido leer la captura."));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("No se ha podido leer la captura."));
    reader.readAsDataURL(file);
  });
  return { name: file.name.slice(0, 120) || "captura.png", mimeType: file.type, dataUrl };
}

function responseError(result: unknown, fallback: string) {
  return result && typeof result === "object" && "error" in result && typeof result.error === "string" ? result.error : fallback;
}

export function SupportDialog({ open, projectId, threadId, returnFocusRef, navigation, onClose }: {
  open: boolean;
  navigation?: { view: "new" | "history"; onViewChange: Dispatch<SetStateAction<"new" | "history">> };
  projectId: string | null;
  threadId: string | null;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<SupportKind>("help");
  const [description, setDescription] = useState("");
  const [screenshots, setScreenshots] = useState<ScreenshotDraft[]>([]);
  const submissionRef = useRef<Submission | null>(null);
  const replySubmissionRef = useRef<Submission | null>(null);
  const [reply, setReply] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [localView, setLocalView] = useState<"new" | "history">("new");
  const view = navigation?.view ?? localView;
  const setView = navigation?.onViewChange ?? setLocalView;
  if (!open) return null;
  return <OpenSupportDialog kind={kind} setKind={setKind} description={description} setDescription={setDescription}
    screenshots={screenshots} setScreenshots={setScreenshots} submissionRef={submissionRef}
    reply={reply} setReply={setReply} replySubmissionRef={replySubmissionRef} selectedId={selectedId} setSelectedId={setSelectedId} view={view} setView={setView}
    projectId={projectId} threadId={threadId} returnFocusRef={returnFocusRef} onClose={onClose} />;
}

function OpenSupportDialog({ kind, setKind, description, setDescription, screenshots, setScreenshots, submissionRef, reply, setReply, replySubmissionRef, selectedId, setSelectedId, view, setView, projectId, threadId, returnFocusRef, onClose }: {
  kind: SupportKind;
  setKind: Dispatch<SetStateAction<SupportKind>>;
  description: string;
  setDescription: Dispatch<SetStateAction<string>>;
  screenshots: ScreenshotDraft[];
  setScreenshots: Dispatch<SetStateAction<ScreenshotDraft[]>>;
  submissionRef: RefObject<Submission | null>;
  reply: string;
  setReply: Dispatch<SetStateAction<string>>;
  replySubmissionRef: RefObject<Submission | null>;
  selectedId: string | null;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  view: "new" | "history";
  setView: Dispatch<SetStateAction<"new" | "history">>;
  projectId: string | null;
  threadId: string | null;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const t = useUiText();
  const [busy, setBusy] = useState(false);
  const [readingImages, setReadingImages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [sentId, setSentId] = useState<string | null>(null);
  const [requests, setRequests] = useState<SupportRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const loading = useRef(false);
  const mounted = useRef(true);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalFocus<HTMLDivElement>(true, () => !busy && !readingImages && onClose(), closeRef, returnFocusRef);
  const selected = requests.find((item) => item.id === selectedId);
  const locked = busy || readingImages;

  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const response = await fetch("/api/support", { cache: "no-store" });
      const result: unknown = await response.json();
      if (!response.ok || !result || typeof result !== "object" || !("requests" in result) || !Array.isArray(result.requests)) throw new Error("unavailable");
      if (mounted.current) {
        setRequests(result.requests.filter((item): item is SupportRequest => Boolean(item && typeof item === "object" && typeof item.id === "string")));
        setLoaded(true); setLoadError(false);
      }
    } catch { if (mounted.current) setLoadError(true); }
    finally { loading.current = false; }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const initial = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 30_000);
    return () => { mounted.current = false; window.clearTimeout(initial); window.clearInterval(interval); };
  }, [refresh]);

  const addScreenshots = async (files: File[]) => {
    if (locked || !files.length) return;
    if (screenshots.length + files.length > MAX_SCREENSHOTS) { setError(t("Puedes adjuntar hasta 3 capturas.")); return; }
    setReadingImages(true); setError(null);
    try {
      const images = await Promise.all(files.map(readScreenshot));
      if (mounted.current) setScreenshots((previous) => [...previous, ...images].slice(0, MAX_SCREENSHOTS));
    } catch (cause) { if (mounted.current) setError(t(cause instanceof Error ? cause.message : "No se ha podido leer la captura.")); }
    finally { if (mounted.current) setReadingImages(false); }
  };

  const submit = async () => {
    if (!description.trim() || locked) return;
    setBusy(true); setError(null);
    const input = { kind, description, screenshots, context: {
      pathname: window.location.pathname, projectId, threadId,
      viewport: window.matchMedia("(max-width: 767px)").matches ? "mobile" : "desktop",
    } };
    const fingerprint = JSON.stringify(input);
    if (submissionRef.current?.fingerprint !== fingerprint) submissionRef.current = { fingerprint, id: crypto.randomUUID() };
    try {
      const response = await fetch("/api/support", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, clientRequestId: submissionRef.current.id }) });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok || !result || typeof result !== "object" || !("request" in result)) throw new Error(responseError(result, t("No se ha podido guardar la solicitud.")));
      const request = (result as { request?: { id?: unknown } }).request;
      if (typeof request?.id !== "string") throw new Error(t("No se ha podido guardar la solicitud."));
      setSentId(request.id); setDescription(""); setScreenshots([]); submissionRef.current = null;
      void refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("No se ha podido guardar la solicitud.")); }
    finally { setBusy(false); }
  };

  const sendReply = async () => {
    if (!selected || !reply.trim() || busy) return;
    setBusy(true); setError(null);
    const fingerprint = JSON.stringify({ id: selected.id, body: reply.trim() });
    if (replySubmissionRef.current?.fingerprint !== fingerprint) replySubmissionRef.current = { fingerprint, id: crypto.randomUUID() };
    try {
      const response = await fetch(`/api/support/${encodeURIComponent(selected.id)}/reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: reply.trim(), clientRequestId: replySubmissionRef.current.id }) });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(result, t("No se ha podido enviar la respuesta.")));
      setReply(""); replySubmissionRef.current = null; await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("No se ha podido enviar la respuesta.")); }
    finally { setBusy(false); }
  };

  const switchView = (next: "new" | "history") => { setView(next); setError(null); };
  return <div className="workspace-overlay fixed inset-0 z-[70] grid place-items-center p-3 sm:p-4" onMouseDown={(event) => event.target === event.currentTarget && !locked && onClose()}>
    <div ref={dialogRef} data-testid="support-dialog-panel" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="support-title" className="support-dialog-panel workspace-panel flex max-h-[calc(100dvh-1.5rem)] w-full max-w-xl flex-col overflow-hidden rounded-[22px] border border-[var(--border)] bg-[var(--surface-raised)] shadow-[var(--shadow-lg)] outline-none sm:max-h-[calc(100dvh-2rem)]">
      <header className="workspace-panel-header flex shrink-0 items-center border-b border-[var(--border-subtle)] px-5"><div className="min-w-0 flex-1"><h2 id="support-title" className="workspace-panel-title">{t("Ayuda y feedback")}</h2><p className="workspace-panel-subtitle mt-0.5">{t("Cuéntanos qué ocurre. Recibirás la respuesta aquí.")}</p></div><button ref={closeRef} type="button" disabled={locked} aria-label={t("Cerrar")} className="touch-target grid size-10 place-items-center rounded-full hover:bg-[var(--surface-hover)] disabled:opacity-40" onClick={onClose}><X size={17} /></button></header>
      <nav aria-label={t("Solicitudes de soporte")} className="flex shrink-0 gap-2 border-b border-[var(--border-subtle)] px-5 py-2">
        <button type="button" disabled={locked} aria-pressed={view === "new"} className="touch-target rounded-full px-3 py-2 text-xs aria-pressed:bg-[var(--surface-hover)]" onClick={() => switchView("new")}>{t("Nueva solicitud")}</button>
        <button type="button" disabled={locked} aria-pressed={view === "history"} className="touch-target rounded-full px-3 py-2 text-xs aria-pressed:bg-[var(--surface-hover)]" onClick={() => switchView("history")}>{t("Mis solicitudes")}{requests.length ? ` (${requests.length})` : ""}</button>
      </nav>
      {view === "new" ? <form className="min-h-0 space-y-5 overflow-y-auto p-5" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <fieldset disabled={locked}><legend className="text-[11px] font-semibold">{t("Tipo")}</legend><div className="mt-2 grid grid-cols-3 gap-2">{choices.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-pressed={kind === id} onClick={() => setKind(id)} className={`touch-target flex min-h-11 items-center justify-center gap-2 rounded-xl border text-[11px] font-semibold ${kind === id ? "border-[var(--brain-accent)] bg-[var(--brain-accent-soft)] text-[var(--brain-accent-on-soft)]" : "border-[var(--border)] text-[var(--text-secondary)]"}`}><Icon size={15} />{t(label)}</button>)}</div></fieldset>
        <label htmlFor="support-description" className="block text-[11px] font-semibold">{t("Descripción")}<textarea id="support-description" autoFocus disabled={locked} value={description} maxLength={10_000} rows={5} required onChange={(event) => { setDescription(event.target.value); setSentId(null); }} onPaste={(event) => {
          const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
          if (files.length) { event.preventDefault(); void addScreenshots(files); }
        }} placeholder={t("Explica qué necesitas, qué esperabas y qué ocurrió.")} className="mt-2 w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-3 text-[13px] font-normal leading-5 outline-none focus:border-[var(--brain-accent)]" /></label>
        <div><label className="block text-[11px] font-semibold" htmlFor="support-screenshots">{t("Capturas de pantalla")}<input id="support-screenshots" type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={locked || screenshots.length >= MAX_SCREENSHOTS} className="mt-2 block w-full text-xs" onChange={(event) => { void addScreenshots(Array.from(event.target.files ?? [])); event.target.value = ""; }} /></label><p className="mt-1 text-[10px] text-[var(--text-subtle)]">{t("Hasta 3 capturas de 2 MB. También puedes pegarlas en la descripción.")}</p>
          {screenshots.length ? <ul className="mt-2 space-y-1">{screenshots.map((item, index) => <li key={`${index}-${item.name}`} className="flex items-center gap-2 rounded-lg bg-[var(--surface-hover)] px-3 py-2 text-xs"><span className="min-w-0 flex-1 truncate">{item.name}</span><button type="button" disabled={locked} aria-label={`${t("Quitar captura")} ${index + 1}`} className="touch-target grid size-8 place-items-center rounded-full" onClick={() => setScreenshots((previous) => previous.filter((_, position) => position !== index))}><X size={14} /></button></li>)}</ul> : null}
        </div>
        <p className="text-[10px] leading-4 text-[var(--text-subtle)]">{t("Compartiremos esta descripción, las capturas que adjuntes y la referencia de esta pantalla con soporte. Evita incluir contraseñas u otros datos sensibles.")}</p>
        {sentId ? <p role="status" className="rounded-xl bg-[var(--positive-soft)] px-3 py-2 text-[11px] text-[var(--positive)]">{t("Solicitud recibida. Puedes seguirla en Mis solicitudes.")}</p> : null}
        {error ? <p role="alert" className="rounded-xl bg-[var(--danger-soft)] px-3 py-2 text-[11px] text-[var(--danger)]">{t(error)}</p> : null}
        <div className="flex justify-end"><button type="submit" disabled={locked || !description.trim()} className="touch-target flex min-h-10 items-center gap-2 rounded-full bg-[var(--text)] px-4 text-[11px] font-semibold text-[var(--surface)] disabled:opacity-40">{locked ? <SpinnerGap size={14} className="animate-spin" /> : null}{readingImages ? t("Preparando capturas…") : busy ? t("Guardando…") : t("Enviar")}</button></div>
      </form> : <div className="min-h-0 space-y-4 overflow-y-auto p-5">
        {loadError ? <p className="text-xs text-[var(--text-secondary)]">{t("No hemos podido actualizar tus solicitudes.")} <button type="button" className="underline" onClick={() => void refresh()}>{t("Reintentar")}</button></p> : null}
        {!loaded && !loadError ? <p role="status" className="text-xs">{t("Cargando solicitudes…")}</p> : null}
        {loaded && !requests.length ? <p className="text-xs text-[var(--text-secondary)]">{t("Todavía no has enviado ninguna solicitud.")}</p> : null}
        {selected ? <>
          <button type="button" disabled={busy} className="touch-target text-xs underline" onClick={() => { setSelectedId(null); setReply(""); setError(null); }}>{t("Volver a mis solicitudes")}</button>
          <div className="space-y-2"><p className="text-[11px] font-semibold text-[var(--text-secondary)]">{t(statusLabels[selected.status] ?? "Recibida")}</p><p className="whitespace-pre-wrap break-words text-[13px]">{selected.description}</p>
            {selected.screenshots?.length ? <ul className="space-y-1">{selected.screenshots.map((item) => <li key={item.id}><a className="text-xs underline" href={`/api/support/${encodeURIComponent(selected.id)}/screenshots/${encodeURIComponent(item.id)}`} target="_blank" rel="noopener noreferrer">{item.name}</a></li>)}</ul> : null}
          </div>
          <ol aria-label={t("Conversación de soporte")} className="space-y-3">{selected.messages?.map((message) => <li key={message.id} className={`rounded-xl p-3 ${message.author === "support" ? "bg-[var(--brain-accent-soft)]" : "bg-[var(--surface-hover)]"}`}><p className="mb-1 text-[10px] font-semibold">{message.author === "support" ? t("Soporte") : t("Tú")}</p><p className="whitespace-pre-wrap break-words text-xs leading-5">{message.body}</p></li>)}</ol>
          <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void sendReply(); }}><label htmlFor="support-reply" className="block text-xs font-semibold">{selected.status === "resolved" || selected.status === "declined" ? t("¿Necesitas continuar con esta solicitud?") : t("Añadir información")}<textarea id="support-reply" disabled={busy} value={reply} onChange={(event) => setReply(event.target.value)} maxLength={10_000} rows={3} required className="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-xs outline-none focus:border-[var(--brain-accent)]" /></label>
            {error ? <p role="alert" className="text-xs text-[var(--danger)]">{t(error)}</p> : null}<div className="flex justify-end"><button type="submit" disabled={busy || !reply.trim()} className="touch-target min-h-10 rounded-full bg-[var(--text)] px-4 text-xs text-[var(--surface)] disabled:opacity-40">{busy ? t("Enviando…") : t("Enviar respuesta")}</button></div>
          </form>
        </> : <ul className="space-y-2">{requests.map((request) => <li key={request.id}><button type="button" aria-label={`${t(statusLabels[request.status] ?? "Recibida")}. ${request.description}`} onClick={() => { setSelectedId(request.id); setReply(""); setError(null); }} className="touch-target w-full rounded-xl border border-[var(--border)] p-3 text-left hover:bg-[var(--surface-hover)]"><span className="block text-[10px] font-semibold text-[var(--text-secondary)]">{t(statusLabels[request.status] ?? "Recibida")}</span><span className="mt-1 line-clamp-2 block break-words text-xs">{request.description}</span>{request.messages?.at(-1)?.author === "support" ? <span className="mt-1 block text-[10px] text-[var(--brain-accent-on-soft)]">{t("Respuesta de soporte")}</span> : null}</button></li>)}</ul>}
      </div>}
    </div>
  </div>;
}
