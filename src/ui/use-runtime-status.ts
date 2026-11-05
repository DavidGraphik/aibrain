"use client";
import { useEffect, useState } from "react";
import { initialRuntimeStatus, isRuntimeStatus, type RuntimeStatus } from "@/lib/runtime-status";

export function useRuntimeStatus({ hydrated, online, projectId, retry }: {
  hydrated: boolean; online: boolean; projectId: string | null; retry: number;
}) {
  const requestKey = JSON.stringify([projectId, online, retry]);
  const [state, setState] = useState({ key: "", status: initialRuntimeStatus });
  const runtimeStatus = state.key === requestKey ? state.status : { ...state.status, codex: "checking" as const, ready: false };
  useEffect(() => {
    if (!hydrated || !online) return;
    const setRuntimeStatus = (update: RuntimeStatus | ((status: RuntimeStatus) => RuntimeStatus)) => {
      setState(previous => ({ key: requestKey, status: typeof update === "function" ? update(previous.status) : update }));
    };
    let controller: AbortController | null = null;
    let disposed = false;
    let retryTimer: number | undefined;
    let timeout: number | undefined;
    let inFlight = false;
    const foreground = () => document.visibilityState !== "hidden";
    const unavailable = () => setRuntimeStatus(current => ({ ...current, codex: "unavailable", ready: false, authenticationRequired: false }));
    const probe = (attempt: number) => {
      if (disposed || inFlight || !foreground()) return;
      inFlight = true;
      const currentController = new AbortController();
      controller = currentController;
      let expired = false;
      const scheduleRetry = () => {
        if (disposed || retryTimer !== undefined) return;
        retryTimer = window.setTimeout(() => {
          retryTimer = undefined;
          if (!disposed && navigator.onLine && foreground()) probe(attempt + 1);
        }, Math.min(120_000, attempt < 2 ? 2_000 * 2 ** attempt : 30_000 * 2 ** Math.min(attempt - 2, 2)));
      };
      const currentTimeout = window.setTimeout(() => {
        if (disposed) return;
        expired = true;
        unavailable();
        currentController.abort();
        // A stalled transport may never settle after abort. Release only this
        // probe's slot so recovery does not depend on its rejected promise.
        if (controller === currentController) inFlight = false;
        scheduleRetry();
      }, 40_000);
      timeout = currentTimeout;
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      void fetch(`/api/runtime/status${query}`, { signal: currentController.signal, cache: "no-store" })
        .then(response => response.ok ? response.json() : null)
        .then((status: unknown) => {
          if (disposed || expired) return;
          if (isRuntimeStatus(status) && status.codex !== "checking") {
            setRuntimeStatus(status);
            if (status.mode === "codex" && !status.ready) scheduleRetry();
          } else { unavailable(); scheduleRetry(); }
        })
        .catch(() => { if (!disposed && !expired) { unavailable(); scheduleRetry(); } })
        .finally(() => {
          window.clearTimeout(currentTimeout);
          if (controller === currentController) inFlight = false;
        });
    };
    // Recovery is observation only: no task, credential refresh or user effect.
    // Leave an honest unavailable state while one coalesced foreground probe
    // backs off to at most one request per two minutes. Hidden/offline pages
    // stop probing, and returning to the app checks again without a reload.
    const resume = () => {
      if (disposed || inFlight || !navigator.onLine || !foreground()) return;
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
      probe(0);
    };
    const visibility = () => {
      if (foreground()) resume();
      else { window.clearTimeout(retryTimer); retryTimer = undefined; }
    };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", visibility);
    probe(0);
    return () => {
      disposed = true;
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", visibility);
      window.clearTimeout(timeout);
      window.clearTimeout(retryTimer);
      controller?.abort();
    };
  }, [projectId, hydrated, online, retry, requestKey]);

  return online ? runtimeStatus : { ...runtimeStatus, codex: "unavailable" as const, ready: false };
}
