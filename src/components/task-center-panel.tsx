"use client";
import { translate } from "@/i18n/messages";
import { useUiLocale } from "@/i18n/provider";
import { useUiText } from "@/i18n/provider";

import { useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bell,
  BellRinging,
  Check,
  CheckCircle,
  ChatCircleDots,
  ClockCounterClockwise,
  GearSix,
  SpinnerGap,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type {
  TaskCenterFilter,
  TaskCenterItem,
  TaskNotificationPreferences,
} from "@/task-center/contracts";
import { useModalFocus } from "@/ui/use-modal-focus";
import { OverlayPresenceLayer } from "@/ui/overlay-presence";

const filters: Array<{ id: TaskCenterFilter; label: string }> = [
  { id: "all", label: "Todas" },
  { id: "running", label: "En curso" },
  { id: "needs_attention", label: "Atención" },
  { id: "completed", label: "Completadas" },
  { id: "failed", label: "Con error" },
];

const statusCopy: Record<TaskCenterItem["status"], string> = {
  running: "En curso",
  needs_attention: "Necesita tu atención",
  completed: "Completada",
  failed: "Con error",
};

function statusIcon(status: TaskCenterItem["status"]) {
  if (status === "running") return <SpinnerGap size={17} className="motion-safe:animate-spin" />;
  if (status === "completed") return <CheckCircle size={17} weight="fill" />;
  return <WarningCircle size={17} weight="fill" />;
}

function timeLabel(value: string, locale: "en" | "es" | "ca" = "es") {
  const date = new Date(value);
  const elapsed = Date.now() - date.getTime();
  if (Number.isNaN(elapsed)) return "";
  if (elapsed < 60_000) return translate(locale, "Ahora");
  if (elapsed < 3_600_000) return translate(locale, "Hace {p0} min", { p0: Math.max(1, Math.floor(elapsed / 60_000)) });
  if (elapsed < 86_400_000) return translate(locale, "Hace {p0} h", { p0: Math.floor(elapsed / 3_600_000) });
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(date);
}

function PreferenceRow({
  icon,
  label,
  detail,
  checked,
  disabled,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`flex items-center gap-3 rounded-[16px] px-3 py-3 ${disabled ? "opacity-55" : "hover:bg-[var(--surface-hover)]"}`}>
      <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-[var(--surface-muted)] text-[var(--text-secondary)]">{icon}</span>
      <span className="min-w-0 flex-1"><span className="block text-[12px] font-semibold text-[var(--text)]">{label}</span><span className="mt-0.5 block text-[10px] leading-4 text-[var(--text-subtle)]">{detail}</span></span>
      <input type="checkbox" className="size-4 accent-[var(--brain-accent)]" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

export function TaskCenterPanel({
  open,
  tasks,
  preferences,
  notificationPermission,
  busy,
  onClose,
  onOpenConversation,
  onMarkRead,
  onMarkAllRead,
  onPreferencesChange,
  onRequestDesktopNotifications,
}: {
  open: boolean;
  tasks: TaskCenterItem[];
  preferences: TaskNotificationPreferences;
  notificationPermission: NotificationPermission | "unsupported";
  busy: boolean;
  onClose: () => void;
  onOpenConversation: (task: TaskCenterItem) => void;
  onMarkRead: (taskId: string) => void;
  onMarkAllRead: () => void;
  onPreferencesChange: (preferences: TaskNotificationPreferences) => void;
  onRequestDesktopNotifications: () => void;
}) {
  const locale = useUiLocale();
  const t = useUiText();
  const [filter, setFilter] = useState<TaskCenterFilter>("all");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const dialogRef = useModalFocus(open, onClose);
  const visible = useMemo(
    () => tasks.filter((task) => filter === "all" || task.status === filter),
    [filter, tasks],
  );
  const unread = tasks.filter((task) => task.unread).length;

  return <AnimatePresence initial={false}>{open ? (
    <OverlayPresenceLayer key="task-center-panel" origin="right" className="workspace-overlay fixed inset-0 z-[76] flex justify-end">
      {(surfaceMotion) => <>
        <button aria-label={t("Cerrar centro de tareas")} className="absolute inset-0" onClick={onClose} />
        <motion.section {...surfaceMotion} ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("Centro de tareas")} className="workspace-panel relative flex h-full w-full max-w-[540px] flex-col border-l border-[var(--border-subtle)] bg-[var(--surface-raised)] pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow-popover)]">
        <header className="workspace-panel-header flex shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-4 pt-[env(safe-area-inset-top)] sm:px-5 sm:pt-0">
          <span className="grid size-9 shrink-0 place-items-center rounded-[13px] bg-[var(--accent-soft)] text-[var(--brain-accent-on-soft)]"><ClockCounterClockwise size={18} /></span>
          <div className="min-w-0 flex-1"><h2 className="workspace-panel-title text-[var(--text)]">{t("Tareas")}</h2><p className="workspace-panel-subtitle mt-0.5">{t("Sigue el trabajo de todas tus conversaciones.")}</p></div>
          <button type="button" aria-label={t("Preferencias de notificaciones")} aria-pressed={settingsOpen} className={`touch-target grid size-10 place-items-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] ${settingsOpen ? "bg-[var(--surface-selected)]" : ""}`} onClick={() => setSettingsOpen((value) => !value)}><GearSix size={18} /></button>
          <button type="button" aria-label={t("Cerrar centro de tareas")} className="touch-target grid size-10 place-items-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]" onClick={onClose}><X size={18} /></button>
        </header>

        {settingsOpen ? (
          <div className="border-b border-[var(--border-subtle)] bg-[var(--surface)] px-3 py-3 sm:px-4">
            <h3 className="px-3 text-[11px] font-semibold text-[var(--text)]">{t("Notificaciones")}</h3>
            <PreferenceRow icon={<Bell size={17} />} label={t("Avisos dentro de la aplicación")} detail={t("Muestra un aviso cuando otra conversación termina o necesita atención.")} checked={preferences.inApp} disabled={busy} onChange={(inApp) => onPreferencesChange({ ...preferences, inApp })} />
            <PreferenceRow icon={<BellRinging size={17} />} label={t("Avisos del navegador")} detail={notificationPermission === "denied" ? t("El navegador los ha bloqueado. Puedes reactivarlos desde sus ajustes.") : notificationPermission === "unsupported" ? t("Este navegador no admite avisos del sistema.") : t("Solo se activan después de que aceptes el permiso del navegador.")} checked={preferences.desktop && notificationPermission === "granted"} disabled={busy || notificationPermission === "denied" || notificationPermission === "unsupported"} onChange={(enabled) => {
              if (enabled && notificationPermission !== "granted") onRequestDesktopNotifications();
              else onPreferencesChange({ ...preferences, desktop: enabled });
            }} />
            <p className="px-3 pb-1 pt-2 text-[10px] leading-4 text-[var(--text-subtle)]">{t("Las tareas se actualizan mientras el servidor y su worker estén activos. Esta pantalla no promete ejecución en la nube cuando están apagados.")}</p>
          </div>
        ) : null}

        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-3 sm:px-4">
          <div className="scrollbar-thin flex min-w-0 flex-1 gap-1 overflow-x-auto" aria-label={t("Filtros de tareas")}>
            {filters.map((option) => {
              const count = option.id === "all" ? tasks.length : tasks.filter((task) => task.status === option.id).length;
              return <button key={option.id} type="button" aria-pressed={filter === option.id} className={`touch-target min-h-8 shrink-0 rounded-full px-3 text-[11px] font-medium transition ${filter === option.id ? "bg-[var(--text)] text-[var(--surface)]" : "bg-[var(--surface-muted)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"}`} onClick={() => setFilter(option.id)}>{t(option.label ?? "")}{count ? ` · ${count}` : ""}</button>;
            })}
          </div>
          {unread ? <button type="button" disabled={busy} className="touch-target flex min-h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[10px] font-semibold text-[var(--brain-accent-on-soft)] hover:bg-[var(--accent-soft)] disabled:opacity-50" onClick={onMarkAllRead}><Check size={13} />{t("Leer todo")}</button> : null}
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2 sm:p-3" aria-live="polite">
          {visible.length ? visible.map((task) => (
            <article key={task.id} className={`group mb-1 rounded-[18px] border px-3 py-3 transition ${task.unread ? "border-[color-mix(in_srgb,var(--brain-accent)_24%,var(--border))] bg-[var(--accent-soft)]" : "border-transparent hover:bg-[var(--surface-hover)]"}`}>
              <div className="flex items-start gap-3">
                <span className={`mt-0.5 grid size-9 shrink-0 place-items-center rounded-[12px] ${task.status === "completed" ? "bg-[var(--positive-soft)] text-[var(--positive)]" : task.status === "running" ? "bg-[var(--surface-muted)] text-[var(--text-secondary)]" : "bg-[var(--danger-soft)] text-[var(--danger)]"}`}>{statusIcon(task.status)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><span className={`text-[10px] font-semibold ${task.status === "completed" ? "text-[var(--positive)]" : task.status === "running" ? "text-[var(--text-subtle)]" : "text-[var(--danger)]"}`}>{t(statusCopy[task.status] ?? "")}</span>{task.unread ? <span className="size-1.5 rounded-full bg-[var(--brain-accent)]" aria-label={t("Sin leer")} /> : null}<time className="ml-auto text-[9px] text-[var(--text-subtle)]" dateTime={task.updatedAt}>{timeLabel(task.updatedAt, locale)}</time></div>
                  <h3 className="mt-1 line-clamp-2 text-[12px] font-semibold leading-5 text-[var(--text)]">{task.title}</h3>
                  <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-[var(--text-subtle)]">{task.detail}</p>
                  <p className="mt-2 truncate text-[9px] text-[var(--text-subtle)]">{task.projectName ? `${task.projectName} · ` : ""}{task.threadTitle}</p>
                </div>
              </div>
              <div className="mt-2 flex justify-end gap-1">
                {task.unread ? <button type="button" disabled={busy} className="touch-target min-h-8 rounded-full px-3 text-[10px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-raised)] disabled:opacity-50" onClick={() => onMarkRead(task.id)}>{t("Marcar como leída")}</button> : null}
                <button type="button" className="touch-target flex min-h-8 items-center gap-1.5 rounded-full bg-[var(--surface-raised)] px-3 text-[10px] font-semibold text-[var(--text)] shadow-[var(--shadow-sm)]" onClick={() => onOpenConversation(task)}><ChatCircleDots size={13} />{t("Abrir conversación")}</button>
              </div>
            </article>
          )) : (
            <div className="grid min-h-72 place-items-center px-8 text-center"><div className="workspace-empty-state"><span className="mx-auto grid size-12 place-items-center rounded-[16px] bg-[var(--surface-muted)] text-[var(--text-subtle)]"><CheckCircle size={21} /></span><p className="mt-3 text-[13px] font-semibold text-[var(--text)]">{t("Todo al día")}</p><p className="mt-1 text-[11px] leading-5 text-[var(--text-subtle)]">{t("Las tareas en curso, completadas o que necesiten tu atención aparecerán aquí.")}</p></div></div>
          )}
        </div>
        </motion.section>
      </>}
    </OverlayPresenceLayer>
  ) : null}</AnimatePresence>;
}
