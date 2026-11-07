"use client";

import { useEffect } from "react";

export const TASK_CENTER_SHORTCUT_ARIA = "Meta+Alt+U Control+Alt+U";

export function isTaskCenterShortcut(event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "metaKey">) {
  return (event.metaKey || event.ctrlKey) && event.altKey && event.code === "KeyU";
}

export function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

export function useTaskCenterShortcut(onToggle: () => void, enabled = true) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!enabled || !isTaskCenterShortcut(event) || isEditableShortcutTarget(event.target)) return;
      event.preventDefault();
      onToggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, onToggle]);
}
