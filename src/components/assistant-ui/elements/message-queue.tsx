"use client";

import { useUiLocale } from "@/i18n/provider";
import type { ComponentProps } from "react";
import { ArrowUpIcon, SquareIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { field, ghostButton, mono, paper } from "@/lib/surfaces";

export interface QueuedMessage {
  id: string;
  text: string;
}

const queueCopy = {
  ca: {
    running: "en curs",
    queued: "a la cua",
    sendsNext: "s’envien en acabar",
    remove: (text: string) => `Treu \"${text}\" de la cua`,
    stop: "Atura la resposta",
  },
  es: {
    running: "en curso",
    queued: "en cola",
    sendsNext: "se envían al terminar",
    remove: (text: string) => `Quitar \"${text}\" de la cola`,
    stop: "Detener respuesta",
  },
  en: {
    running: "running",
    queued: "queued",
    sendsNext: "sends when this finishes",
    remove: (text: string) => `Remove \"${text}\" from the queue`,
    stop: "Stop response",
  },
} as const;

export function MessageQueue({
  running,
  queued,
  onCancel,
  onStop,
  stopping = false,
  language,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "running" | "queued" | "onCancel" | "onStop"
> & {
  running: string;
  queued: readonly QueuedMessage[];
  onCancel?: (id: string) => void;
  onStop?: () => void;
  stopping?: boolean;
  language?: keyof typeof queueCopy;
}) {
  const locale = useUiLocale();
  const copy = queueCopy[language ?? locale];

  return (
    <div
      data-slot="message-queue"
      aria-live="polite"
      className={cn("flex w-full max-w-sm flex-col gap-2", className)}

      {...props}
    >
      <div className={cn(paper, "flex items-center gap-2.5 rounded-2xl p-3")}>
        <span className="relative flex size-2 shrink-0">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-500/60 motion-reduce:hidden" />
          <span className="relative inline-flex size-2 rounded-full bg-blue-500 dark:bg-blue-400" />
        </span>
        <span className="text-foreground/90 min-w-0 flex-1 truncate text-[13.5px]">
          {running}
        </span>
        <span className={cn(mono, "text-foreground/35 shrink-0")}>{copy.running}</span>
        {onStop ? (
          <button
            type="button"
            aria-label={stopping ? `${copy.stop}…` : copy.stop}
            aria-busy={stopping || undefined}
            disabled={stopping}
            onClick={onStop}
            className={cn(ghostButton, "touch-target size-7 shrink-0 disabled:opacity-40")}
          >
            <SquareIcon className="size-3 fill-current" />
          </button>
        ) : null}
      </div>

      {queued.length > 0 && (
        <div className="flex items-baseline justify-between px-1">
          <span className={cn(mono, "text-foreground/35")}>
            {queued.length} {copy.queued}
          </span>
          <span className={cn(mono, "text-foreground/35")}>
            {copy.sendsNext}
          </span>
        </div>
      )}

      <ul className="flex flex-col gap-1.5">
        {queued.map((message, index) => (
          <li
            key={message.id}
            className={cn(
              field,
              "fade-in slide-in-from-bottom-1 animate-in fill-mode-both flex items-center gap-2.5 rounded-2xl py-2 pr-2 pl-3 duration-300",
            )}
          >
            <span
              className={cn(
                mono,
                "text-foreground/30 w-3 shrink-0 tabular-nums",
              )}
            >
              {index + 1}
            </span>
            <span className="text-foreground/60 min-w-0 flex-1 truncate text-[13.5px]">
              {message.text}
            </span>
            <ArrowUpIcon className="text-foreground/25 size-3 shrink-0" />
            <button
              type="button"
              aria-label={copy.remove(message.text)}
              onClick={() => onCancel?.(message.id)}
              className={cn(ghostButton, "touch-target size-7 shrink-0")}
            >
              <XIcon className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
