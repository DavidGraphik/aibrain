"use client";
import { useUiText } from "@/i18n/provider";

import type { ToolResult } from "@/lib/chat-contract";
import { ToolCall } from "@/components/assistant-ui/elements/tool-call";

export const ToolResultCard = ToolCall;

export function ToolResultList({ results }: {
  results: readonly ToolResult[];
}) {
  const t = useUiText();
  if (results.length === 0) return null;
  return (
    <section aria-labelledby="tool-results-title" className="space-y-2">
      <h3 id="tool-results-title" className="text-[12px] font-semibold text-[var(--text-secondary)]">{t("Resultados de herramientas")}</h3>
      {results.map((result) => (
        <ToolResultCard key={result.id} result={result} />
      ))}
    </section>
  );
}
