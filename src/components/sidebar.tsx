"use client";
import { g03ProductInstallation } from "@/g03-products/contracts";
import { translate } from "@/i18n/messages";
import { useUiLocale } from "@/i18n/provider";
import { useUiText } from "@/i18n/provider";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  Airplane,
  CurrencyEur,
  Archive,
  CalendarBlank,
  Factory,
  Package,
  AppWindow,
  CaretDown,
  CaretRight,
  ChatCircleDots,
  CheckCircle,
  DotsThree,
  Folder,
  FolderOpen,
  GearSix,
  MagnifyingGlass,
  NotePencil,
  Plus,
  PushPin,
  Question,
  SidebarSimple,
  SignOut,
  SpinnerGap,
  WarningCircle,
  X,
  Trash,
} from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import styles from "./sidebar.module.css";
import { useSidebarDisclosure } from "./use-sidebar-disclosure";
import type { AuthSession } from "@/auth/types";
import { BrandMark } from "@/components/ui/primitives";
import { UserAvatar } from "@/components/user-avatar";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import type { PublicInstallationBranding } from "@/config/installation-branding";
import {
  STANDALONE_PROJECT_SLUG,
  workbenchProjectAccess,
  workbenchThreadAccess,
  type WorkbenchProject,
  type WorkbenchThread,
} from "@/workbench/types";
import { useModalFocus } from "@/ui/use-modal-focus";
import { useMenuKeyboardNavigation } from "@/ui/use-menu-keyboard-navigation";
import type { ThreadActivity } from "@/workbench/thread-activity";
import { canAccessInsiJetsCMS } from "@/insijets/cms-access";
import { SupportDialog } from "@/components/support-dialog";
import { SupportInboxNotice } from "@/components/support-inbox-notice";

export type ProjectMenuAction = "settings" | "rename" | "pin" | "unpin" | "archive" | "restore";
export type ThreadMenuAction = "rename" | "pin" | "unpin" | "archive" | "restore" | "remove";

type SidebarProps = {
  branding: Readonly<PublicInstallationBranding>;
  session: AuthSession;
  projects: WorkbenchProject[];
  threads: WorkbenchThread[];
  activeProjectId: string | null;
  activeThreadId: string | null;
  mobileOpen: boolean;
  mobileInitialFocusRef?: RefObject<HTMLElement | null>;
  mobileReturnFocusRef?: RefObject<HTMLElement | null>;
  desktopOpen: boolean;
  busy: boolean;
  threadActivityById: Record<string, ThreadActivity>;
  onCloseMobile: () => void;
  onCloseDesktop: () => void;
  onOpenDesktop: () => void;
  onOpenCommandPalette: (returnFocus?: HTMLElement | null) => void;
  onOpenAutomations: () => void;
  onOpenProduction?: () => void;
  onOpenApps?: () => void;
  onOpenReception?: () => void;
  productView?: "production" | "apps" | "reception" | null;
  insijetsWorkspaceAccess?: boolean;
  insijetsSourcingAccess?: boolean;
  insijetsOutreachAccess?: boolean;
  onOpenCMS?: () => void;
  onOpenPriceIndex?: () => void;
  onOpenDirectory?: () => void;
  onOpenOutreach?: () => void;
  onSelectProject: (id: string) => void;
  onSelectThread: (id: string) => void;
  onNewThread: (projectId?: string) => void;
  onNewProject: (returnFocus?: HTMLElement | null) => void;
  onProjectAction: (project: WorkbenchProject, action: ProjectMenuAction, returnFocus?: HTMLElement | null) => void;
  onThreadAction: (thread: WorkbenchThread, action: ThreadMenuAction, returnFocus?: HTMLElement | null) => void;
  onOpenCustomization: (returnFocus: HTMLElement | null, initialTab?: "appearance" | "archived") => void;
};

const threadStateCopy: Record<ThreadActivity["state"], string> = {
  idle: "Sin actividad pendiente",
  running: "Trabajando",
  needs_attention: "Necesita tu atención",
  completed: "Trabajo completado",
  failed: "La ejecución ha fallado",
};

function ThreadActivitySignal({ activity }: { activity: ThreadActivity | undefined }) {
  const t = useUiText();
  if (!activity || (activity.state === "idle" && activity.unreadCount === 0)) return null;
  const label = t(threadStateCopy[activity.state]);
  return (
    <span className="flex shrink-0 items-center gap-1" title={label}>
      {activity.unreadCount > 0 ? <span aria-label={t("Hay actualizaciones sin leer")} className="size-2 rounded-full bg-[var(--notification-accent)]" /> : null}
      <span aria-label={label} className={`grid size-4 place-items-center rounded-full ${
        activity.state === "needs_attention" || activity.state === "failed"
          ? "text-[var(--danger)]"
          : activity.state === "completed"
            ? "text-[var(--text-secondary)]"
            : "text-[var(--text-subtle)]"
      }`}>
        {activity.state === "running" ? <SpinnerGap size={13} className="motion-safe:animate-spin" /> : null}
        {activity.state === "needs_attention" || activity.state === "failed" ? <WarningCircle size={13} weight="fill" /> : null}
        {activity.state === "completed" ? <CheckCircle size={13} weight="fill" /> : null}
      </span>
    </span>
  );
}

function ProjectActivitySignal({ activities }: { activities: ThreadActivity[] }) {
  const t = useUiText();
  const running = activities.filter((activity) => activity.state === "running").length;
  const attention = activities.filter((activity) => activity.state === "needs_attention" || activity.state === "failed").length;
  const unread = activities.reduce((total, activity) => total + activity.unreadCount, 0);
  if (!running && !attention && !unread) return null;
  const label = attention
    ? t("{p0} {p1} atención", { p0: attention, p1: attention === 1 ? t("conversación necesita") : t("conversaciones necesitan") })
    : running
      ? `${running} ${running === 1 ? t("conversación trabajando") : "conversaciones trabajando"}`
      : `${unread} ${unread === 1 ? t("actualización sin leer") : t("actualizaciones sin leer")}`;
  return (
    <span aria-label={label} title={label} className="flex shrink-0 items-center gap-1 text-[var(--text-subtle)]">
      {attention ? <WarningCircle size={12} weight="fill" className="text-[var(--danger)]" /> : null}
      {!attention && running ? <SpinnerGap size={12} className="motion-safe:animate-spin" /> : null}
      {unread ? <span className="size-2 rounded-full bg-[var(--notification-accent)]" aria-label={t("Hay actualizaciones sin leer")} /> : null}
    </span>
  );
}

function relativeDate(date: string, locale: "en" | "es" | "ca" = "es") {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return "";
  const difference = Date.now() - parsed.getTime();
  if (difference < 86_400_000) return translate(locale, "Hoy");
  if (difference < 172_800_000) return translate(locale, "Ayer");
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(parsed);
}

function byPriority<Item extends { pinned: boolean; updatedAt: string }>(a: Item, b: Item) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return b.updatedAt.localeCompare(a.updatedAt);
}

function MenuButton({ icon, label, danger = false, onClick }: {
  icon: ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      tabIndex={-1}
      className={`touch-target flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-medium transition hover:bg-[var(--surface-hover)] ${danger ? "text-[var(--danger)]" : "text-[var(--text-secondary)]"}`}
      onClick={onClick}
    >
      {icon}{label}
    </button>
  );
}

function ItemActions({ kind, item, canEdit = true, canManage = true, canPin = canManage, canArchive = canManage, onAction, onClose, onNewThread }: {
  onNewThread?: () => void;
  kind: "project" | "thread";
  item: WorkbenchProject | WorkbenchThread;
  canEdit?: boolean;
  canManage?: boolean;
  canPin?: boolean;
  canArchive?: boolean;
  onAction: (action: ProjectMenuAction | ThreadMenuAction, returnFocus: HTMLElement | null) => void;
  onClose: () => void;
}) {
  const t = useUiText();
  const menuRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(true);
  const onMenuKeyDown = useMenuKeyboardNavigation(onClose);

  useEffect(() => {
    restoreFocusRef.current = true;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        restoreFocusRef.current = false;
        onClose();
      }
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      if (restoreFocusRef.current && returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, [onClose]);

  const itemLabel = "name" in item ? item.name : item.title;
  return (
    <div id={`sidebar-${kind}-actions-${item.id}`} ref={menuRef} role="menu" aria-label={t("Acciones de {p0}", { p0: itemLabel })} className={`${styles.contextMenu} menu-enter absolute right-1 top-8 z-50 w-56 origin-top-right rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-1.5 shadow-[var(--shadow-popover)]`} onKeyDown={onMenuKeyDown}>
      {item.status === "active" ? (
        <>
          {kind === "project" && canEdit && onNewThread ? <MenuButton icon={<Plus size={14} />} label={t("Nueva conversación en {p0}", { p0: itemLabel })} onClick={onNewThread} /> : null}
          {kind === "project" ? <MenuButton icon={<GearSix size={14} />} label={t("Ajustes del proyecto")} onClick={() => onAction("settings", returnFocusRef.current)} /> : null}
          {canEdit ? <MenuButton icon={<NotePencil size={14} />} label={t("Renombrar")} onClick={() => onAction("rename", returnFocusRef.current)} /> : null}
          {canPin ? <MenuButton icon={<PushPin size={14} />} label={item.pinned ? t("Desfijar") : t("Fijar")} onClick={() => onAction(item.pinned ? "unpin" : "pin", returnFocusRef.current)} /> : null}
          {kind === "thread" && canArchive ? <MenuButton danger icon={<Trash size={14} />} label={t("Eliminar de la lista")} onClick={() => onAction("remove", returnFocusRef.current)} /> : null}
          {canArchive ? <MenuButton danger icon={<Archive size={14} />} label={t("Archivar")} onClick={() => onAction("archive", returnFocusRef.current)} /> : null}
        </>
      ) : (
        canManage ? <MenuButton icon={kind === "project" ? <FolderOpen size={14} /> : <ChatCircleDots size={14} />} label={t("Restaurar")} onClick={() => onAction("restore", returnFocusRef.current)} /> : null
      )}
    </div>
  );
}

export function Sidebar({
  branding,
  session,
  projects,
  threads,
  activeProjectId,
  activeThreadId,
  mobileOpen,
  mobileInitialFocusRef,
  mobileReturnFocusRef,
  desktopOpen,
  busy,
  threadActivityById,
  onCloseMobile,
  onCloseDesktop,
  onOpenDesktop,
  onOpenCommandPalette,
  onOpenAutomations,
  onOpenProduction,
  onOpenApps,
  onOpenReception,
  productView,
  insijetsWorkspaceAccess = false,
  insijetsSourcingAccess = false,
  insijetsOutreachAccess = false,
  onOpenPriceIndex,
  onOpenDirectory,
  onOpenOutreach,
  onSelectProject,
  onSelectThread,
  onNewThread,
  onNewProject,
  onProjectAction,
  onThreadAction,
  onOpenCustomization,
}: SidebarProps) {
  const locale = useUiLocale();
  const canOpenInsiJetsWorkspace = insijetsWorkspaceAccess && canAccessInsiJetsCMS(session, branding.installationId);
  const t = useUiText();
  const router = useRouter();
  const profileButtonRef = useRef<HTMLButtonElement>(null);
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null);
  const [threadMenuId, setThreadMenuId] = useState<string | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpView, setHelpView] = useState<"new" | "history">("new");
  const openSupportInbox = useCallback(() => { setHelpView("history"); setHelpOpen(true); }, []);
  const disclosure = useSidebarDisclosure(`${branding.installationId}:${session.tenant.id}:${session.user.id}`);
  const pinnedOpen = disclosure.isOpen("pinned", true);
  const chatsOpen = disclosure.isOpen("chats", true);
  const projectsOpen = disclosure.isOpen("projects", true);
  const [recentLimit, setRecentLimit] = useState(8);
  const [projectThreadLimits, setProjectThreadLimits] = useState<Record<string, number>>({});
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const railOpenButtonRef = useRef<HTMLButtonElement>(null);
  const desktopCloseButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useModalFocus(mobileOpen, onCloseMobile, mobileInitialFocusRef, mobileReturnFocusRef);
  const activeProjects = useMemo(
    () => projects.filter((project) =>
      project.status === "active" && project.slug !== STANDALONE_PROJECT_SLUG).sort(byPriority),
    [projects],
  );
  const standaloneProject = projects.find((project) =>
    project.slug === STANDALONE_PROJECT_SLUG && project.status === "active") ?? null;
  const standaloneThreads = useMemo(
    () => standaloneProject
      ? threads.filter((thread) => thread.projectId === standaloneProject.id).sort(byPriority)
      : [],
    [standaloneProject, threads],
  );
  const activeProjectIds = useMemo(
    () => new Set(projects.filter((project) => project.status === "active").map((project) => project.id)),
    [projects],
  );
  const pinnedThreads = useMemo(
    () => threads.filter((thread) => thread.status === "active" && thread.pinned && activeProjectIds.has(thread.projectId)),
    [activeProjectIds, threads],
  );
  const activeStandaloneThreads = standaloneThreads.filter((thread) => thread.status === "active" && !thread.pinned);
  const visibleStandaloneThreads = activeStandaloneThreads.filter((thread, index) =>
    index < recentLimit || thread.id === activeThreadId ||
    ["running", "needs_attention", "failed"].includes(threadActivityById[thread.id]?.state ?? "idle") ||
    Boolean(threadActivityById[thread.id]?.unreadCount));
  const contextMenuOpen = Boolean(projectMenuId || threadMenuId || profileMenuOpen);
  const closeProfileMenuAndRestore = useCallback(() => {
    setProfileMenuOpen(false);
    setHelpOpen(false);
    requestAnimationFrame(() => profileButtonRef.current?.focus());
  }, []);
  const onProfileMenuKeyDown = useMenuKeyboardNavigation(closeProfileMenuAndRestore);
  const closeMenus = useCallback(() => {
    setProjectMenuId(null);
    setThreadMenuId(null);
    setProfileMenuOpen(false);
    setHelpOpen(false);
  }, []);

  useEffect(() => {
    if (!profileMenuOpen) return;
    const focusFrame = requestAnimationFrame(() => {
      profileMenuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
    });
    const closeProfileMenu = (event: PointerEvent) => {
      if (profileMenuRef.current?.contains(event.target as Node)) return;
      setProfileMenuOpen(false);
      setHelpOpen(false);
    };
    document.addEventListener("pointerdown", closeProfileMenu);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeProfileMenu);
    };
  }, [profileMenuOpen]);
  const selectProject = (id: string) => {
    closeMenus();
    onSelectProject(id);
    onCloseMobile();
  };
  const selectThread = (id: string) => {
    closeMenus();
    onSelectThread(id);
    onCloseMobile();
  };

  return (
    <>
      {mobileOpen ? <button aria-label={t("Cerrar barra lateral")} className="fixed inset-0 z-30 bg-black/25 backdrop-blur-[2px] md:hidden" onClick={onCloseMobile} /> : null}
      <aside
        ref={sidebarRef}
        tabIndex={mobileOpen ? -1 : undefined}
        aria-modal={mobileOpen ? "true" : undefined}
        role={mobileOpen ? "dialog" : undefined}
        aria-label={mobileOpen ? t("Navegación") : undefined}
        data-testid="workbench-sidebar"
        data-sidebar-root=""
        data-desktop-state={desktopOpen ? "expanded" : "collapsed"}
        data-context-menu-open={contextMenuOpen ? "true" : "false"}
        className={`${styles.panel} fixed inset-y-0 left-0 z-40 flex w-[min(280px,88vw)] flex-col overflow-hidden bg-[var(--sidebar)] pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] transition-[transform,visibility] duration-200 md:relative md:inset-auto md:flex md:translate-x-0 md:pb-0 md:pt-0 md:transition-[width] ${desktopOpen ? "md:w-[var(--sidebar-width,280px)]" : "md:w-[52px]"} ${mobileOpen ? "visible translate-x-0 pointer-events-auto" : "invisible -translate-x-full pointer-events-none md:visible md:pointer-events-auto"}`}
      >
        <div aria-hidden="true" className={styles.texture} />
        <div aria-hidden="true" className={styles.glass} />
        <div aria-hidden={desktopOpen ? "true" : undefined} inert={desktopOpen ? true : undefined} aria-label={t("Navegación compacta")} data-testid="workbench-sidebar-rail" className={`${styles.rail} absolute inset-0 hidden h-full w-[52px] flex-col items-center bg-[var(--sidebar)] py-2 transition-opacity duration-150 md:flex ${desktopOpen ? "pointer-events-none opacity-0" : "opacity-100"}`}>
          <button ref={railOpenButtonRef} aria-label={t("Mostrar barra lateral")} className="touch-target grid size-9 place-items-center rounded-lg text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onClick={() => { onOpenDesktop(); requestAnimationFrame(() => desktopCloseButtonRef.current?.focus()); }}><SidebarSimple size={19} /></button>
          <button aria-label={t("Buscar")} title={t("Buscar")} className="touch-target grid size-9 place-items-center rounded-lg text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--focus)]" onClick={(event) => onOpenCommandPalette(event.currentTarget)}><MagnifyingGlass size={18} /></button>
          <div className="mt-2 flex flex-col items-center gap-1">
            <button disabled={!standaloneProject || busy} aria-label={t("Nueva conversación")} className="touch-target grid size-9 place-items-center rounded-lg text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-35" onClick={() => onNewThread()}><NotePencil size={18} /></button>
            <button aria-label={t("Automatizaciones")} title={t("Automatizaciones")} className="touch-target grid size-9 place-items-center rounded-lg text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onClick={onOpenAutomations}><CalendarBlank size={18} /></button>
            {g03ProductInstallation(branding.installationId) && onOpenProduction && <button aria-label="Producció" title="Producció" className="touch-target grid size-9 place-items-center rounded-lg" onClick={onOpenProduction}><Factory size={18} /></button>}
            {g03ProductInstallation(branding.installationId) && onOpenApps && <button aria-label="Aplicacions" title="Aplicacions" className="touch-target grid size-9 place-items-center rounded-lg" onClick={onOpenApps}><AppWindow size={18} /></button>}
            {g03ProductInstallation(branding.installationId) && onOpenReception && <button aria-label="Recepció" title="Recepció" className="touch-target grid size-9 place-items-center rounded-lg" onClick={onOpenReception}><Package size={18} /></button>}
            {canOpenInsiJetsWorkspace && onOpenDirectory ? <>
              {onOpenPriceIndex ? <button aria-label={locale === "es" ? "Índice de precios" : "Price Index"} title={locale === "es" ? "Índice de precios" : "Price Index"} className="touch-target grid size-9 place-items-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]" onClick={onOpenPriceIndex}><CurrencyEur size={18}/></button> : null}
              <button aria-label={locale === "es" ? "Directorio de operadores" : "Operator directory"} title={locale === "es" ? "Directorio de operadores" : "Operator directory"} className="touch-target grid size-9 place-items-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]" onClick={onOpenDirectory}><Airplane size={18}/></button>
              {insijetsOutreachAccess && onOpenOutreach ? <button type="button" onClick={onOpenOutreach} aria-label="Outreach System" title="Outreach System" className="touch-target grid size-9 place-items-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"><NotePencil size={18}/></button> : null}
              {insijetsSourcingAccess ? <a href="/insijets/operator-sourcing" target="_blank" rel="noopener noreferrer" aria-label={locale === 'es' ? 'Búsqueda y solicitudes de aeronaves' : 'Aircraft sourcing and requests'} title={locale === 'es' ? 'Búsqueda y solicitudes de aeronaves' : 'Aircraft sourcing and requests'} className="touch-target grid size-9 place-items-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"><MagnifyingGlass size={18}/></a> : null}
            </> : null}
          </div>
          <div className="mt-auto flex flex-col items-center gap-1">
            <button aria-label={t("{p0}. Mostrar cuenta", { p0: session.user.name })} className="touch-target grid size-9 place-items-center rounded-lg text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onClick={onOpenDesktop}><UserAvatar name={session.user.name} avatarUrl={session.user.avatarUrl ?? null} className="size-6" /></button>
          </div>
        </div>
        <div aria-hidden={!(desktopOpen || mobileOpen)} inert={!(desktopOpen || mobileOpen) ? true : undefined} className={`${styles.content} flex h-full w-[min(280px,88vw)] shrink-0 flex-col transition-opacity duration-150 md:w-[var(--sidebar-width,280px)] ${desktopOpen ? "md:opacity-100" : "md:pointer-events-none md:opacity-0"}`}>
	        <div data-testid="sidebar-header" className="flex h-14 shrink-0 items-center justify-between gap-1 px-2">
	          <div data-testid="sidebar-brand" className="flex h-10 min-w-0 flex-1 items-center gap-2 overflow-hidden px-2"><BrandMark branding={branding} compact /><span className="min-w-0 flex-1 truncate text-[16px] font-medium tracking-[-.02em] text-[var(--text)]">{branding.productName}</span></div>
          <div className="flex shrink-0 items-center gap-0.5">
            <button type="button" aria-label={t("Buscar")} title={t("Buscar")} className="touch-target grid size-9 place-items-center rounded-lg text-[var(--text-subtle)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]" onClick={(event) => onOpenCommandPalette(event.currentTarget)}><MagnifyingGlass size={18} aria-hidden="true" /></button>
            <button ref={desktopCloseButtonRef} aria-label={t("Ocultar barra lateral")} className="touch-target hidden size-9 place-items-center rounded-lg text-[var(--text-subtle)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] md:grid" onClick={() => { onCloseDesktop(); requestAnimationFrame(() => railOpenButtonRef.current?.focus()); }}><SidebarSimple size={18} /></button>
            <button aria-label={t("Cerrar menú")} className="touch-target rounded-lg p-2 text-[var(--text-subtle)] hover:bg-[var(--surface-hover)] md:hidden" onClick={onCloseMobile}><X size={18} /></button>
          </div>
        </div>

        <nav aria-label={t("Navegación principal")} className="px-2 pb-2">
          <SidebarMenu className="gap-1">
            <SidebarMenuItem>
              <SidebarMenuButton icon={NotePencil} className={styles.newConversation} disabled={!standaloneProject || busy} render={<button onClick={() => onNewThread()} />}>
                {" "}{t("Nueva conversación")}{" "}</SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton icon={CalendarBlank} aria-label={t("Automatizaciones")} title={t("Gestionar automatizaciones")} render={<button onClick={onOpenAutomations} />}>
                {" "}{t("Automatizaciones")}{" "}</SidebarMenuButton>
              {canOpenInsiJetsWorkspace && onOpenDirectory ? <>
                {onOpenPriceIndex ? <SidebarMenuButton icon={CurrencyEur} aria-label={locale === "es" ? "Índice de precios" : "Price Index"} render={<button onClick={onOpenPriceIndex}/>}>{locale === "es" ? "Índice de precios" : "Price Index"}</SidebarMenuButton> : null}
                <SidebarMenuButton icon={Airplane} aria-label={locale === "es" ? "Directorio de operadores" : "Operator directory"} render={<button onClick={onOpenDirectory}/>}>{locale === "es" ? "Directorio de operadores" : "Operator directory"}</SidebarMenuButton>
                {insijetsOutreachAccess && onOpenOutreach ? <SidebarMenuButton icon={NotePencil} aria-label="Outreach System" render={<button onClick={onOpenOutreach}/>}>Outreach System</SidebarMenuButton> : null}
                {insijetsSourcingAccess ? <SidebarMenuButton icon={MagnifyingGlass} aria-label={locale === 'es' ? 'Búsqueda y solicitudes de aeronaves' : 'Aircraft sourcing and requests'} render={<a href="/insijets/operator-sourcing" target="_blank" rel="noopener noreferrer"/>}>{locale === 'es' ? 'Solicitudes de aeronaves' : 'Aircraft sourcing'}</SidebarMenuButton> : null}
              </> : null}
            </SidebarMenuItem>
            {g03ProductInstallation(branding.installationId) && onOpenProduction && <SidebarMenuItem>
              <SidebarMenuButton icon={Factory} isActive={productView === "production"} aria-label="Producció" render={<button onClick={onOpenProduction} />}>Producció</SidebarMenuButton>
            </SidebarMenuItem>}
            {g03ProductInstallation(branding.installationId) && onOpenApps && <SidebarMenuItem>
              <SidebarMenuButton icon={AppWindow} isActive={productView === "apps"} aria-label="Aplicacions" render={<button onClick={onOpenApps} />}>Aplicacions</SidebarMenuButton>
            </SidebarMenuItem>}
            {g03ProductInstallation(branding.installationId) && onOpenReception && <SidebarMenuItem><SidebarMenuButton isActive={productView === "reception"} onClick={onOpenReception}><Package size={18} /><span>Recepció</span></SidebarMenuButton></SidebarMenuItem>}
          </SidebarMenu>
        </nav>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {pinnedThreads.length > 0 ? (
            <section aria-labelledby="pinned-conversations-label" className="group/pinned">
              <div className="flex items-center justify-between pb-1 pt-3">
                <button data-testid="sidebar-pinned-label" id="pinned-conversations-label" type="button" aria-expanded={pinnedOpen} aria-controls="pinned-conversations" className={`${styles.sectionLabel} sidebar-section-label flex items-center gap-1 px-2 py-1 text-[var(--text-subtle)]`} onClick={() => disclosure.setOpen("pinned", !pinnedOpen)}>{t("Anclados")}{pinnedOpen ? <CaretDown size={11} /> : <CaretRight size={11} />}</button>
              </div>
              {pinnedOpen ? <SidebarMenu id="pinned-conversations" size="compact" className="gap-0.5">
                {pinnedThreads.map((thread) => {
                  const project = projects.find((candidate) => candidate.id === thread.projectId) ?? null;
                  const access = workbenchThreadAccess(thread, project);
                  const active = thread.id === activeThreadId;
                  const menuOpen = threadMenuId === thread.id;
                  return (
                    <SidebarMenuItem key={thread.id} className={`group/thread ${menuOpen ? "z-40" : ""}`}>
                      <SidebarMenuButton isActive={active} className={`sidebar-touch-row ${styles.threadRow}`} render={<button data-thread-id={thread.id} onClick={() => selectThread(thread.id)} />}>
                        {thread.title}
                        <ThreadActivitySignal activity={threadActivityById[thread.id]} />
                        <PushPin size={10} weight="fill" />
                      </SidebarMenuButton>
                      <button aria-label={t("Acciones de {p0}", { p0: thread.title })} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? `sidebar-thread-actions-${thread.id}` : undefined} className={`sidebar-item-action absolute inset-y-0 right-0 z-20 grid w-11 place-items-center text-[var(--text-subtle)] opacity-0 hover:text-[var(--text)] group-hover/thread:opacity-100 focus:opacity-100 ${contextMenuOpen && !menuOpen ? "context-menu-suppressed" : ""}`} onClick={() => { setProjectMenuId(null); setThreadMenuId(menuOpen ? null : thread.id); }}><DotsThree size={14} weight="bold" /></button>
                      {menuOpen ? <ItemActions kind="thread" item={thread} canEdit={access?.canEdit ?? true} canPin canArchive={access?.canEdit ?? true} onClose={closeMenus} onAction={(action, returnFocus) => { closeMenus(); onThreadAction(thread, action as ThreadMenuAction, returnFocus); }} /> : null}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu> : null}
            </section>
          ) : null}

          <section aria-labelledby="projects-label" className={`group/projects ${styles.section}`}>
            <div className="flex items-center justify-between pb-1 pt-2">
              <button data-testid="sidebar-projects-label" id="projects-label" type="button" aria-expanded={projectsOpen} aria-controls="projects-list" className={`${styles.sectionLabel} sidebar-section-label flex items-center gap-1 px-2 py-1 text-[var(--text-subtle)]`} onClick={() => disclosure.setOpen("projects", !projectsOpen)}>{t("Proyectos")}{projectsOpen ? <CaretDown size={11} /> : <CaretRight size={11} />}</button>
              <button aria-label={t("Crear proyecto")} className="touch-target grid size-7 place-items-center text-[var(--text-subtle)] opacity-0 transition hover:text-[var(--text)] group-hover/projects:opacity-100 group-focus-within/projects:opacity-100" onClick={(event) => onNewProject(event.currentTarget)}><Plus size={14} /></button>
            </div>
            {projectsOpen ? <SidebarMenu id="projects-list" className="gap-0.5">
              {activeProjects.length === 0 ? (
                <SidebarMenuItem><button className="w-full rounded-lg border border-dashed border-[var(--border)] px-3 py-3 text-left text-[12px] leading-5 text-[var(--text-subtle)]" onClick={(event) => onNewProject(event.currentTarget)}>{t("Crea tu primer proyecto")}</button></SidebarMenuItem>
              ) : activeProjects.map((project) => {
                const access = workbenchProjectAccess(project);
                const active = project.id === activeProjectId;
                const menuOpen = projectMenuId === project.id;
                const allActiveProjectThreads = threads.filter((thread) => thread.projectId === project.id && thread.status === "active");
                const activeProjectThreads = allActiveProjectThreads.filter((thread) => !thread.pinned).sort(byPriority);
                const projectThreadLimit = projectThreadLimits[project.id] ?? 20;
                const visibleProjectThreads = activeProjectThreads.filter((thread, index) =>
                  index < projectThreadLimit || thread.id === activeThreadId ||
                  ["running", "needs_attention", "failed"].includes(threadActivityById[thread.id]?.state ?? "idle"));
                const projectActivities = threads
                  .filter((thread) => thread.projectId === project.id && thread.status === "active")
                  .map((thread) => threadActivityById[thread.id])
                  .filter((activity): activity is ThreadActivity => Boolean(activity));
                const needsVisibility = projectActivities.some((activity) =>
                  activity.state === "running" || activity.state === "needs_attention" ||
                  activity.state === "failed" || activity.unreadCount > 0);
                const projectThreadsOpen = disclosure.isOpen(`project:${project.id}`, active || needsVisibility);
                return (
                  <SidebarMenuItem key={project.id} className={`${menuOpen ? "z-40" : ""}`}>
                    <div data-testid="sidebar-project-header" className="group/project relative">
                      <SidebarMenuButton icon={active ? FolderOpen : Folder} isActive={active && !activeThreadId} className={`sidebar-touch-row ${styles.projectRow}`} render={<button data-testid="sidebar-project-row" data-project-active={active} title={project.name} onClick={() => selectProject(project.id)} />}>
                        {project.name}
                        <ProjectActivitySignal activities={projectActivities} />
                        {project.pinned ? <PushPin size={11} weight="fill" className="text-[var(--text-subtle)]" /> : null}
                      </SidebarMenuButton>
                      <button aria-label={t(projectThreadsOpen ? "Contraer {p0}" : "Expandir {p0}", { p0: project.name })} aria-expanded={projectThreadsOpen} className={`sidebar-project-disclosure ${styles.disclosure}`} onClick={() => disclosure.setOpen(`project:${project.id}`, !projectThreadsOpen)}>{projectThreadsOpen ? <CaretDown size={13} /> : <CaretRight size={13} />}</button>
                      <button aria-label={t("Acciones de {p0}", { p0: project.name })} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? `sidebar-project-actions-${project.id}` : undefined} className={`sidebar-item-action absolute inset-y-0 right-0 z-20 grid w-11 place-items-center text-[var(--text-subtle)] opacity-0 hover:text-[var(--text)] group-hover/project:opacity-100 focus:opacity-100 ${contextMenuOpen && !menuOpen ? "context-menu-suppressed" : ""}`} onClick={() => { setThreadMenuId(null); setProjectMenuId(menuOpen ? null : project.id); }}><DotsThree size={15} weight="bold" /></button>
                      {menuOpen ? <ItemActions kind="project" onNewThread={busy ? undefined : () => { closeMenus(); onNewThread(project.id); }} item={project} canEdit={access.canEdit} canManage={access.canManage} onClose={closeMenus} onAction={(action, returnFocus) => { closeMenus(); onProjectAction(project, action as ProjectMenuAction, returnFocus); }} /> : null}
                    </div>
                    {projectThreadsOpen ? <div aria-label={t("Chats de {p0}", { p0: project.name })} className={styles.projectChildren}>
                      <div className="space-y-0.5">
                        {activeProjectThreads.length === 0 ? <p data-testid="sidebar-project-thread" className="px-2 py-1 text-[11px] leading-5 text-[var(--text-subtle)]">{allActiveProjectThreads.length > 0 ? t("Sus conversaciones están en Anclados.") : t("Aún no hay conversaciones.")}</p> : visibleProjectThreads.map((thread) => {
                          const threadAccess = workbenchThreadAccess(thread, project);
                          const threadActive = thread.id === activeThreadId;
                          const threadMenuOpen = threadMenuId === thread.id;
                          return (
                            <div key={thread.id} className={`relative group/thread ${threadMenuOpen ? "z-40" : ""}`}>
                              <button data-testid="sidebar-project-thread" data-thread-id={thread.id} aria-current={threadActive ? "page" : undefined} className={`${styles.threadRow} sidebar-touch-row flex w-full items-center rounded-lg px-2 py-1.5 pr-11 text-left transition ${threadActive ? "bg-[var(--surface-selected)] text-[var(--text)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"}`} onClick={() => selectThread(thread.id)}>
                                <span className="min-w-0 flex-1 truncate text-[12px] font-normal">{thread.title}</span>
                                <ThreadActivitySignal activity={threadActivityById[thread.id]} />
                                {thread.pinned ? <PushPin size={10} weight="fill" /> : null}
                              </button>
                              <button aria-label={t("Acciones de {p0}", { p0: thread.title })} aria-haspopup="menu" aria-expanded={threadMenuOpen} aria-controls={threadMenuOpen ? `sidebar-thread-actions-${thread.id}` : undefined} className={`sidebar-item-action absolute inset-y-0 right-0 z-20 grid w-11 place-items-center text-[var(--text-subtle)] opacity-0 hover:text-[var(--text)] group-hover/thread:opacity-100 focus:opacity-100 ${contextMenuOpen && !threadMenuOpen ? "context-menu-suppressed" : ""}`} onClick={() => { setProjectMenuId(null); setThreadMenuId(threadMenuOpen ? null : thread.id); }}><DotsThree size={13} weight="bold" /></button>
                              {threadMenuOpen ? <ItemActions kind="thread" item={thread} canEdit={threadAccess.canEdit} canPin canArchive={threadAccess.canEdit} onClose={closeMenus} onAction={(action, returnFocus) => { closeMenus(); onThreadAction(thread, action as ThreadMenuAction, returnFocus); }} /> : null}
                            </div>
                          );
                        })}
                        {visibleProjectThreads.length < activeProjectThreads.length ? (
                          <button type="button" className={styles.showMore} aria-label={`${t("Ver más conversaciones")} · ${project.name}`} onClick={() => setProjectThreadLimits((limits) => ({ ...limits, [project.id]: projectThreadLimit + 20 }))}>{t("Ver más conversaciones")}</button>
                        ) : null}
                      </div>
                    </div> : null}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu> : null}
          </section>

          <section aria-labelledby="standalone-conversations-label" className={`group/chats ${styles.section}`}>
            <div className="flex items-center justify-between pb-1 pt-3">
              <button data-testid="sidebar-chats-label" id="standalone-conversations-label" type="button" aria-expanded={chatsOpen} aria-controls="standalone-conversations" className={`${styles.sectionLabel} sidebar-section-label flex items-center gap-1 px-2 py-1 text-[var(--text-subtle)]`} onClick={() => disclosure.setOpen("chats", !chatsOpen)}>{t("Conversaciones recientes")}{chatsOpen ? <CaretDown size={11} /> : <CaretRight size={11} />}</button>
	              <button disabled={!standaloneProject || busy} aria-label={t("Nueva conversación independiente")} className="touch-target grid size-7 place-items-center text-[var(--text-subtle)] opacity-0 transition hover:text-[var(--text)] group-hover/chats:opacity-100 group-focus-within/chats:opacity-100 disabled:opacity-40" onClick={() => onNewThread()}><Plus size={14} /></button>
            </div>
            {chatsOpen ? <SidebarMenu id="standalone-conversations" size="compact" className="gap-0.5">
              {activeStandaloneThreads.length === 0 ? (
                <li className="px-2 py-2 text-[12px] leading-5 text-[var(--text-subtle)]">{t("Tus chats sin proyecto aparecerán aquí.")}</li>
              ) : visibleStandaloneThreads.map((thread) => {
                const access = workbenchThreadAccess(thread, standaloneProject);
                const active = thread.id === activeThreadId;
                const menuOpen = threadMenuId === thread.id;
                return (
                  <SidebarMenuItem key={thread.id} className={`group/thread ${menuOpen ? "z-40" : ""}`}>
                    <SidebarMenuButton isActive={active} className={`sidebar-touch-row ${styles.threadRow}`} render={<button data-thread-id={thread.id} onClick={() => selectThread(thread.id)} />}>
                      {thread.title}
                      <ThreadActivitySignal activity={threadActivityById[thread.id]} />
                      {thread.pinned ? <PushPin size={10} weight="fill" /> : threadActivityById[thread.id]?.state === "idle" ? <span className="text-[11px] text-[var(--text-subtle)] opacity-0 group-hover/thread:opacity-100">{relativeDate(thread.updatedAt, locale)}</span> : null}
                    </SidebarMenuButton>
                    <button aria-label={t("Acciones de {p0}", { p0: thread.title })} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? `sidebar-thread-actions-${thread.id}` : undefined} className={`sidebar-item-action absolute inset-y-0 right-0 z-20 grid w-11 place-items-center text-[var(--text-subtle)] opacity-0 hover:text-[var(--text)] group-hover/thread:opacity-100 focus:opacity-100 ${contextMenuOpen && !menuOpen ? "context-menu-suppressed" : ""}`} onClick={() => { setProjectMenuId(null); setThreadMenuId(menuOpen ? null : thread.id); }}><DotsThree size={14} weight="bold" /></button>
                    {menuOpen ? <ItemActions kind="thread" item={thread} canEdit={access.canEdit} canPin canArchive={access.canEdit} onClose={closeMenus} onAction={(action, returnFocus) => { closeMenus(); onThreadAction(thread, action as ThreadMenuAction, returnFocus); }} /> : null}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu> : null}
            {chatsOpen && visibleStandaloneThreads.length < activeStandaloneThreads.length ? (
              <button className={styles.showMore} onClick={() => setRecentLimit((limit) => limit + 8)}>{t("Ver más conversaciones")}</button>
            ) : null}
          </section>

          <button type="button" className="touch-target mt-2 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]" onClick={(event) => onOpenCustomization(event.currentTarget, "archived")}><Archive size={15} />{t("Conversaciones archivadas")}</button>
        </div>

        <div ref={profileMenuRef} className={`${styles.account} relative shrink-0 p-2`} onKeyDown={(event) => {
          // Escape can arrive before the next-frame focus enters the menu.
          if (event.key === "Escape" && profileMenuOpen) {
            event.preventDefault();
            event.stopPropagation();
            closeProfileMenuAndRestore();
          }
        }}>
          {profileMenuOpen ? (
	            <div id="sidebar-profile-menu" role="menu" aria-label={t("Cuenta y preferencias")} className={`${styles.contextMenu} menu-enter absolute inset-x-2 bottom-[calc(100%-2px)] z-30 origin-bottom rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-1.5 shadow-[var(--shadow-popover)]`} onKeyDown={onProfileMenuKeyDown}>
              <p className="truncate px-3 py-2.5 text-[12px] font-semibold text-[var(--text)]" role="presentation">{session.user.name}</p>
	              <button role="menuitem" tabIndex={-1} className="touch-target flex min-h-11 w-full items-center gap-2.5 rounded-[14px] px-3 text-[12px] font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onClick={() => { onOpenCustomization(profileButtonRef.current); setProfileMenuOpen(false); }}><GearSix size={16} />{t("Configuración")}</button>
              <button role="menuitem" tabIndex={-1} className="touch-target flex min-h-11 w-full items-center gap-2.5 rounded-[14px] px-3 text-[12px] font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onClick={() => { setProfileMenuOpen(false); setHelpView("new"); setHelpOpen(true); }}><Question size={16} />{t("Ayuda")}</button>
	              <button role="menuitem" tabIndex={-1} className="touch-target flex min-h-11 w-full items-center gap-2.5 rounded-[14px] px-3 text-[12px] font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onClick={() => void fetch("/api/auth/logout", { method: "POST" }).then((response) => { if (response.ok) router.push("/login"); })}><SignOut size={16} />{t("Cerrar sesión")}</button>
            </div>
          ) : null}
	<SupportInboxNotice key={`${session.tenant.id}:${session.user.id}`} accountKey={`${session.tenant.id}:${session.user.id}`} open={helpOpen} onOpen={openSupportInbox} />
          <button ref={profileButtonRef} aria-label={t("{p0}. Abrir menú de cuenta", { p0: session.user.name })} aria-haspopup="menu" aria-expanded={profileMenuOpen} aria-controls={profileMenuOpen ? "sidebar-profile-menu" : undefined} className={`${styles.profileCard} touch-target flex w-full items-center gap-2.5 px-2 py-2.5 text-left`} onClick={() => { setProjectMenuId(null); setThreadMenuId(null); if (profileMenuOpen) setHelpOpen(false); setProfileMenuOpen((open) => !open); }}>
            <UserAvatar name={session.user.name} avatarUrl={session.user.avatarUrl ?? null} className="size-8" />
            <span className="min-w-0 flex-1"><span className="block truncate text-[12px] font-semibold leading-[17px] text-[var(--text)]">{session.user.name}</span><span className="mt-0.5 block truncate text-[12px] leading-[17px] text-[var(--text-subtle)]">{branding.companyName}</span></span>
          </button>
        </div>
        </div>
      </aside>
      <SupportDialog navigation={{ view: helpView, onViewChange: setHelpView }} open={helpOpen} projectId={activeProjectId} threadId={activeThreadId} returnFocusRef={profileButtonRef} onClose={() => setHelpOpen(false)} />
    </>
  );
}
