"use client";

import { useCallback, useSyncExternalStore } from "react";

const eventName = "arnall-sidebar-disclosure";
const fallback = new Map<string, string>();
function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(eventName, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(eventName, listener);
  };
}

/** Presentation preferences only; never contains conversation content. */
export function useSidebarDisclosure(scope: string) {
  const key = `aibrain:sidebar:v1:${scope}`;
  const read = useCallback(() => {
    try { return window.localStorage.getItem(key) ?? "{}"; }
    catch { return fallback.get(key) ?? "{}"; }
  }, [key]);
  const raw = useSyncExternalStore(subscribe, read, () => "{}");
  let values: Record<string, boolean> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      values = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "boolean"));
    }
  } catch { /* Ignore malformed browser preferences. */ }
  const setOpen = (id: string, open: boolean) => {
    const next = JSON.stringify({ ...values, [id]: open });
    fallback.set(key, next);
    try { window.localStorage.setItem(key, next); } catch { /* In-memory fallback. */ }
    window.dispatchEvent(new Event(eventName));
  };
  return { isOpen: (id: string, initial: boolean) => values[id] ?? initial, setOpen };
}
