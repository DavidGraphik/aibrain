"use client";

import type { ComponentProps } from "react";
import { MousePointer2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { field, mono, paper } from "@/lib/surfaces";
import { at, indexIn } from "@/lib/range";

export interface ComputerStep {
  id: string;
  action: string;
  target: string;
  x: number;
  y: number;
}

export interface ComputerCursorPosition {
  x: number;
  y: number;
  coordinateSpace?: "percent" | "pixel";
  pressed?: boolean;
}

export function ComputerUseTrail({
  steps,
  activeIndex,
  cursor,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  steps: readonly ComputerStep[];
  activeIndex: number;
  cursor?: ComputerCursorPosition | null;
}) {
  const index = indexIn(steps, activeIndex);
  const active = at(steps, index);
  const trail = steps.slice(Math.max(0, index - 2), index + 1);
  const currentCursor = cursor ?? active;
  const cursorUsesPixels = cursor?.coordinateSpace === "pixel";

  return (
    <div
      data-slot="computer-use-trail"
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 z-10 overflow-hidden", className)}
      {...props}
    >
      {trail.map((step, trailIndex) => (
        <span
          key={step.id}
          className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-500 transition-opacity duration-300 motion-reduce:transition-none dark:bg-blue-400"
          style={{
            left: `${step.x}%`,
            top: `${step.y}%`,
            opacity: 0.18 * (trailIndex + 1),
          }}
        />
      ))}

      {currentCursor ? (
        <MousePointer2Icon
          data-slot="computer-use-cursor"
          data-pressed={cursor?.pressed ? "true" : "false"}
          className="absolute left-0 top-0 size-4 fill-blue-500 text-blue-500 drop-shadow-[0_1px_1px_rgba(255,255,255,0.9)] will-change-transform dark:fill-blue-400 dark:text-blue-400"
          style={cursorUsesPixels ? {
            transform: `translate3d(${currentCursor.x}px, ${currentCursor.y}px, 0) scale(${cursor?.pressed ? 0.9 : 1})`,
          } : {
            left: `${currentCursor.x}%`,
            top: `${currentCursor.y}%`,
            transform: `translate3d(0, 0, 0) scale(${cursor?.pressed ? 0.9 : 1})`,
          }}
        />
      ) : null}
    </div>
  );
}

export function ComputerUse({
  url,
  steps,
  activeIndex,
  cursor,
  showChrome = true,
  showStatus = true,
  viewportClassName,
  children,
  className,
  ...props
}: Omit<ComponentProps<"div">, "url" | "steps" | "activeIndex" | "children"> & {
  url: string;
  steps: readonly ComputerStep[];
  activeIndex: number;
  cursor?: ComputerCursorPosition | null;
  showChrome?: boolean;
  showStatus?: boolean;
  viewportClassName?: string;
  children: React.ReactNode;
}) {
  const index = indexIn(steps, activeIndex);
  const active = at(steps, index);

  return (
    <div
      data-slot="computer-use"
      className={cn(
        paper,
        "flex w-full max-w-md flex-col overflow-hidden rounded-2xl",
        className,
      )}

      {...props}
    >
      {showChrome ? <div className="flex items-center gap-2 px-3 py-2">
        <span className="flex shrink-0 gap-1">
          {["bg-red-500/50", "bg-amber-500/50", "bg-emerald-500/50"].map(
            (tint) => (
              <span
                key={tint}
                aria-hidden
                className={cn("size-2 rounded-full", tint)}
              />
            ),
          )}
        </span>
        <span
          className={cn(
            field,
            mono,
            "text-foreground/45 min-w-0 flex-1 truncate rounded-full px-2.5 py-1",
          )}
        >
          {url}
        </span>
      </div> : null}

      <div className={cn(
        "border-foreground/[0.07] relative min-h-[8.5rem] overflow-hidden",
        showChrome && "border-t",
        viewportClassName,
      )}>
        {children}
        <ComputerUseTrail steps={steps} activeIndex={activeIndex} cursor={cursor} />
      </div>

      {showStatus && active && (
        <div className="border-foreground/[0.07] flex items-center gap-2 border-t px-3.5 py-2">
          <span className={cn(mono, "text-foreground/55 shrink-0")}>
            {active.action}
          </span>
          <span className="text-foreground/80 min-w-0 flex-1 truncate text-[13px]">
            {active.target}
          </span>
          <span
            className={cn(mono, "text-foreground/30 shrink-0 tabular-nums")}
          >
            {index + 1}/{steps.length}
          </span>
        </div>
      )}
    </div>
  );
}
