"use client";

import { useLayoutEffect, type RefObject } from "react";

/** Keep existing composer menus inside the visible screen, including keyboards. */
export function useMenuViewport(menuRef: RefObject<HTMLElement | null>, open: boolean, placement: "above" | "below") {
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const menu = menuRef.current;
      const anchor = menu?.offsetParent;
      if (!menu || !(anchor instanceof HTMLElement)) return;
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const bottom = top + (viewport?.height ?? window.innerHeight);
      const bounds = anchor.getBoundingClientRect();
      const above = Math.max(0, bounds.top - top - 20);
      const below = Math.max(0, bottom - bounds.bottom - 20);
      const height = menu.scrollHeight;
      const preferAbove = placement === "above";
      const up = (preferAbove ? above : below) >= height ? preferAbove : above > below;
      Object.assign(menu.style, {
        top: up ? "auto" : "100%",
        bottom: up ? "100%" : "auto",
        marginTop: up ? "0" : "8px",
        marginBottom: up ? "8px" : "0",
        maxHeight: `${Math.min(480, up ? above : below)}px`,
        overflowY: "auto",
        transformOrigin: up ? "bottom" : "top",
      });
    };
    update();
    const viewport = window.visualViewport;
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, [menuRef, open, placement]);
}
