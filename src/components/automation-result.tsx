"use client";

import { useEffect, useState } from "react";
import { useUiText } from "@/i18n/provider";
import { getThreadRequest } from "@/lib/workbench-api-client";
import type { WorkbenchThread } from "@/workbench/types";
import type { DocumentArtifact } from "@/lib/chat-contract";
import { MarkdownMessage } from "@/components/markdown-message";
import { TurnArtifactCard } from "@/components/turn-artifact-card";
import { DocumentPreviewPanel } from "@/components/document-preview-panel";

/** A result grant does not grant access to its owner's project or composer. */
export function AutomationResult({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const t = useUiText();
  const [thread, setThread] = useState<WorkbenchThread | null>(null);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<DocumentArtifact | null>(null);
  useEffect(() => {
    let active = true;
    getThreadRequest(threadId).then((result) => {
      if (result.id !== threadId) throw new Error("Unexpected result");
      if (active) setThread(result);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [threadId]);
  return <section aria-label={t("Resultado de la automatización")} className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
    <div className="mb-3 flex items-center justify-between gap-3"><h4 className="text-sm font-semibold">{t("Resultado de la automatización")}</h4><button type="button" onClick={onClose} className="touch-target rounded-lg px-2 text-xs">{t("Cerrar")}</button></div>
    {failed ? <p role="alert">{t("No se ha podido abrir esta conversación. Comprueba que sigues teniendo acceso.")}</p> : !thread ? <p role="status">{t("Cargando…")}</p> : <div className="flex gap-4"><div className="min-w-0 flex-1 space-y-4">{thread.messages.filter((message) => message.role === "assistant").map((message) => <div key={message.id}><MarkdownMessage>{message.content}</MarkdownMessage><div className="mt-3 space-y-2">{message.artifacts.map((artifact) => <TurnArtifactCard key={artifact.id} artifact={artifact} onPreviewDocument={setPreview} />)}</div></div>)}</div>{preview ? <DocumentPreviewPanel artifact={preview} onClose={() => setPreview(null)} /> : null}</div>}
  </section>;
}
