"use client";

import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { isHiddenFromFocus } from "@/ui/use-modal-focus";

const menuItemSelector = [
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
].join(",");

function enabledMenuItems(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(menuItemSelector))
    .filter((item) => !item.matches(":disabled") && item.getAttribute("aria-disabled") !== "true");
}

function itemLabel(item: HTMLElement) {
  return (item.getAttribute("aria-label") || item.textContent || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es");
}

function adjacentTabStop(menu: HTMLElement, backwards: boolean) {
  const selector = [
    "a[href]",
    "button:not(:disabled)",
    "input:not(:disabled)",
    "select:not(:disabled)",
    "textarea:not(:disabled)",
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector))
    .filter((candidate) => !menu.contains(candidate) && !isHiddenFromFocus(candidate, document.body));
  const relation = backwards ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
  const ordered = backwards ? candidates.reverse() : candidates;
  return ordered.find((candidate) => Boolean(menu.compareDocumentPosition(candidate) & relation)) ?? null;
}

/** Keyboard behavior shared by app menus without imposing a visual primitive. */
export function useMenuKeyboardNavigation(onClose?: () => void) {
  const typeaheadRef = useRef({ query: "", at: 0 });

  return useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === "Escape" && onClose) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Tab" && onClose) {
      const target = adjacentTabStop(event.currentTarget, event.shiftKey);
      event.preventDefault();
      onClose();
      requestAnimationFrame(() => target?.focus());
      return;
    }

    const items = enabledMenuItems(event.currentTarget);
    if (!items.length) return;
    const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
    let targetIndex: number | null = null;

    if (event.key === "ArrowDown") targetIndex = (currentIndex + 1) % items.length;
    else if (event.key === "ArrowUp") targetIndex = (currentIndex - 1 + items.length) % items.length;
    else if (event.key === "Home") targetIndex = 0;
    else if (event.key === "End") targetIndex = items.length - 1;
    else if (
      event.key.length === 1 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const now = Date.now();
      const normalizedKey = event.key.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es");
      const previous = now - typeaheadRef.current.at < 600 ? typeaheadRef.current.query : "";
      const query = `${previous}${normalizedKey}`;
      typeaheadRef.current = { query, at: now };
      const ordered = [...items.slice(currentIndex + 1), ...items.slice(0, currentIndex + 1)];
      const match = ordered.find((item) => itemLabel(item).startsWith(query))
        ?? ordered.find((item) => itemLabel(item).startsWith(normalizedKey));
      if (match) targetIndex = items.indexOf(match);
    }

    if (targetIndex === null) return;
    event.preventDefault();
    items[targetIndex]?.focus();
  }, [onClose]);
}
