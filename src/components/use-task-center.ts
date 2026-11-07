"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useUiText } from "@/i18n/provider";
import type { WorkbenchProject, WorkbenchSnapshot, WorkbenchThread } from "@/workbench/types";
import {
  DEFAULT_TASK_NOTIFICATION_PREFERENCES,
  deriveTaskCenterItems,
  isTaskCenterPayload,
  type TaskCenterItem,
  type TaskCenterPayload,
} from "@/task-center/contracts";

export type TaskCenterNotice = Readonly<{
  message: string;
  kind: "status" | "success" | "warning" | "error";
}>;
const workbenchNotice = (message: string, kind: TaskCenterNotice["kind"]): TaskCenterNotice => ({ message, kind });

export function createTaskCenterResponseGate() {
  let generation = 0;
  let activeMutations = 0;
  let activePoll: number | null = null;
  return {
    beginPoll() {
      if (activeMutations > 0 || activePoll !== null) return null;
      generation += 1;
      activePoll = generation;
      return generation;
    },
    finishPoll(candidate: number) {
      if (activePoll === candidate) activePoll = null;
    },
    beginMutation() {
      activeMutations += 1;
      generation += 1;
      return generation;
    },
    finishMutation() {
      activeMutations = Math.max(0, activeMutations - 1);
      return activeMutations;
    },
    hasMutation() {
      return activeMutations > 0;
    },
    isCurrent(candidate: number) {
      return candidate === generation;
    },
  };
}

function loadTaskCenterCache(key: string): TaskCenterPayload {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (isTaskCenterPayload(value)) return value;
  } catch {
    // Invalid browser-preview state is replaced by the empty safe default.
  }
  return {
    tasks: [],
    readTaskIds: [],
    preferences: DEFAULT_TASK_NOTIFICATION_PREFERENCES,
    continuity: "worker_required",
  };
}

async function requestTaskCenter(init: RequestInit, failureMessage: string): Promise<TaskCenterPayload> {
  const response = await fetch("/api/task-center", init);
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok || !isTaskCenterPayload(value)) throw new Error(failureMessage);
  return value;
}

type TaskCenterOptions = {
  hydrated: boolean;
  persistence: WorkbenchSnapshot["persistence"];
  projects: WorkbenchProject[];
  threads: WorkbenchThread[];
  cacheKey: string;
  productName: string;
  selection: RefObject<{ threadId: string | null }>;
  open: boolean;
  requestOpen: (requested: boolean) => void;
  onNotice: (notice: TaskCenterNotice) => void;
};

/** Owns task synchronization. Navigation, dialogs and conversation state stay with the workbench. */
export function useTaskCenter({
  hydrated, persistence, projects, threads, cacheKey: taskCenterKey, productName,
  selection: activeSelectionRef, open: taskCenterOpen,
  requestOpen: setTaskCenterRequested, onNotice: setNotice,
}: TaskCenterOptions) {
  const t = useUiText();
  const [taskCenterPayload, setTaskCenterPayload] = useState<TaskCenterPayload>({
    tasks: [], readTaskIds: [], preferences: DEFAULT_TASK_NOTIFICATION_PREFERENCES, continuity: "worker_required",
  });
  const [taskCenterBusy, setTaskCenterBusy] = useState(false);
  const taskCenterGateRef = useRef(createTaskCenterResponseGate());
  const taskCenterOpenRef = useRef(taskCenterOpen);
  const taskStatusRef = useRef(new Map<string, TaskCenterItem["status"]>());
  const taskCenterInitializedRef = useRef(false);

  useEffect(() => { taskCenterOpenRef.current = taskCenterOpen; }, [taskCenterOpen]);

  const restorePreview = useCallback(() => {
    setTaskCenterPayload(loadTaskCenterCache(taskCenterKey));
  }, [taskCenterKey]);

  const taskCenterItems = useMemo(() => {
    const local = deriveTaskCenterItems({ projects, threads }, taskCenterPayload.readTaskIds);
    const merged = persistence === "browser-preview"
      ? new Map(taskCenterPayload.tasks.map((task) => [task.id, task]))
      : new Map(local.map((task) => [task.id, task]));
    for (const task of persistence === "browser-preview" ? local : taskCenterPayload.tasks) {
      merged.set(task.id, task);
    }
    return [...merged.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
  }, [persistence, projects, taskCenterPayload.readTaskIds, taskCenterPayload.tasks, threads]);
  const taskSummary = useMemo(() => ({
    unread: taskCenterItems.filter((task) => task.unread).length,
    running: taskCenterItems.filter((task) => task.status === "running").length,
    needsAttention: taskCenterItems.filter((task) => task.status === "needs_attention").length,
  }), [taskCenterItems]);

  const applyTaskCenterPayload = useCallback((payload: TaskCenterPayload, notify = true) => {
    const previous = taskStatusRef.current;
    const shouldNotify = taskCenterInitializedRef.current && notify;
    const fresh = shouldNotify ? payload.tasks.filter((task) => {
      if (!task.unread || task.threadId === activeSelectionRef.current.threadId) return false;
      const prior = previous.get(task.id);
      return prior === "running" || (prior === undefined && task.status !== "running");
    }) : [];
    taskStatusRef.current = new Map(payload.tasks.map((task) => [task.id, task.status]));
    taskCenterInitializedRef.current = true;
    setTaskCenterPayload(payload);

    const newest = fresh[0];
    if (!newest) return;
    if (payload.preferences.inApp) {
      setNotice(workbenchNotice(newest.status === "needs_attention"
        ? t("Una tarea necesita tu atención: {p0}", { p0: newest.threadTitle })
        : newest.status === "completed"
          ? `Tarea completada: ${newest.threadTitle}`
          : t("Una tarea ha terminado con error: {p0}", { p0: newest.threadTitle }),
        newest.status === "completed" ? "success" : newest.status === "failed" ? "error" : "warning"));
    }
    if (payload.preferences.desktop && typeof Notification !== "undefined" && Notification.permission === "granted") {
      const notification = new Notification(
        newest.status === "needs_attention" ? t("{p0} necesita tu atención", { p0: productName }) :
          newest.status === "completed" ? t("{p0} ha terminado una tarea", { p0: productName }) : t("Una tarea de {p0} ha fallado", { p0: productName }),
        { body: newest.threadTitle, tag: newest.id },
      );
      notification.onclick = () => {
        window.focus();
        setTaskCenterRequested(!taskCenterOpenRef.current);
        notification.close();
      };
    }
  }, [activeSelectionRef, productName, setNotice, setTaskCenterRequested, t]);

  const refreshTaskCenter = useCallback(async (notify = true) => {
    const requestGeneration = taskCenterGateRef.current.beginPoll();
    if (requestGeneration === null) return null;
    try {
      const value = await requestTaskCenter({ cache: "no-store" }, t("No se ha podido actualizar el centro de tareas."));
      if (!taskCenterGateRef.current.isCurrent(requestGeneration)) return value;
      applyTaskCenterPayload(value, notify);
      return value;
    } finally {
      taskCenterGateRef.current.finishPoll(requestGeneration);
    }
  }, [applyTaskCenterPayload, t]);

  const mutateTaskCenter = useCallback(async (body: unknown) => {
    const requestGeneration = taskCenterGateRef.current.beginMutation();
    setTaskCenterBusy(true);
    try {
      const value = await requestTaskCenter({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, t("No se ha podido guardar el centro de tareas."));
      if (!taskCenterGateRef.current.isCurrent(requestGeneration)) return;
      applyTaskCenterPayload(value, false);
    } catch (error) {
      setNotice(workbenchNotice(error instanceof Error ? error.message : t("No se ha podido guardar el centro de tareas."), "error"));
    } finally {
      setTaskCenterBusy(taskCenterGateRef.current.finishMutation() > 0);
    }
  }, [applyTaskCenterPayload, setNotice, t]);

  useEffect(() => {
    if (!hydrated || persistence === "browser-preview") return;
    void refreshTaskCenter(false).catch(() => {
      setNotice(workbenchNotice(t("El historial de tareas no se ha podido sincronizar. Tus conversaciones siguen disponibles."), "warning"));
    });
  }, [hydrated, persistence, refreshTaskCenter, setNotice, t]);

  useEffect(() => {
    if (!hydrated || persistence !== "browser-preview") return;
    taskStatusRef.current = new Map(taskCenterItems.map((task) => [task.id, task.status]));
    taskCenterInitializedRef.current = true;
  }, [hydrated, persistence, taskCenterItems]);

  useEffect(() => {
    if (!hydrated || persistence === "browser-preview") return;
    const refresh = () => void refreshTaskCenter(true).catch(() => undefined);
    const interval = window.setInterval(refresh, taskSummary.running ? 5_000 : 30_000);
    const onVisibility = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [hydrated, persistence, refreshTaskCenter, taskSummary.running]);

  useEffect(() => {
    if (!hydrated || persistence !== "browser-preview") return;
    try {
      localStorage.setItem(taskCenterKey, JSON.stringify({ ...taskCenterPayload, tasks: taskCenterItems }));
    } catch {
      // This cache is optional preview state, never the server task record.
      // Full or blocked browser storage must not interrupt the workbench.
    }
  }, [hydrated, persistence, taskCenterItems, taskCenterKey, taskCenterPayload]);

  return {
    payload: taskCenterPayload,
    items: taskCenterItems,
    summary: taskSummary,
    busy: taskCenterBusy,
    mutate: mutateTaskCenter,
    restorePreview,
  };
}
