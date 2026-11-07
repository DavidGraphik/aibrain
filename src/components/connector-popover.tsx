"use client";
import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/** Position relative to the native caret, constrained to the visual viewport. */
export function ConnectorPopover({ anchor, caret = 0, centerMobile = false, triggerAligned = false, avoidOverlapWith, children }: { anchor: RefObject<HTMLElement | null>; caret?: number; centerMobile?: boolean; triggerAligned?: boolean; avoidOverlapWith?: RefObject<HTMLElement | null>; children: ReactNode }) {
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number; transform?: string } | null>(null);
  useLayoutEffect(() => {
    const update = () => {
      const input = anchor.current;
      if (!input) return;
      const rect = input.getBoundingClientRect(), styles = getComputedStyle(input);
      let point = rect;
      if (input instanceof HTMLTextAreaElement) {
        const mirror = document.createElement("div");
        for (const key of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "padding", "border", "boxSizing", "tabSize"] as const) mirror.style[key] = styles[key];
        Object.assign(mirror.style, { position: "fixed", visibility: "hidden", width: `${input.clientWidth}px`, whiteSpace: "pre-wrap", overflowWrap: "anywhere", left: `${rect.left}px`, top: `${rect.top - input.scrollTop}px` });
        mirror.append(document.createTextNode(input.value.slice(0, caret)));
        const marker = document.createElement("span"); marker.textContent = "\u200b"; mirror.append(marker); document.body.append(mirror);
        point = marker.getBoundingClientRect(); mirror.remove();
      }
      const viewport = window.visualViewport;
      const startY = viewport?.offsetTop ?? 0, height = viewport?.height ?? window.innerHeight;
      const startX = viewport?.offsetLeft ?? 0, width = viewport?.width ?? window.innerWidth;
      const aboveEdge = triggerAligned && avoidOverlapWith?.current
        ? Math.min(point.top, avoidOverlapWith.current.getBoundingClientRect().top)
        : point.top;
      const below = startY + height - point.bottom - 16, above = aboveEdge - startY - 16;
      const down = triggerAligned ? below >= 64 || below >= above : below >= Math.min(300, above);
      const maxHeight = Math.max(triggerAligned ? 0 : 64, Math.min(320, down ? below : above));
      const popupWidth = Math.min(440, width - 24);
      setPosition({ left: centerMobile && width < 640 ? startX + (width - popupWidth) / 2 : Math.max(startX + 12, Math.min(point.left, startX + width - popupWidth - 12)), top: down ? point.bottom + 6 : triggerAligned ? aboveEdge - 6 : Math.max(startY + 12, point.top - maxHeight - 6), width: popupWidth, maxHeight, transform: triggerAligned && !down ? "translateY(-100%)" : undefined });
    };
    update();
    window.addEventListener("resize", update); window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); window.visualViewport?.removeEventListener("resize", update); window.visualViewport?.removeEventListener("scroll", update); };
  }, [anchor, caret, centerMobile, triggerAligned, avoidOverlapWith]);
  return position ? createPortal(<div data-connector-popover style={{ position: "fixed", zIndex: 45, ...position }} className="connector-popover overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-1 shadow-[var(--shadow-lg)]">{children}</div>, document.body) : null;
}
