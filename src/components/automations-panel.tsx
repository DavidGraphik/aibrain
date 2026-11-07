"use client";
import { useUiLocale } from "@/i18n/provider";
import { useUiText } from "@/i18n/provider";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarBlank,
  Clock,
  Pause,
  PencilSimple,
  Play,
  Plus,
  SidebarSimple,
  SpinnerGap,
  Trash,
} from "@phosphor-icons/react";
import type { AutomationAudienceDirectory, AutomationRunHistory, AutomationSchedule, AutomationTask, AutomationTaskView } from "@/automations/contracts";
import { AUTOMATION_TIME_ZONES } from "@/automations/contracts";
import { describeSchedule, localMinuteToInstant, localParts } from "@/automations/schedule";
import type { WorkbenchProject } from "@/workbench/types";
import { STANDALONE_PROJECT_SLUG } from "@/workbench/types";
import { useModalFocus } from "@/ui/use-modal-focus";
import { getProjectRequest } from "@/lib/workbench-api-client";
import { AutomationResult } from "@/components/automation-result";

type ScheduleKind = AutomationSchedule["kind"];
type AutomationDraft = {
  name: string;
  prompt: string;
  projectId: string;
  kind: ScheduleKind;
  intervalMinutes: number;
  intervalAnchorAt: string | null;
  monthlyDay: number;
  monthlyMonths: number[];
  recurrenceStartAt: string;
  timeZone: string;
  time: string;
  onceAt: string;
  selectedWeekdays: number[];
  fortnightly: boolean;
  audienceUserIds: string[];
  audienceGroupIds: string[];
};


function draftSignature(draft: AutomationDraft) {
  return JSON.stringify(Object.fromEntries(Object.entries(draft).sort(([a],[b])=>a.localeCompare(b))));
}

function dateLabel(value: string | null, timeZone: string, locale: "en" | "es" | "ca" = "es") {
  if (!value) return "—";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(value));
}

function localInput(iso: string | null, timeZone = "Europe/Madrid") {
  const parts = localParts(iso ? new Date(iso) : new Date(Date.now() + 3_600_000), timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function scheduleTime(task: AutomationTask | null) {
  if (!task || task.schedule.kind === "once" || task.schedule.kind === "external" || task.schedule.kind === "interval") return "09:00";
  return `${String(task.schedule.hour).padStart(2, "0")}:${String(task.schedule.minute).padStart(2, "0")}`;
}

const emptyDirectory: AutomationAudienceDirectory = {
  membershipPolicy: "current",
  currentUserId: "",
  users: [],
  groups: [],
};

function audienceLabel(task: AutomationTask, directory: AutomationAudienceDirectory, t: ReturnType<typeof useUiText>) {
  const users = new Map(directory.users.map((user) => [user.id, user.name]));
  const groups = new Map(directory.groups.map((group) => [group.id, group.name]));
  const labels = [
    ...task.audience.userIds.map((id) => users.get(id) ?? t("Usuario no disponible")),
    ...task.audience.groupIds.map((id) => groups.get(id) ? t("Grupo: {nombre}", { nombre: groups.get(id)! }) : t("Grupo eliminado")),
  ];
  return labels.length > 2 ? t("{nombres} y {cantidad} más", { nombres: labels.slice(0, 2).join(", "), cantidad: labels.length - 2 }) : labels.join(", ");
}

export function AutomationsPanel({ open, initialCreate = false, projects, onOpenThread, onToggleSidebar, onBlockingSurfaceChange }: {
  open: boolean;
  initialCreate?: boolean;
  projects: WorkbenchProject[];
  onOpenThread?: (threadId: string) => void;
  onToggleSidebar?: (opener?: HTMLElement | null) => void;
  onBlockingSurfaceChange?: (open: boolean) => void;
}) {
  const locale = useUiLocale();
  const weekdays = locale === "en" ? ["S", "M", "T", "W", "T", "F", "S"] : locale === "ca" ? ["Dg", "Dl", "Dt", "Dc", "Dj", "Dv", "Ds"] : ["D", "L", "M", "X", "J", "V", "S"];
  const t = useUiText();
  const availableProjects = useMemo(() => projects.filter((project) => project.status === "active"), [projects]);
  const [tasks, setTasks] = useState<AutomationTaskView[]>([]);
  const [audienceDirectory, setAudienceDirectory] = useState<AutomationAudienceDirectory>(emptyDirectory);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AutomationTaskView | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [projectId, setProjectId] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(120);
  const [monthlyDay, setMonthlyDay] = useState(2);
  const [recurrenceStartAt, setRecurrenceStartAt] = useState("");
  const [monthlyMonths, setMonthlyMonths] = useState<number[]>(Array.from({length:12},(_,i)=>i+1));
  const [intervalAnchorAt, setIntervalAnchorAt] = useState<string | null>(null);
  const [kind, setKind] = useState<ScheduleKind>("daily");
  const [timeZone, setTimeZone] = useState("Europe/Madrid");
  const [time, setTime] = useState("09:00");
  const [onceAt, setOnceAt] = useState(localInput(null));
  const [fortnightly, setFortnightly] = useState(false);
  const [selectedWeekdays, setSelectedWeekdays] = useState([1]);
  const [audienceUserIds, setAudienceUserIds] = useState<string[]>([]);
  const [audienceGroupIds, setAudienceGroupIds] = useState<string[]>([]);
  const [historyTaskId, setHistoryTaskId] = useState<string | null>(null);
  const [result, setResult] = useState<{ taskId: string; threadId: string } | null>(null);
  const [runsByTask, setRunsByTask] = useState<Record<string, AutomationRunHistory[]>>({});
  const [baselineDraft, setBaselineDraft] = useState("");
  const [discardConfirmation, setDiscardConfirmation] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AutomationTaskView | null>(null);
  const error = actionError ?? (formOpen || deleteTarget ? null : listError ?? historyError);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const discardContinueRef = useRef<HTMLButtonElement>(null);
  const discardPreviousFocusRef = useRef<HTMLElement | null>(null);
  const restoreDraftFocusRef = useRef(false);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const newAutomationRef = useRef<HTMLButtonElement>(null);
  const formOpenerRef = useRef<HTMLElement>(null);
  const formOpenedFromNewRef = useRef(false);
  const deleteOpenerRef = useRef<HTMLElement>(null);
  const restoreDeletedTaskFocusRef = useRef(false);
  const blockingCallbackRef = useRef(onBlockingSurfaceChange);
  const reportedBlockingCallbackRef = useRef<typeof onBlockingSurfaceChange>(undefined);
  const reportedBlockingValueRef = useRef<boolean | undefined>(undefined);

  const reportBlockingSurface = useCallback((nextOpen: boolean) => {
    const callback = blockingCallbackRef.current;
    if (reportedBlockingCallbackRef.current === callback && reportedBlockingValueRef.current === nextOpen) return;
    reportedBlockingCallbackRef.current = callback;
    reportedBlockingValueRef.current = nextOpen;
    callback?.(nextOpen);
  }, []);

  useEffect(() => {
    blockingCallbackRef.current = onBlockingSurfaceChange;
  }, [onBlockingSurfaceChange]);

  const bindNewAutomationButton = useCallback((element: HTMLButtonElement | null) => {
    newAutomationRef.current = element;
    if (element && formOpenedFromNewRef.current) formOpenerRef.current = element;
  }, []);

  const currentDraft = useMemo<AutomationDraft>(() => ({
    name,
    prompt,
    projectId,
    kind,
    intervalMinutes,
    intervalAnchorAt,
    monthlyDay,
    monthlyMonths,
    recurrenceStartAt,
    timeZone,
    time,
    onceAt,
    selectedWeekdays,
    fortnightly,
    audienceUserIds,
    audienceGroupIds,
  }), [audienceGroupIds, audienceUserIds, fortnightly, intervalMinutes, intervalAnchorAt, monthlyDay, monthlyMonths, recurrenceStartAt, kind, name, onceAt, projectId, prompt, selectedWeekdays, time, timeZone]);
  const formDirty = formOpen && baselineDraft !== draftSignature(currentDraft);

  const closeForm = useCallback(() => {
    setDiscardConfirmation(false);
    setFormOpen(false);
  }, []);

  const requestCloseForm = useCallback(() => {
    if (saving) return;
    if (discardConfirmation) {
      restoreDraftFocusRef.current = true;
      setDiscardConfirmation(false);
      return;
    }
    if (formDirty) {
      discardPreviousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDiscardConfirmation(true);
      return;
    }
    closeForm();
  }, [closeForm, discardConfirmation, formDirty, saving]);

  const formDialogRef = useModalFocus<HTMLDivElement>(formOpen, requestCloseForm, nameInputRef, formOpenerRef);
  const deleteDialogRef = useModalFocus<HTMLDivElement>(deleteTarget !== null, () => setDeleteTarget(null), deleteCancelRef, deleteOpenerRef);
  // Restore after React has removed the deleted opener and mounted the empty-state
  // create button. A frame scheduled by the request may run before that commit.
  useEffect(() => {
    if (deleteTarget || !restoreDeletedTaskFocusRef.current) return;
    restoreDeletedTaskFocusRef.current = false;
    const opener = deleteOpenerRef.current;
    if (opener?.isConnected) opener.focus();
    else newAutomationRef.current?.focus();
  }, [deleteTarget, tasks]);
  const blockingSurfaceOpen = open && (formOpen || deleteTarget !== null);

  const projectLabel = (project: WorkbenchProject | undefined) =>
    project?.slug === STANDALONE_PROJECT_SLUG ? t("Sin proyecto") : project?.name ?? t("Sin proyecto");

  const taskProjectLabel = (task: AutomationTask) => {
    const project = projects.find((candidate) => candidate.id === task.projectId);
    return project?.slug === STANDALONE_PROJECT_SLUG || task.projectName.trim().toLocaleLowerCase("es") === "conversaciones"
      ? t("Sin proyecto")
      : task.projectName;
  };

  const refresh = useCallback(async (signal?: AbortSignal, silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
      setListError(null);
      setHistoryError(null);
    }
    try {
      const response = await fetch("/api/automations", { cache: "no-store", signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t("No se han podido cargar las automatizaciones."));
      if (signal?.aborted) return;
      setTasks(Array.isArray(body.tasks) ? body.tasks : []);
      setAudienceDirectory(body.audienceDirectory ?? emptyDirectory);
      setListError(null);
    } catch (cause) {
      if (!signal?.aborted) setListError(cause instanceof Error ? cause.message : t("No se han podido cargar las automatizaciones."));
    } finally {
      if (!silent && !signal?.aborted) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => refresh(controller.signal));
    return () => controller.abort();
  }, [open, refresh]);

  useEffect(() => {
    if (!open || formOpen || deleteTarget || saving) return;
    const controller = new AbortController();
    let polling = false;
    const poll = async () => {
      if (polling || document.visibilityState === "hidden" || controller.signal.aborted) return;
      polling = true;
      try {
        await refresh(controller.signal, true);
        if (historyTaskId && !controller.signal.aborted) {
          const response = await fetch(`/api/automations/${historyTaskId}/runs`, {
            cache: "no-store", signal: controller.signal,
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || t("No se ha podido leer el historial."));
          if (!controller.signal.aborted) {
            setRunsByTask((current) => ({ ...current, [historyTaskId]: Array.isArray(body.runs) ? body.runs : [] }));
            setHistoryError(null);
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted) setHistoryError(cause instanceof Error ? cause.message : t("No se ha podido leer el historial."));
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => { void poll(); }, 10_000);
    const onVisible = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [deleteTarget, formOpen, historyTaskId, open, refresh, saving, t]);

  useEffect(() => {
    if (!discardConfirmation && !restoreDraftFocusRef.current) return;
    const frame = requestAnimationFrame(() => {
      if (discardConfirmation) discardContinueRef.current?.focus();
      else if (formOpen) {
        restoreDraftFocusRef.current = false;
        discardPreviousFocusRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [discardConfirmation, formOpen]);

  useEffect(() => {
    if (!formDirty) return;
    const protectDraft = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectDraft);
    return () => window.removeEventListener("beforeunload", protectDraft);
  }, [formDirty]);

  useEffect(() => {
    reportBlockingSurface(blockingSurfaceOpen);
  }, [blockingSurfaceOpen, onBlockingSurfaceChange, reportBlockingSurface]);

  useEffect(() => () => reportBlockingSurface(false), [reportBlockingSurface]);

  const openForm = (task: AutomationTaskView | null, opener: HTMLElement) => {
    const nextDraft: AutomationDraft = {
      name: task?.name ?? "",
      prompt: task?.prompt ?? "",
      projectId: task?.projectId ?? availableProjects[0]?.id ?? "",
      kind: task?.schedule.kind === "external" ? "daily" : task?.schedule.kind ?? "daily",
      intervalMinutes: task?.schedule.kind === "interval" ? task.schedule.minutes : 120,
      intervalAnchorAt: task?.schedule.kind === "interval" ? task.schedule.anchorAt : null,
      monthlyDay: task?.schedule.kind === "monthly" ? task.schedule.day : 2,
      recurrenceStartAt: task && "startAt" in task.schedule && task.schedule.startAt ? localInput(task.schedule.startAt,task.timeZone) : "",
      monthlyMonths: task?.schedule.kind === "monthly" ? task.schedule.months : Array.from({length:12},(_,i)=>i+1),
      timeZone: task?.timeZone ?? "Europe/Madrid",
      time: scheduleTime(task),
      onceAt: localInput(task?.schedule.kind === "once" ? task.schedule.runAt : null, task?.timeZone ?? "Europe/Madrid"),
      fortnightly: task?.schedule.kind === "weekly" && task.schedule.intervalWeeks === 2,
      selectedWeekdays: task?.schedule.kind === "weekly" ? task.schedule.weekdays : [1],
      audienceUserIds: task?.audience.userIds ?? (audienceDirectory.currentUserId ? [audienceDirectory.currentUserId] : []),
      audienceGroupIds: task?.audience.groupIds ?? [],
    };
    formOpenerRef.current = opener;
    formOpenedFromNewRef.current = task === null;
    reportBlockingSurface(true);
    setEditing(task);
    setName(nextDraft.name);
    setPrompt(nextDraft.prompt);
    setProjectId(nextDraft.projectId);
    setKind(nextDraft.kind);
    setIntervalMinutes(nextDraft.intervalMinutes);
    setIntervalAnchorAt(nextDraft.intervalAnchorAt);
    setMonthlyDay(nextDraft.monthlyDay);
    setRecurrenceStartAt(nextDraft.recurrenceStartAt);
    setMonthlyMonths(nextDraft.monthlyMonths);
    setTimeZone(nextDraft.timeZone);
    setTime(nextDraft.time);
    setOnceAt(nextDraft.onceAt);
    setSelectedWeekdays(nextDraft.selectedWeekdays);
    setFortnightly(nextDraft.fortnightly);
    setAudienceUserIds(nextDraft.audienceUserIds);
    setAudienceGroupIds(nextDraft.audienceGroupIds);
    setBaselineDraft(draftSignature(nextDraft));
    setDiscardConfirmation(false);
    setError(null);
    setFormOpen(true);
  };

  const openResult = async (task: AutomationTaskView, threadId: string) => {
    // A missing sidebar entry is not an access decision. Ask the authenticated
    // project endpoint, then retain the narrower result viewer on denial.
    if (onOpenThread) {
      try {
        const authorized = projects.some(project => project.id === task.projectId)
          || (await getProjectRequest(task.projectId)).id === task.projectId;
        if (authorized) { onOpenThread(threadId); return; }
      } catch { /* Result access is checked independently by the thread endpoint. */ }
    }
    setResult({ taskId: task.id, threadId });
  };

  const initialCreateHandled = useRef(false);
  useEffect(() => {
    if (open && initialCreate && !loading && audienceDirectory.currentUserId && newAutomationRef.current && !initialCreateHandled.current) {
      initialCreateHandled.current = true;
      openForm(null, newAutomationRef.current);
    }
  });

  const schedule = (): AutomationSchedule => {
    const [hour, minute] = time.split(":").map(Number);
    if (kind === "once") {
      const [date, clock] = onceAt.split("T");
      const [year, month, day] = date.split("-").map(Number);
      const [onceHour, onceMinute] = clock.split(":").map(Number);
      return { kind, runAt: localMinuteToInstant({ year, month, day, hour: onceHour, minute: onceMinute }, timeZone).toISOString() };
    }
    let startAt: string | undefined;
    if (recurrenceStartAt) {
      const original = editing && "startAt" in editing.schedule ? editing.schedule.startAt : undefined;
      if (original && editing?.timeZone === timeZone && recurrenceStartAt === localInput(original,timeZone)) startAt = original;
      else { const [date,clock] = recurrenceStartAt.split("T"), [year,month,day] = date.split("-").map(Number), [startHour,startMinute] = clock.split(":").map(Number); startAt = localMinuteToInstant({year,month,day,hour:startHour,minute:startMinute},timeZone).toISOString(); }
    }
    if (kind === "interval") return { ...(editing?.schedule.kind === "interval" && editing.schedule.window ? {window: editing.schedule.window} : {}), kind, minutes: intervalMinutes, ...(startAt ? {startAt} : {}), anchorAt: intervalAnchorAt ?? new Date(Date.now() + intervalMinutes * 60_000).toISOString() };
    if (kind === "monthly") {
      return { kind, day: monthlyDay, months: monthlyMonths, hour, minute, ...(startAt ? {startAt} : {}) };
    }
    if (kind === "daily") return { kind, hour, minute, ...(startAt ? {startAt} : {}) };
    return { kind, weekdays: selectedWeekdays.toSorted(), hour, minute, ...(startAt ? {startAt} : {}), ...(fortnightly ? { intervalWeeks: 2 as const, anchorDate: editing?.schedule.kind === "weekly" && editing.schedule.anchorDate || localInput(null,timeZone).slice(0,10) } : {}) };
  };

  const save = async () => {
    if (!name.trim() || !prompt.trim() || !projectId || (kind === "weekly" && !selectedWeekdays.length) || (kind === "monthly" && !monthlyMonths.length) ||
      audienceUserIds.length + audienceGroupIds.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const selectedProject = availableProjects.find((project) => project.id === projectId);
      const response = await fetch(editing ? `/api/automations/${editing.id}` : "/api/automations", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          prompt,
          // An administrator can manage a task without being a member of its
          // owner's private project. Preserve that association on ordinary
          // edits; an actual project change still passes server validation.
          ...(!editing || editing.projectId !== projectId ? {
            projectId,
            projectName: projectLabel(selectedProject),
          } : {}),
          timeZone,
          schedule: schedule(),
          audience: { membershipPolicy: "current", userIds: audienceUserIds, groupIds: audienceGroupIds },
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t("No se ha podido guardar la automatización."));
      setTasks((current) => [body.task, ...current.filter((task) => task.id !== body.task.id)]);
      closeForm();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("No se ha podido guardar la automatización."));
    } finally {
      setSaving(false);
    }
  };

  const patchTask = async (task: AutomationTaskView, patch: object) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/automations/${task.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t("No se ha podido actualizar."));
      setTasks((current) => current.map((item) => item.id === task.id ? body.task : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("No se ha podido actualizar."));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async (task: AutomationTaskView) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/automations/${task.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t("No se ha podido poner en cola."));
      setTasks((current) => current.map((item) => item.id === task.id ? body.task : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("No se ha podido poner en cola."));
    } finally {
      setSaving(false);
    }
  };

  const toggleHistory = async (task: AutomationTaskView) => {
    if (historyTaskId === task.id) { setHistoryTaskId(null); setHistoryError(null); return; }
    setHistoryTaskId(task.id);
    try {
      const response = await fetch(`/api/automations/${task.id}/runs`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t("No se ha podido leer el historial."));
      setRunsByTask((current) => ({ ...current, [task.id]: Array.isArray(body.runs) ? body.runs : [] }));
      setHistoryError(null);
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : t("No se ha podido leer el historial."));
    }
  };

  const deleteTask = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/automations/${deleteTarget.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(t("No se ha podido eliminar."));
      restoreDeletedTaskFocusRef.current = true;
      setTasks((current) => current.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("No se ha podido eliminar."));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;
  return <main aria-labelledby="automations-title" className="automations-page automations-page-panel workspace-panel relative flex min-w-0 flex-1 flex-col bg-[var(--surface-raised)]">
      <header inert={formOpen || deleteTarget ? true : undefined} aria-hidden={formOpen || deleteTarget ? true : undefined} className="workspace-panel-header flex shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-2 md:px-5">
        <button type="button" aria-label={t("Mostrar u ocultar la barra lateral")} className="touch-target rounded-lg p-2 text-[var(--text-subtle)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] md:hidden" onClick={(event) => onToggleSidebar?.(event.currentTarget)}>
          <SidebarSimple size={17} />
        </button>
        <CalendarBlank size={19} />
        <div className="min-w-0 flex-1"><h2 id="automations-title" className="workspace-panel-title text-[var(--text)]">{t("Automatizaciones")}</h2></div>
        {tasks.length ? <button ref={bindNewAutomationButton} type="button" disabled={!availableProjects.length || !audienceDirectory.currentUserId} onClick={(event) => openForm(null, event.currentTarget)} className="touch-target inline-flex min-h-9 items-center gap-1.5 rounded-full bg-[var(--text)] px-3 text-[11px] font-semibold text-[var(--surface)] disabled:opacity-35"><Plus size={14} />{t("Nueva")}</button> : null}
      </header>

      <div inert={formOpen || deleteTarget ? true : undefined} aria-hidden={formOpen || deleteTarget ? true : undefined} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {error ? <p role="alert" className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[11px] text-[var(--danger)]">{t(error)}</p> : null}
        {loading ? <div className="flex min-h-44 items-center justify-center gap-2 text-[11px] text-[var(--text-subtle)]"><SpinnerGap size={15} className="motion-safe:animate-spin" />{t("Cargando automatizaciones…")}</div> : tasks.length ? <div className="space-y-2.5">{tasks.map((task) => <article key={task.id} className="rounded-[16px] border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--surface-muted)] text-[var(--text-secondary)]"><Clock size={16} /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-[13px] font-semibold text-[var(--text)]">{task.name}</h3><span className={`rounded-full px-2 py-0.5 text-[9px] font-semibold ${task.state === "active" ? "bg-[var(--positive-soft)] text-[var(--positive)]" : "bg-[var(--surface-muted)] text-[var(--text-muted)]"}`}>{task.state === "active" ? t("Activa") : task.state === "paused" ? t("En pausa") : t("Completada")}</span>{task.lease || task.manualRun ? <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[9px] font-semibold text-[var(--brain-accent-on-soft)]">{task.lease ? t("En curso") : t("Ejecución en cola")}</span> : null}</div><p className="mt-1 truncate text-[10px] text-[var(--text-subtle)]">{taskProjectLabel(task)} · {describeSchedule(task.schedule, task.timeZone, locale)} · {task.timeZone}</p></div></div>
          <p className="mt-3 line-clamp-2 text-[11px] leading-5 text-[var(--text-muted)]">{task.prompt}</p>
          <p className="mt-2 text-[10px] leading-4 text-[var(--text-subtle)]">{t("Propietario:")}{" "}{task.owner.name} {" "}{t("· Destinatarios:")}{" "}{audienceLabel(task, audienceDirectory, t)}</p>
          <dl className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-[var(--surface-muted)] px-3 py-2.5 text-[10px]"><div><dt className="text-[var(--text-subtle)]">{t("Próxima")}</dt><dd className="mt-0.5 font-medium text-[var(--text)]">{dateLabel(task.nextRunAt, task.timeZone, locale)}</dd></div><div><dt className="text-[var(--text-subtle)]">{t("Última")}</dt><dd className={`mt-0.5 font-medium ${task.lastRunStatus === "failed" ? "text-[var(--danger)]" : "text-[var(--text)]"}`}>{task.lastRunAt ? `${dateLabel(task.lastRunAt, task.timeZone, locale)}${task.lastRunStatus === "failed" ? t(" · Falló") : ""}` : t("Aún no ejecutada")}</dd></div></dl>
          {task.lastRunError ? <p className="mt-2 text-[10px] leading-4 text-[var(--danger)]">{task.lastRunError}</p> : null}
          {task.preparationBlock ? <p className="mt-2 text-[11px] text-[var(--text-muted)]">{task.preparationBlock}</p> : null}<div className="mt-3 flex flex-wrap justify-end gap-1"><button type="button" onClick={() => void toggleHistory(task)} className="touch-target min-h-9 rounded-lg px-2 text-[10px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">{t("Historial y resultados")}</button>{task.schedule.kind === "external" ? <a href="/automations/host-jobs" className="touch-target min-h-9 rounded-lg px-2 py-2 text-[10px] underline">{t("Autorización operativa")}</a> : null}{task.access.canManage ? <><button type="button" disabled={saving || Boolean(task.lease || task.manualRun) || Boolean(task.preparationBlock) || task.schedule.kind === "external"} onClick={() => void runNow(task)} className="touch-target min-h-9 rounded-lg px-2 text-[10px] font-semibold text-[var(--text)] hover:bg-[var(--surface-hover)] disabled:opacity-30">{t("Ejecutar ahora")}</button><button type="button" disabled={saving || task.state === "completed" || Boolean(task.preparationBlock)} onClick={() => void patchTask(task, { state: task.state === "active" ? "paused" : "active" })} aria-label={task.state === "active" ? t("Pausar {nombre}", { nombre: task.name }) : t("Reanudar {nombre}", { nombre: task.name })} className="touch-target grid size-9 place-items-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-30">{task.state === "active" ? <Pause size={14} /> : <Play size={14} />}</button><button type="button" disabled={saving || task.schedule.kind === "external"} onClick={(event) => openForm(task, event.currentTarget)} aria-label={t("Editar {p0}", { p0: task.name })} className="touch-target grid size-9 place-items-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"><PencilSimple size={14} /></button><button type="button" disabled={saving} onClick={(event) => { deleteOpenerRef.current = event.currentTarget; reportBlockingSurface(true); setError(null); setDeleteTarget(task); }} aria-label={t("Eliminar {p0}", { p0: task.name })} className="touch-target grid size-9 place-items-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"><Trash size={14} /></button></> : null}</div>
          {historyTaskId === task.id ? <div className="mt-3 space-y-2 rounded-xl bg-[var(--surface-muted)] p-3">{(runsByTask[task.id] ?? []).length ? (runsByTask[task.id] ?? []).slice(0, 8).map((run) => <div key={`${run.runKey}:${run.attempt}:${run.status}`} className="flex items-center gap-2 text-[10px]"><span className={run.status === "succeeded" ? "text-[var(--positive)]" : run.status === "failed" ? "text-[var(--danger)]" : "text-[var(--text-secondary)]"}>{run.status === "succeeded" ? t("Completada") : run.status === "failed" ? t("Con error") : run.status === "interrupted" ? t("Interrumpida") : t("En curso")}</span><time className="text-[var(--text-subtle)]">{dateLabel(run.finishedAt ?? run.startedAt, task.timeZone, locale)}</time>{run.threadId && task.access.canViewResults ? <button type="button" onClick={() => { void openResult(task, run.threadId!); }} className="ml-auto font-semibold text-[var(--brain-accent-on-soft)]">{t("Abrir resultado")}</button> : null}</div>) : <p className="text-[10px] text-[var(--text-subtle)]">{t("Aún no hay ejecuciones registradas.")}</p>}</div> : null}
          {historyTaskId === task.id && result?.taskId === task.id ? <AutomationResult key={result.threadId} threadId={result.threadId} onClose={() => setResult(null)} /> : null}
        </article>)}</div> : <div className="grid min-h-64 place-items-center px-8 text-center"><div className="workspace-empty-state"><span className="mx-auto grid size-12 place-items-center rounded-2xl bg-[var(--surface-muted)] text-[var(--text-subtle)]"><CalendarBlank size={21} /></span><p className="mt-3 text-[13px] font-semibold text-[var(--text)]">{t("Aún no hay automatizaciones")}</p><p className="mt-1 text-[11px] leading-5 text-[var(--text-subtle)]">{t("Programa trabajo recurrente en un proyecto o Sin proyecto.")}</p><button ref={bindNewAutomationButton} type="button" disabled={!availableProjects.length || !audienceDirectory.currentUserId} onClick={(event) => openForm(null, event.currentTarget)} className="touch-target mx-auto mt-5 inline-flex min-h-10 items-center gap-1.5 rounded-full bg-[var(--text)] px-4 text-[11px] font-semibold text-[var(--surface)] disabled:opacity-35"><Plus size={14} />{t("Nueva")}</button></div></div>}
      </div>

      {formOpen ? <div ref={formDialogRef} role="dialog" aria-modal="true" aria-labelledby="automation-form-title" aria-describedby="automation-form-description" tabIndex={-1} className="fixed inset-0 z-50 flex flex-col bg-[var(--surface-raised)] outline-none">
        <header inert={discardConfirmation ? true : undefined} aria-hidden={discardConfirmation ? true : undefined} className="flex min-h-16 items-center border-b border-[var(--border-subtle)] px-5"><button type="button" onClick={requestCloseForm} className="touch-target mr-3 min-h-9 rounded-lg px-2 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">{t("Cancelar")}</button><h3 id="automation-form-title" className="flex-1 text-[14px] font-semibold text-[var(--text)]">{editing ? t("Editar automatización") : t("Nueva automatización")}</h3><button type="button" disabled={saving || !name.trim() || !prompt.trim() || !projectId || (kind === "weekly" && !selectedWeekdays.length) || (kind === "monthly" && !monthlyMonths.length) || audienceUserIds.length + audienceGroupIds.length === 0} onClick={() => void save()} className="touch-target min-h-9 rounded-full bg-[var(--text)] px-4 text-[11px] font-semibold text-[var(--surface)] disabled:opacity-35">{saving ? t("Guardando…") : t("Guardar")}</button></header>
        <form inert={discardConfirmation ? true : undefined} aria-hidden={discardConfirmation ? true : undefined} className="scrollbar-thin min-h-0 flex-1 space-y-5 overflow-y-auto p-5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          {error ? <p role="alert" className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[11px] text-[var(--danger)]">{t(error)}</p> : null}
          <label className="block text-[11px] font-semibold text-[var(--text)]">{t("Nombre")}<input ref={nameInputRef} value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder={t("Resumen diario del proyecto")} className="mt-2 h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-normal outline-none focus:border-[var(--brain-accent)]" /></label>
          <label className="block text-[11px] font-semibold text-[var(--text)]">{t("Qué debe hacer")}<textarea value={prompt} maxLength={20_000} rows={6} onChange={(event) => setPrompt(event.target.value)} placeholder={t("Revisa las novedades del proyecto y prepara un resumen con próximos pasos.")} className="mt-2 w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-3 text-[13px] font-normal leading-5 outline-none focus:border-[var(--brain-accent)]" /></label>
          <label className="block text-[11px] font-semibold text-[var(--text)]">{t("Proyecto")}<select value={projectId} onChange={(event) => setProjectId(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-normal outline-none">{editing && !availableProjects.some((project) => project.id === editing.projectId) && <option value={editing.projectId}>{taskProjectLabel(editing)}</option>}{availableProjects.map((project) => <option key={project.id} value={project.id}>{projectLabel(project)}</option>)}</select></label>
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5"><p className="text-[11px] font-semibold text-[var(--text)]">{t("Propietario único")}</p><p className="mt-1 text-[10px] leading-4 text-[var(--text-subtle)]">{editing?.owner.name ?? audienceDirectory.users.find((user) => user.id === audienceDirectory.currentUserId)?.name ?? t("Tu usuario")}{t(". Solo esta persona o un administrador puede editar o eliminar. El propietario no se añade automáticamente como destinatario.")}</p></section>
          <fieldset><legend className="text-[11px] font-semibold text-[var(--text)]">{t("Quién recibe el resultado")}</legend><div className="mt-2 space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
            <div><p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">{t("Personas")}</p><div className="mt-2 grid gap-2">{audienceDirectory.users.map((user) => <label key={user.id} className="flex items-center gap-2 text-[11px] font-normal text-[var(--text)]"><input type="checkbox" checked={audienceUserIds.includes(user.id)} onChange={() => setAudienceUserIds((current) => current.includes(user.id) ? current.filter((id) => id !== user.id) : [...current, user.id])} />{user.name}</label>)}</div></div>
            {audienceDirectory.groups.length ? <div><p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">{t("Grupos")}</p><div className="mt-2 grid gap-2">{audienceDirectory.groups.map((group) => <label key={group.id} className="flex items-center gap-2 text-[11px] font-normal text-[var(--text)]"><input type="checkbox" checked={audienceGroupIds.includes(group.id)} onChange={() => setAudienceGroupIds((current) => current.includes(group.id) ? current.filter((id) => id !== group.id) : [...current, group.id])} />{group.name}</label>)}</div></div> : null}
            <p className="text-[10px] leading-4 text-[var(--text-subtle)]">{t("La audiencia y pertenencia actuales se comprueban al abrir cualquier resultado, también los anteriores. Si alguien sale del grupo o se desactiva, pierde el acceso.")}</p>
          </div></fieldset>
          <fieldset><legend className="text-[11px] font-semibold text-[var(--text)]">{t("Frecuencia")}</legend><div className="mt-2 flex gap-1 rounded-xl bg-[var(--surface-muted)] p-1">{(["once", "interval", "daily", "weekly", "monthly"] as const).map((option) => <button key={option} type="button" aria-pressed={kind === option} onClick={() => setKind(option)} className={`touch-target min-h-9 flex-1 rounded-lg text-[11px] font-medium ${kind === option ? "bg-[var(--surface-raised)] text-[var(--text)] shadow-[var(--shadow-sm)]" : "text-[var(--text-muted)]"}`}>{option === "once" ? t("Una vez") : option === "interval" ? t("Por intervalo") : option === "daily" ? t("Cada día") : option === "monthly" ? t("Mensual") : t("Semanal")}</button>)}</div></fieldset>
          {kind !== "once" ? <label className="block text-[11px] font-semibold text-[var(--text)]">{t("Primera fecha, opcional")}<input type="datetime-local" value={recurrenceStartAt} onChange={event=>setRecurrenceStartAt(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3" /></label> : null}
          {kind === "monthly" ? <fieldset><legend className="text-[11px] font-semibold text-[var(--text)]">{t("Día y meses")}</legend><input aria-label={t("Día del mes")} type="number" min={1} max={31} value={monthlyDay} onChange={event=>setMonthlyDay(Number(event.target.value))} className="mt-2 h-11 w-20 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3" /><div className="mt-2 flex flex-wrap gap-1">{Array.from({length:12},(_,i)=>i+1).map(month=><button type="button" key={month} aria-pressed={monthlyMonths.includes(month)} onClick={()=>setMonthlyMonths(current=>current.includes(month)?current.filter(m=>m!==month):[...current,month].sort((a,b)=>a-b))} className={`touch-target size-9 rounded-full text-xs ${monthlyMonths.includes(month)?"bg-[var(--text)] text-[var(--surface)]":"bg-[var(--surface-muted)]"}`}>{new Intl.DateTimeFormat(locale,{month:"short"}).format(new Date(Date.UTC(2026,month-1,1)))}</button>)}</div></fieldset> : null}
          {kind === "weekly" ? <label className="flex gap-2 text-sm"><input type="checkbox" checked={fortnightly} onChange={event=>setFortnightly(event.target.checked)} />{t("Cada dos semanas")}</label> : null}
          {kind === "weekly" ? <fieldset><legend className="text-[11px] font-semibold text-[var(--text)]">{t("Días")}</legend><div className="mt-2 flex gap-1.5">{weekdays.map((label, day) => <button key={day} type="button" aria-pressed={selectedWeekdays.includes(day)} onClick={() => setSelectedWeekdays((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day])} className={`touch-target grid size-9 place-items-center rounded-full text-[10px] font-semibold ${selectedWeekdays.includes(day) ? "bg-[var(--text)] text-[var(--surface)]" : "bg-[var(--surface-muted)] text-[var(--text-muted)]"}`}>{label}</button>)}</div></fieldset> : null}
          {kind === "interval" ? <label className="block text-[11px] font-semibold text-[var(--text)]">{t("Intervalo en minutos")}<input type="number" min={30} max={10080} step={1} value={intervalMinutes} onChange={event => setIntervalMinutes(Number(event.target.value))} className="mt-2 h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-normal" /><span className="mt-1 block text-[11px] font-normal text-[var(--text-subtle)]">{t("La primera ejecución será dentro del intervalo seleccionado.")}</span></label> : kind === "once" ? <div className="grid grid-cols-2 gap-3"><label className="block text-[11px] font-semibold text-[var(--text)]">{t("Fecha")}<input type="date" value={onceAt.split("T")[0] ?? ""} onChange={(event) => setOnceAt(`${event.target.value}T${onceAt.split("T")[1] ?? "09:00"}`)} className="mt-2 h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-normal" /></label><label className="block text-[11px] font-semibold text-[var(--text)]">{t("Hora")}<input type="time" value={onceAt.split("T")[1] ?? "09:00"} onChange={(event) => setOnceAt(`${onceAt.split("T")[0] ?? ""}T${event.target.value}`)} className="mt-2 h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-normal" /></label></div> : <label className="block text-[11px] font-semibold text-[var(--text)]">{t("Hora")}<input type="time" value={time} onChange={(event) => setTime(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-normal" /></label>}
          <label className="block text-[11px] font-semibold text-[var(--text)]">{t("Zona horaria")}<select value={timeZone} onChange={(event) => setTimeZone(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-normal">{AUTOMATION_TIME_ZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></label>
          <p id="automation-form-description" className="rounded-xl bg-[var(--surface-muted)] px-3 py-2.5 text-[10px] leading-4 text-[var(--text-muted)]">{t("La tarea crea una conversación en el proyecto y ejecuta este prompt. Las acciones sensibles solo se ejecutan con autorización durable previa; el worker no espera aprobaciones interactivas. No envía mensajes externos por sí sola.")}</p>
        </form>

        {discardConfirmation ? <div className="absolute inset-0 z-10 grid place-items-center bg-[var(--overlay)] p-5 backdrop-blur-[2px]"><div role="alertdialog" aria-modal="true" aria-labelledby="discard-automation-title" aria-describedby="discard-automation-description" className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface-raised)] p-5 shadow-[var(--shadow-lg)]"><h4 id="discard-automation-title" className="text-[14px] font-semibold text-[var(--text)]">{t("¿Descartar los cambios?")}</h4><p id="discard-automation-description" className="mt-2 text-[11px] leading-5 text-[var(--text-muted)]">{t("La automatización tiene cambios sin guardar. Si sales ahora, se perderán.")}</p><div className="mt-5 flex justify-end gap-2"><button ref={discardContinueRef} type="button" onClick={() => { restoreDraftFocusRef.current = true; setDiscardConfirmation(false); }} className="touch-target min-h-10 rounded-lg px-3 text-[11px] font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">{t("Seguir editando")}</button><button type="button" onClick={closeForm} className="touch-target min-h-10 rounded-lg bg-[var(--danger)] px-3 text-[11px] font-semibold text-white">{t("Descartar cambios")}</button></div></div></div> : null}
      </div> : null}

      {deleteTarget ? <div className="fixed inset-0 z-[60] grid place-items-center bg-[var(--overlay)] p-5 backdrop-blur-[2px]"><div ref={deleteDialogRef} role="alertdialog" aria-modal="true" aria-labelledby="delete-automation-title" aria-describedby="delete-automation-description" tabIndex={-1} className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface-raised)] p-5 shadow-[var(--shadow-lg)] outline-none"><h3 id="delete-automation-title" className="text-[14px] font-semibold text-[var(--text)]">{t("¿Eliminar “")}{deleteTarget.name}”?</h3><p id="delete-automation-description" className="mt-2 text-[11px] leading-5 text-[var(--text-muted)]">{t("La programación se eliminará. El historial de ejecuciones se conservará.")}</p>{error ? <p role="alert" className="mt-3 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[11px] text-[var(--danger)]">{t(error)}</p> : null}<div className="mt-5 flex justify-end gap-2"><button ref={deleteCancelRef} type="button" disabled={saving} onClick={() => setDeleteTarget(null)} className="touch-target min-h-10 rounded-lg px-3 text-[11px] font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-40">{t("Cancelar")}</button><button type="button" disabled={saving} onClick={() => void deleteTask()} className="touch-target min-h-10 rounded-lg bg-[var(--danger)] px-3 text-[11px] font-semibold text-white disabled:opacity-40">{saving ? t("Eliminando…") : t("Eliminar automatización")}</button></div></div></div> : null}
  </main>;
}
