"use client";
import { useUiLocale } from "@/i18n/provider";

import { cn } from "@/lib/utils";

/** Group real message timestamps without replacing the rich message renderer. */
export function DaySeparator({ date, previousDate, className }: {
  date: string;
  previousDate?: string;
  className?: string;
}) {
  const locale = useUiLocale();
  const current = new Date(date);
  const previous = previousDate ? new Date(previousDate) : null;
  if (Number.isNaN(current.getTime()) || current.toDateString() === previous?.toDateString()) return null;
  return (
    <div data-slot="day-separator" className={cn("mb-5 flex items-center gap-3 py-1", className)}>
      <span aria-hidden="true" className="h-px flex-1 bg-[var(--border-subtle)]" />
      <time dateTime={date} className="text-[12px] text-[var(--text-muted)]">
        {new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(current)}
      </time>
      <span aria-hidden="true" className="h-px flex-1 bg-[var(--border-subtle)]" />
    </div>
  );
}
