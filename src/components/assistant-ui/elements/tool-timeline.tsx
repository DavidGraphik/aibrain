"use client";
import { useUiText } from "@/i18n/provider";

import type { ReactNode } from "react";
import styles from "./thinking-reasoning.module.css";
import { ThinkingSteps, ThinkingStepsContent, ThinkingStepsHeader } from "@/components/ui/thinking-steps";

/** Registry timeline composed with the incumbent disclosure and ordered events.
 * Children carry real activity, tool results, file previews and plan states.
 */
export function ToolTimeline({ open, onOpenChange, streaming, label, indicator, complete, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  streaming: boolean;
  label: string;
  indicator: ReactNode;
  complete: boolean;
  children: ReactNode;
}) {
  const t = useUiText();
  return (
    <ThinkingSteps data-slot="tool-timeline" data-testid="turn-thinking-steps" size="compact" open={open} onOpenChange={onOpenChange} className={`w-full ${styles.reasoning} ${complete ? styles.completed : ""}`}>
      <ThinkingStepsHeader
        aria-label={t("{p0} el proceso de trabajo", { p0: open ? t("Ocultar") : t("Mostrar") })}
        aria-live="polite"
        data-streaming={streaming}
        indicator={indicator}
        labelClassName={streaming ? styles.shimmer : styles.label}
        className={`${styles.header} max-w-full ${complete ? "codex-thinking-summary-complete" : ""}`}
      >{label}</ThinkingStepsHeader>
      <ThinkingStepsContent className="pt-1"><div className={complete ? styles.pageFlow : styles.viewport} tabIndex={open && !complete ? 0 : -1} role="region" aria-label={t("Detalles del proceso de trabajo")}>{children}</div></ThinkingStepsContent>
    </ThinkingSteps>
  );
}
