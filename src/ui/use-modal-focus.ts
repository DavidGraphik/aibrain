"use client";

import { useEffect, useRef, type RefObject } from "react";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "audio[controls]",
  "video[controls]",
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function isHiddenFromFocus(element: HTMLElement, container: HTMLElement) {
  let current: HTMLElement | null = element;
  while (current && container.contains(current)) {
    if (
      current.hidden ||
      current.hasAttribute("inert") ||
      current.getAttribute("aria-hidden") === "true"
    ) {
      return true;
    }
    if (current instanceof HTMLDetailsElement && !current.open) {
      const summary = current.querySelector<HTMLElement>(":scope > summary");
      if (!summary?.contains(element)) return true;
    }
    const style = window.getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.contentVisibility === "hidden"
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector))
    .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && !isHiddenFromFocus(element, container));
}

export function useModalFocus<ElementType extends HTMLElement = HTMLElement>(
  open: boolean,
  onClose: () => void,
  initialFocus?: RefObject<HTMLElement | null>,
  returnFocus?: RefObject<HTMLElement | null>,
) {
  const containerRef = useRef<ElementType | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const explicitReturnTarget = returnFocus?.current ?? null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;
      const requestedInitialFocus = initialFocus?.current;
      const target = requestedInitialFocus && container.contains(requestedInitialFocus) && !isHiddenFromFocus(requestedInitialFocus, container)
        ? requestedInitialFocus
        : focusableElements(container)[0] ?? container;
      target.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      const container = containerRef.current;
      if (!container) return;
      if (event.key === "Escape") {
        if (event.target instanceof Element && event.target.closest('[role="menu"]')) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(container);
      if (!focusable.length) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!container.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      const returnTarget = [explicitReturnTarget, previous].find((candidate) =>
        candidate?.isConnected && !isHiddenFromFocus(candidate, document.body));
      returnTarget?.focus();
    };
  }, [initialFocus, open, returnFocus]);

  return containerRef;
}
