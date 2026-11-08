"use client";
import { G03Connections } from "@/g03-products/connections";
import { g03ProductInstallation } from "@/g03-products/contracts";
import { useUiText } from "@/i18n/provider";
import { CompanyMailConnectionForm } from "@/components/company-mail-connection-form";
import { ConnectorLogo } from "@/components/connector-logo";
import { MailConnectionCard } from "@/components/mail-connection-card";
import { connectorPresentation } from "@/connectors/presentation";

import { Archive, Bell, Brain, PaintBrush, Plugs, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import type { RuntimeStatus } from "@/lib/runtime-status";
import { isSettingsSnapshot, type NotificationSettings, type SettingsPatch, type SettingsSnapshot } from "@/settings/contracts";
import { useModalFocus } from "@/ui/use-modal-focus";
import { OverlayPresenceLayer } from "@/ui/overlay-presence";
import { PersonalLanguage } from "@/components/personal-language";
import { ThemeToggle } from "@/components/ui/primitives";
import { MemoryPanel } from "@/components/memory-panel";
import { STANDALONE_PROJECT_SLUG, type WorkbenchProject, type WorkbenchThread } from "@/workbench/types";

type Props = {
  productName: string;
  open: boolean;
  initialTab?: Tab;
  runtimeStatus: RuntimeStatus;
  projects?: WorkbenchProject[];
  threads?: WorkbenchThread[];
  archiveBusy?: boolean;
  onRestoreProject?: (project: WorkbenchProject) => void;
  onRestoreThread?: (thread: WorkbenchThread) => void;
  onSettingsSnapshot?: (snapshot: SettingsSnapshot) => void;
  activeProjectId?: string | null;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
};
type Tab = "appearance" | "connectors" | "memory" | "notifications" | "archived";

function Toggle({ label, checked, disabled = false, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" aria-label={label} aria-pressed={checked} disabled={disabled} className={`touch-target relative h-5 w-9 rounded-full transition disabled:cursor-not-allowed disabled:opacity-45 ${checked ? "bg-[var(--notification-accent)]" : "bg-[var(--border-strong)]"}`} onClick={() => onChange(!checked)}><span className={`absolute top-1/2 grid size-4 -translate-y-1/2 place-items-center rounded-full bg-[var(--surface-raised)] shadow-sm transition-transform ${checked ? "translate-x-[18px]" : "translate-x-0.5"}`} /></button>;
}

/** Employee preferences only. Workspace governance is server-protected at /admin. */
export function CustomizationPanel({ productName, open, initialTab = "appearance", projects = [], threads = [], archiveBusy = false, onRestoreProject, onRestoreThread, onSettingsSnapshot, activeProjectId = null, returnFocusRef, onClose }: Props) {
  const t = useUiText();
  const panelRef = useModalFocus(open, onClose, undefined, returnFocusRef);
  const [navigation, setNavigation] = useState({ open, initialTab, tab: initialTab });
  // A deep link can arrive after hydration; apply each new opening without resetting tab clicks.
  if (navigation.open !== open || navigation.initialTab !== initialTab) {
    setNavigation({ open, initialTab, tab: open ? initialTab : navigation.tab });
  }
  const tab = navigation.tab;
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Partial<Record<Tab, HTMLDivElement>>>({});
  const scrollTarget = useRef<Tab>(initialTab);
  const setTab = (next: Tab) => setNavigation(current => current.tab === next ? current : ({ ...current, tab: next }));
  const scrollToSection = (next: Tab, behavior: ScrollBehavior = "smooth") => {
    const container = scrollRef.current;
    const section = sectionRefs.current[next];
    if (!container || !section) return;
    scrollTarget.current = next;
    setTab(next);
    const top = container.scrollTop + section.getBoundingClientRect().top - container.getBoundingClientRect().top - 24;
    container.scrollTo({ top: Math.max(0, top), behavior });
  };
  const trackSection = () => {
    const container = scrollRef.current;
    if (!container || !container.clientHeight) return;
    const top = container.getBoundingClientRect().top + 40;
    let current: Tab = "appearance";
    for (const id of ["appearance", "connectors", "memory", "notifications", "archived"] as const) {
      if ((sectionRefs.current[id]?.getBoundingClientRect().top ?? Infinity) <= top) current = id;
    }
    scrollTarget.current = current;
    setTab(current);
  };
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useLayoutEffect(() => { scrollTarget.current = initialTab; }, [open, initialTab]);
  useLayoutEffect(() => {
    if (!open) return;
    const container = scrollRef.current;
    const section = sectionRefs.current[scrollTarget.current];
    if (container && section) container.scrollTop = Math.max(0, container.scrollTop + section.getBoundingClientRect().top - container.getBoundingClientRect().top - 24);
  }, [open, initialTab, loading]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetch("/api/settings", { cache: "no-store" }).then(async (response) => response.ok ? response.json() as Promise<unknown> : null).then((snapshot) => {
      if (cancelled) return;
      if (!isSettingsSnapshot(snapshot)) { setError(t("No se ha podido cargar la configuración.")); return; }
      setSettings(snapshot); onSettingsSnapshot?.(snapshot);
    }).catch(() => { if (!cancelled) setError(t("No se ha podido cargar la configuración.")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [loadAttempt, onSettingsSnapshot, open, t]);

  const save = async (patch: SettingsPatch, key: string) => {
    setSavingKey(key); setError(null);
    try {
      const response = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok || !isSettingsSnapshot(result)) {
        const message = result && typeof result === "object" && "error" in result && typeof result.error === "string" ? result.error : t("No se ha podido guardar el cambio.");
        throw new Error(message);
      }
      setSettings(result); onSettingsSnapshot?.(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("No se ha podido guardar el cambio.")); }
    finally { setSavingKey(null); }
  };

  const retryLoad = () => {
    setLoading(true);
    setError(null);
    setLoadAttempt((current) => current + 1);
  };
  const tabs: Array<{ id: Tab; label: string; icon: ReactNode }> = [
    { id: "appearance", label: t("Apariencia"), icon: <PaintBrush size={17} /> },
    { id: "connectors", label: t("Conectores"), icon: <Plugs size={17} /> },
    { id: "memory", label: t("Memoria"), icon: <Brain size={17} /> },
    { id: "notifications", label: t("Avisos"), icon: <Bell size={17} /> },
    { id: "archived", label: t("Archivados"), icon: <Archive size={17} /> },
  ];
  return <AnimatePresence initial={false}>{open ? (
    <OverlayPresenceLayer key="customization-panel" origin="center" className="workspace-overlay fixed inset-0 z-50 grid place-items-center p-0 md:p-6">
      {(surfaceMotion) => <>
        <button className="absolute inset-0" aria-label={t("Cerrar configuración")} onClick={onClose} />
        <motion.section {...surfaceMotion} ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("Configuración de {p0}", { p0: productName })} className="workspace-panel relative flex h-full w-full max-w-[840px] flex-col overflow-hidden border border-[var(--border)] bg-[var(--surface-raised)] shadow-[var(--shadow-lg)] md:h-[min(680px,calc(100dvh-3rem))] md:rounded-[22px]">
          <header className="workspace-panel-header flex shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-5"><div><h2 className="workspace-panel-title">{t("Configuración")}</h2><p className="workspace-panel-subtitle mt-0.5 hidden sm:block">{t("Tu apariencia, conexiones, avisos y elementos archivados.")}</p></div><button type="button" aria-label={t("Cerrar")} className="grid size-10 place-items-center rounded-full text-[var(--text-subtle)] hover:bg-[var(--surface-hover)]" onClick={onClose}><X size={17} /></button></header>
          <div className="flex min-h-0 flex-1 flex-col md:flex-row"><nav aria-label={t("Secciones de configuración")} className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border-subtle)] p-2 md:w-52 md:flex-col md:border-b-0 md:border-r md:p-3">{tabs.map((item) => <button key={item.id} type="button" aria-current={tab === item.id ? "location" : undefined} aria-controls={`settings-section-${item.id}`} className={`flex min-h-10 shrink-0 items-center gap-2.5 rounded-[12px] px-3 text-left text-[12px] font-medium ${tab === item.id ? "bg-[var(--surface-selected)] text-[var(--text)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"}`} onClick={() => scrollToSection(item.id, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth")}>{item.icon}{item.label}</button>)}</nav>
            <div ref={scrollRef} onScroll={trackSection} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-6 md:px-8">{error ? <div className="mb-5 flex items-center justify-between gap-3 rounded-[12px] border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-[11px] text-[var(--danger)]"><p role="alert">{t(error)}</p>{!settings ? <button type="button" className="shrink-0 rounded-lg border border-current px-3 py-2 font-semibold hover:bg-[var(--surface-hover)]" onClick={retryLoad}>{t("Reintentar")}</button> : null}</div> : null}{loading && !settings ? <p className="text-[12px] text-[var(--text-subtle)]">{t("Cargando configuración…")}</p> : null}{tabs.map(item => <div key={item.id} id={`settings-section-${item.id}`} ref={node => { if (node) sectionRefs.current[item.id] = node; else delete sectionRefs.current[item.id]; }} role="region" aria-label={item.label} className="scroll-mt-6 border-b border-[var(--border-subtle)] py-7 first:pt-0 last:min-h-full last:border-0">
              {item.id === "appearance" ? <><Appearance /><PersonalLanguage /></> : null}
              {item.id === "connectors" ? <Connectors projectId={activeProjectId} settings={settings} onChanged={retryLoad} /> : null}
              {item.id === "memory" ? <MemorySettings productName={productName} settings={settings} projectId={activeProjectId} /> : null}
              {item.id === "notifications" ? <Notifications settings={settings} busy={savingKey === "notifications"} onSave={save} /> : null}
              {item.id === "archived" ? <Archived projects={projects} threads={threads} busy={archiveBusy} onRestoreProject={onRestoreProject} onRestoreThread={onRestoreThread} /> : null}
            </div>)}</div>
          </div>
        </motion.section>
      </>}
    </OverlayPresenceLayer>
  ) : null}</AnimatePresence>;
}

function Appearance() {
  const t = useUiText(); return <section><SectionTitle>{t("Tema")}</SectionTitle><div className="flex items-center justify-between rounded-[var(--brain-radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3"><div><p className="text-[12px] font-semibold">{t("Claro u oscuro")}</p><p className="mt-1 text-[11px] text-[var(--text-subtle)]">{t("Se guarda en este navegador.")}</p></div><ThemeToggle /></div></section>; }
const subscribeConnectorCallback = () => () => undefined;
function requestedMailConnection() { return new URLSearchParams(window.location.search).get("connect") === "company-mail"; }
function connectorCallbackStatus() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("connection") === "failed" || [params.get("gmail"), params.get("outlook"), params.get("shopify"), params.get("shopify_themes")].some(status => status === "failed" || status === "denied")) return "failed";
  return params.get("connection") === "verified" || [params.get("shopify"), params.get("shopify_themes")].includes("connected") ? "returned" : "none";
}
function Connectors({ settings, projectId, onChanged }: { settings: SettingsSnapshot | null; projectId: string | null; onChanged: () => void }) {
  const t = useUiText();
  const requestedMail = useSyncExternalStore(subscribeConnectorCallback, requestedMailConnection, () => false);
  const [mailFormOpen, setMailFormOpen] = useState<boolean | null>(null);
  const callbackStatus = useSyncExternalStore(subscribeConnectorCallback, connectorCallbackStatus, () => "none");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const disconnect = async (url: string) => { setBusy(true); setError(null); try { const response = await fetch(url, { method: "POST" }); const body: unknown = await response.json().catch(() => null); if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : t("No se ha podido desconectar.")); if (body && typeof body === "object" && "providerRevoked" in body && body.providerRevoked === false) setError(t("Acceso local desconectado. La revocación en el proveedor sigue pendiente; reintenta Desconectar.")); onChanged(); } catch (cause) { setError(cause instanceof Error ? cause.message : t("No se ha podido desconectar.")); } finally { setBusy(false); } };
  const [query, setQuery] = useState("");
  const matches = settings?.connectors.filter(c => `${c.label} ${t(connectorPresentation(c.id).description)}`.toLocaleLowerCase("es").includes(query.toLocaleLowerCase("es"))) ?? [];
  const connected = matches.filter(c => c.status === "connected");
  const available = matches.filter(c => c.status !== "connected");
  const row = (connector: NonNullable<SettingsSnapshot>["connectors"][number]) => connector.connectionMethod === "password"
    ? <MailConnectionCard key={connector.id} connector={connector} accountEmail={settings!.account.email} onChanged={onChanged} />
    : <article key={connector.id} className="flex min-h-20 items-center gap-3 border-b border-[var(--border-subtle)] px-3 py-3 last:border-0">
    <ConnectorLogo id={connector.id} size={28} />
    <div className="min-w-0 flex-1"><p className="text-[13px] font-medium">{connector.label}</p><p className="mt-1 text-[11px] leading-4 text-[var(--text-subtle)]">{t(connectorPresentation(connector.id).description)}</p>{connector.status !== "connected" && connector.statusDetail ? <p className="mt-1 text-[11px] text-[var(--text-subtle)]">{t(connector.statusDetail)}</p> : null}{connector.accountEmail ? <p className="mt-1 truncate text-[11px] text-[var(--text-subtle)]">{connector.accountEmail}</p> : null}</div>
    <div className="flex shrink-0 flex-col items-end gap-2">
      {connector.status === "connected" ? <span className="text-[11px] font-medium text-[var(--positive)]">{t("Conectado")}</span> : connector.connectUrl ? connector.id === "company-mail" ? <button type="button" onClick={() => setMailFormOpen(true)} aria-label={t("Conectar {p0}", { p0: connector.label })} className="rounded-full bg-[var(--brain-accent)] px-4 py-2 text-[11px] font-semibold text-[var(--brain-contrast)]">{t("Conectar")}</button> : <a aria-label={t("Conectar {p0}", { p0: connector.label })} href={connector.connectUrl} className="rounded-full bg-[var(--brain-accent)] px-4 py-2 text-[11px] font-semibold text-[var(--brain-contrast)]">{t("Conectar")}</a> : <span className="text-[11px] text-[var(--text-subtle)]">{connector.status === "admin_setup_required" ? t("Falta configuración") : t("No disponible")}</span>}
      {connector.disconnectUrl ? <button type="button" disabled={busy} aria-label={t("Desconectar {p0}", { p0: connector.label })} onClick={() => void disconnect(connector.disconnectUrl!)} className="text-[10px] text-[var(--text-subtle)] underline underline-offset-2 disabled:opacity-50">{t("Desconectar")}</button> : null}
      {connector.status === "connected" && connector.connectUrl ? connector.id === "company-mail" ? <button type="button" onClick={() => setMailFormOpen(true)} aria-label={t("Reconectar {p0}", { p0: connector.label })} className="text-[10px] text-[var(--text-subtle)]">{t("Reconectar")}</button> : <a href={connector.connectUrl} aria-label={t("Reconectar {p0}", { p0: connector.label })} className="text-[10px] text-[var(--text-subtle)]">{t("Reconectar")}</a> : null}
    </div>
  </article>;
  const website = settings?.connectors.find(connector => connector.id === "shopify-themes");
  return <section>{settings && g03ProductInstallation(settings.company.installationId) && <G03Connections projectId={projectId}/>}<SectionTitle>{t("Conectores personales")}</SectionTitle>
    {website ? <div className="mb-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" role="note"><p className="text-[13px] font-semibold">{t("Edita tu web desde el MODTIME AI")}</p><p className="mt-2 text-[12px] leading-5 text-[var(--text-muted)]">{t("Estás en la configuración del MODTIME AI. Conectores está aquí, no en la configuración de Shopify ni en Sidekick.")}</p><p className="mt-2 text-[12px] leading-5 text-[var(--text-muted)]">{website.status === "connected" ? t("Pide el cambio en el chat: textos, vídeo, imágenes, diseño u opciones del configurador. Shopify Website se usa automáticamente. Después abre Preview para verlo. El borrador no se publica automáticamente.") : t("Pulsa Conectar en Shopify Website · MODTIME abajo. En la pantalla de Shopify, usa tu cuenta de propietario de MODTIME e instala MODTIME Website Editor. Después vuelve al MODTIME AI y pide el cambio en el chat.")}</p></div> : null}
    {callbackStatus === "failed" ? <p role="alert" className="mb-3 text-xs text-[var(--danger)]">{t("No se completó la conexión. Vuelve a intentarlo.")}</p> : callbackStatus === "returned" ? <p role="status" className="mb-3 text-xs text-[var(--text-subtle)]">{t("Consulta abajo el estado verificado de tus conexiones.")}</p> : null}
    <p className="mb-4 text-[12px] leading-5 text-[var(--text-muted)]">{t("Conecta tus apps y úsalas directamente en el chat. El asistente elige la conexión adecuada sin que tengas que seleccionarla. Las cuentas personales son privadas.")}</p>
    <input type="search" aria-label={t("Buscar apps")} placeholder={t("Buscar apps…")} value={query} onChange={event => setQuery(event.target.value)} className="mb-5 min-h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[16px] outline-none focus:border-[var(--focus)] md:text-[13px]" />
    {(mailFormOpen ?? requestedMail) && settings?.connectors.some(c => c.id === "company-mail" && c.connectUrl) ? <CompanyMailConnectionForm onCancel={() => setMailFormOpen(false)} onConnected={() => { setMailFormOpen(false); onChanged(); }} /> : null}
    {connected.length ? <><h4 className="mb-2 text-[12px] font-semibold">{t("Conectadas")}</h4><div className="mb-5 overflow-hidden rounded-xl border border-[var(--border)]">{connected.map(row)}</div></> : null}
    {connected.length && available.length ? <hr className="my-6 border-[var(--border-subtle)]" /> : null}
    {available.length ? <><h4 className="mb-2 text-[12px] font-semibold">{t("Apps disponibles")}</h4><div className="overflow-hidden rounded-xl border border-[var(--border)]">{available.map(row)}</div></> : null}
    {settings && !matches.length ? <p className="text-[12px] text-[var(--text-subtle)]">{query ? t("No hay apps autorizadas que coincidan.") : t("No hay conexiones habilitadas para tu usuario.")}</p> : null}
    <p className="mt-4 text-[11px] leading-4 text-[var(--text-subtle)]">{t("Solo verás las apps autorizadas para tu cuenta.")}</p>
    {error ? <p role="alert" className="mt-3 text-[11px] text-[var(--danger)]">{t(error)}</p> : null}
  </section>;
}
function MemorySettings({ productName, settings, projectId }: { productName: string; settings: SettingsSnapshot | null; projectId: string | null }) {
  const t = useUiText(); return <section><SectionTitle>{t("Memoria de trabajo")}</SectionTitle><div className="mb-5 rounded-[16px] border border-[var(--border)] bg-[var(--surface)] p-4"><p className="text-[12px] font-semibold">{t("Automática y activa en tu entorno privado")}</p><p className="mt-2 text-[11px] leading-5 text-[var(--text-subtle)]">{t("Al terminar un turno,")}{" "}{productName} {" "}{t("guarda en segundo plano solo preferencias, hechos estables y decisiones útiles. No añade espera a la respuesta.")}</p><ul className="mt-3 space-y-1 text-[10px] text-[var(--text-subtle)]"><li>{t("Privacidad: almacenamiento y runtime separados por empleado.")}</li><li>{t("Seguridad: secretos, credenciales e instrucciones efímeras se descartan.")}</li><li>{t("Control: cada recuerdo conserva procedencia y revisión, y se puede corregir o eliminar.")}</li></ul></div>{settings?.memory.enabled ? <MemoryPanel open embedded productName={productName} projectId={projectId} onClose={() => undefined} /> : null}</section>; }
function Notifications({ settings, busy, onSave }: { settings: SettingsSnapshot | null; busy: boolean; onSave: (patch: SettingsPatch, key: string) => Promise<void> }) {
  const t = useUiText(); return <section><SectionTitle>{t("Avisos de trabajo")}</SectionTitle><p className="mb-4 text-[12px] leading-5 text-[var(--text-muted)]">{t("Controla los avisos de esta aplicación. No se solicita permiso del sistema operativo desde esta pantalla.")}</p><div className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]"><NotificationToggle field="backgroundTurns" title={t("Tareas terminadas")} description={t("Avisa cuando una conversación termina mientras trabajas en otra.")} settings={settings} busy={busy} onSave={onSave} /><NotificationToggle field="approvals" title={t("Aprobaciones pendientes")} description={t("Avisa cuando una acción necesita tu decisión.")} settings={settings} busy={busy} onSave={onSave} /><NotificationToggle field="failures" title={t("Errores y bloqueos")} description={t("Avisa cuando una tarea requiere atención.")} settings={settings} busy={busy} onSave={onSave} /><NotificationToggle field="sound" title={t("Sonido")} description={t("Reproduce un sonido discreto para avisos dentro de la aplicación.")} settings={settings} busy={busy} onSave={onSave} /></div></section>; }
function Archived({ projects, threads, busy, onRestoreProject, onRestoreThread }: { projects: WorkbenchProject[]; threads: WorkbenchThread[]; busy: boolean; onRestoreProject?: (project: WorkbenchProject) => void; onRestoreThread?: (thread: WorkbenchThread) => void }) {
  const t = useUiText();
  const archivedProjects = projects.filter((project) => project.status === "archived" && project.slug !== STANDALONE_PROJECT_SLUG);
  const archivedThreads = threads.filter((thread) => thread.status === "archived");
  const archivedProjectIds = new Set(archivedProjects.map((project) => project.id));
  if (!archivedProjects.length && !archivedThreads.length) return <section><SectionTitle>{t("Archivados")}</SectionTitle><div className="rounded-[16px] border border-dashed border-[var(--border)] px-5 py-8 text-center"><p className="text-[12px] font-semibold text-[var(--text)]">{t("No hay elementos archivados")}</p><p className="mt-1 text-[11px] text-[var(--text-subtle)]">{t("Las conversaciones y proyectos archivados aparecerán únicamente aquí.")}</p></div></section>;
  return <section><SectionTitle>{t("Archivados")}</SectionTitle><p className="mb-5 text-[12px] leading-5 text-[var(--text-muted)]">{t("Restaura desde aquí las conversaciones y proyectos que quieras devolver al sidebar.")}</p>{archivedProjects.length ? <div className="mb-6"><h4 className="mb-2 text-[11px] font-semibold text-[var(--text-secondary)]">{t("Proyectos")}</h4><div className="divide-y divide-[var(--border-subtle)] rounded-[14px] border border-[var(--border)]">{archivedProjects.map((project) => <div key={project.id} className="flex items-center gap-3 px-4 py-3"><Archive size={15} className="shrink-0 text-[var(--text-subtle)]" /><span className="min-w-0 flex-1 truncate text-[12px] font-medium">{project.name}</span><button type="button" disabled={busy || !onRestoreProject} className="rounded-lg border border-[var(--border)] px-3 py-2 text-[11px] font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-45" onClick={() => onRestoreProject?.(project)}>{t("Restaurar")}</button></div>)}</div></div> : null}{archivedThreads.length ? <div><h4 className="mb-2 text-[11px] font-semibold text-[var(--text-secondary)]">{t("Conversaciones")}</h4><div className="divide-y divide-[var(--border-subtle)] rounded-[14px] border border-[var(--border)]">{archivedThreads.map((thread) => { const parent = projects.find((project) => project.id === thread.projectId); const parentArchived = archivedProjectIds.has(thread.projectId); return <div key={thread.id} className="flex items-center gap-3 px-4 py-3"><Archive size={15} className="shrink-0 text-[var(--text-subtle)]" /><span className="min-w-0 flex-1"><span className="block truncate text-[12px] font-medium">{thread.title}</span>{parent ? <span className="mt-0.5 block truncate text-[10px] text-[var(--text-subtle)]">{parent.name}</span> : null}</span><button type="button" disabled={busy || parentArchived || !onRestoreThread} title={parentArchived ? t("Restaura primero el proyecto") : undefined} className="rounded-lg border border-[var(--border)] px-3 py-2 text-[11px] font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-45" onClick={() => onRestoreThread?.(thread)}>{t("Restaurar")}</button></div>; })}</div></div> : null}</section>;
}
function NotificationToggle({ field, title, description, settings, busy, onSave }: { field: keyof NotificationSettings; title: string; description: string; settings: SettingsSnapshot | null; busy: boolean; onSave: (patch: SettingsPatch, key: string) => Promise<void> }) { const checked = settings?.notifications[field] ?? false; return <div className="flex items-center gap-4 py-3.5"><div className="min-w-0 flex-1"><p className="text-[12px] font-semibold">{title}</p><p className="mt-1 text-[11px] leading-4 text-[var(--text-subtle)]">{description}</p></div><Toggle label={title} checked={checked} disabled={!settings || busy} onChange={(value) => void onSave({ target: "notifications", values: { [field]: value } }, "notifications")} /></div>; }
function SectionTitle({ children }: { children: ReactNode }) { return <h3 className="mb-4 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-subtle)]">{children}</h3>; }
