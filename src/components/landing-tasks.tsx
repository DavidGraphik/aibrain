"use client";
import { useUiText } from "@/i18n/provider";

import { ConnectorPopover } from "@/components/connector-popover";
import Image from "next/image";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FileText, ListChecks, Scales, Plus, Factory, ShieldCheck, Receipt, CalendarBlank, CaretRight, ChartLine, Megaphone, Presentation, ShoppingBag, Table, type Icon } from "@phosphor-icons/react";
import type { LandingSuggestion } from "@/lib/landing-suggestions";
import { useMenuKeyboardNavigation } from "@/ui/use-menu-keyboard-navigation";

const suggestionIcons: Partial<Record<LandingSuggestion["id"], Icon>> = {
  automation: Plus, production: Factory, quality: ShieldCheck, administration: Receipt,
  schedule: CalendarBlank, spreadsheets: Table, "store-performance": ChartLine,
  "meta-review": Megaphone, "shopify-review": ShoppingBag, "outreach-campaigns": Megaphone,
  "outreach-leads": ListChecks, "outreach-attention": ListChecks, "trinalum-crm": ListChecks,
  "trinalum-erp": Table, "trinalum-documents": FileText, "document-summary": FileText,
  "compare-options": Scales, "next-steps": ListChecks,
};

export function LandingTasks({ tasks, disabled, onSelect, onCreateAutomation }: {
  tasks: LandingSuggestion[];
  disabled: boolean;
  onSelect: (prompt: string) => void;
  onCreateAutomation?: () => void;
}) {
  const t = useUiText();
  const [schedule, setSchedule] = useState<LandingSuggestion | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const close = useCallback(() => {
    setSchedule(null);
    requestAnimationFrame(() => openerRef.current?.focus());
  }, []);
  const onKeyDown = useMenuKeyboardNavigation(close);
  useEffect(() => {
    if (!schedule) return;
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus());
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setSchedule(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("pointerdown", outside); };
  }, [schedule]);
  const choose = (text: string) => {
    setSchedule(null);
    onSelect(text);
  };
  const items = tasks.map((task) => {
    const Icon = suggestionIcons[task.id] ?? Presentation;
    return <button key={task.id} type="button" disabled={disabled || (task.action === "create-automation" && !onCreateAutomation)}
      className="landing-task-item" aria-haspopup={task.children ? "menu" : undefined}
      aria-expanded={task.children ? schedule?.id === task.id : undefined}
      aria-controls={task.children && schedule?.id === task.id ? id : undefined}
      onClick={(event) => {
        if (task.children) {
          openerRef.current = event.currentTarget;
          setSchedule(task);
        } else if (task.action === "create-automation") {
          setSchedule(null);
          onCreateAutomation?.();
        } else choose(task.prompt);
      }}
      onKeyDown={(event) => {
        if (task.children && event.key === "ArrowDown") {
          event.preventDefault();
          openerRef.current = event.currentTarget;
          setSchedule(task);
        }
      }}>{task.iconPath ? <Image unoptimized src={task.iconPath} alt="" width={20} height={20} className="size-5 shrink-0 object-contain" /> : <Icon size={17} aria-hidden="true" />}<span>{task.label}</span>{task.children ? <CaretRight size={12} aria-hidden="true" /> : null}</button>;
  });
  return <div ref={rootRef} className="landing-tasks landing-tasks-suggestions">
    {items}
    {schedule ? <ConnectorPopover anchor={openerRef} triggerAligned><div ref={menuRef} id={id} role="menu" aria-label={schedule.id === "schedule" ? t("Horarios del equipo") : schedule.label} className="max-h-[inherit] overflow-y-auto overscroll-contain" onKeyDown={(event) => { event.stopPropagation(); onKeyDown(event); }}>
      {schedule.children?.map((child) => <button key={child.id} type="button" role="menuitem" tabIndex={-1} disabled={disabled || Boolean(child.disabledReason)} title={child.disabledReason} className="landing-task-item disabled:opacity-50" onClick={() => { if (!child.disabledReason) choose(child.prompt); }}>{schedule.iconPath ? <Image unoptimized src={schedule.iconPath} alt="" width={20} height={20} className="size-5 shrink-0 object-contain" /> : null}<span>{child.label}{child.disabledReason ? <small className="block text-xs font-normal">{child.disabledReason}</small> : null}</span></button>)}
    </div></ConnectorPopover> : null}
  </div>;
}
