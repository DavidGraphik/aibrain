"use client";
import { useUiText } from "@/i18n/provider";

import type { ComponentProps } from "react";
import { BrainIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { field, ghostButton, mono } from "@/lib/surfaces";

export type MemoryChange = "added" | "updated" | "existing";

export interface MemoryChip {
  id: string;
  text: string;
  change: MemoryChange;
}

export function MemoryChips({
  chips,
  onForget,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "chips" | "onForget"> & {
  chips: readonly MemoryChip[];
  onForget?: (id: string) => void;
}) {
  const t = useUiText();
  if (chips.length === 0) return null;
  const fresh = chips.filter((chip) => chip.change !== "existing").length;

  return (
    <div
      data-slot="memory-chips"
      className={cn("flex w-full max-w-sm flex-col gap-2", className)}

      {...props}
    >
      <div className="flex items-center gap-1.5">
        <BrainIcon className="text-[var(--text-muted)] size-3.5" />
        <span className={cn(mono, "text-[var(--text-muted)]")}>
          {fresh > 0 ? `${fresh} memorias guardadas` : t("Memoria")}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <span
            key={chip.id}
            className={cn(
              "fade-in zoom-in-95 animate-in fill-mode-both group flex items-center gap-1 rounded-lg py-1 pr-1 pl-2.5 text-xs duration-300 motion-reduce:animate-none",
              chip.change === "existing"
                ? cn(field, "text-[var(--text-secondary)]")
                : "bg-[var(--surface-selected)] text-[var(--text)]",
            )}
          >
            <span className="min-w-0 break-words">{chip.text}</span>
            {onForget ? <button
              type="button"
              aria-label={`Olvidar "${chip.text}"`}
              onClick={() => onForget?.(chip.id)}
              className={cn(ghostButton, "size-9 shrink-0")}
            >
              <XIcon className="size-2.5" />
            </button> : null}
          </span>
        ))}
      </div>
    </div>
  );
}
