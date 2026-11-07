"use client";
import { useUiText } from "@/i18n/provider";

import { Plug } from "@phosphor-icons/react";
import type { ChatMessage } from "@/lib/chat-contract";
import {
  type ManagedAppActionDescriptor,
} from "@/ui/codex-managed-app-ui";

export function ManagedAppActionControl({
  enabled,
}: {
  enabled: boolean;
  threadId: string;
  message: ChatMessage;
  onPrepared: (descriptor: ManagedAppActionDescriptor) => void;
}) {
  const t = useUiText();
  if (!enabled) return null;

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2.5" aria-label={t("Acción conectada")}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2"><Plug size={14} aria-hidden="true" /><p className="text-[10px] font-medium text-[var(--text)]">{t("Acción conectada disponible")}</p></div>
      </div>
      <p className="mt-2 text-[10px] text-[var(--text-muted)]">{t("Pide al asistente en el chat que realice la acción. Si necesita una confirmación, te la pedirá por mensaje.")}</p>
    </section>
  );
}
