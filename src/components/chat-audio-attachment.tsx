"use client";

import { useState } from "react";
import { FileAudio } from "@phosphor-icons/react";
import type { ChatAttachment } from "@/lib/chat-contract";
import { isUuid } from "@/workbench/types";
import { useUiText } from "@/i18n/provider";

type AudioLinks = { download: string; preview: string };
type State = { identity: string; phase: "loading" | "ready" | "error"; links?: AudioLinks };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

function originalLinks(value: unknown, threadId: string, attachment: ChatAttachment): AudioLinks {
  if (!record(value) || !record(value.document)) throw Error("invalid history");
  const doc = value.document;
  if (doc.threadId !== threadId || doc.documentId !== attachment.id || !isUuid(doc.originalVersionId) ||
      !Array.isArray(doc.versions) || doc.versions.length > 256) throw Error("invalid identity");
  const original = doc.versions.find((version: unknown) => record(version) && version.versionId === doc.originalVersionId);
  if (!record(original) || original.kind !== "audio" || original.mediaType !== "audio/ogg" ||
      original.fileName !== attachment.name || original.size !== attachment.size ||
      typeof original.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(original.sha256)) throw Error("invalid original");
  const download = `/api/threads/${threadId}/documents/${attachment.id}/versions/${doc.originalVersionId}`;
  const preview = `${download}/preview/preview.txt`;
  if (original.downloadUrl !== download || original.previewUrl !== preview) throw Error("invalid links");
  return { download, preview };
}

/** Resolve the immutable original on demand through the existing authorized history route. */
export function ChatAudioAttachment({ attachment, threadId }: { attachment: ChatAttachment; threadId: string }) {
  const t = useUiText();
  const [state, setState] = useState<State | null>(null);
  const identity = `${threadId}/${attachment.id}`;
  const current = state?.identity === identity ? state : null;
  const open = async () => {
    if (current?.phase === "ready") { setState(null); return; }
    if (!isUuid(threadId) || !isUuid(attachment.id) || attachment.mimeType !== "audio/ogg") {
      setState({ identity, phase: "error" }); return;
    }
    setState({ identity, phase: "loading" });
    try {
      const response = await fetch(`/api/threads/${threadId}/documents/${attachment.id}`, {
        credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw Error("unavailable");
      const links = originalLinks(await response.json(), threadId, attachment);
      setState({ identity, phase: "ready", links });
    } catch {
      setState({ identity, phase: "error" });
    }
  };
  return <span className="flex min-w-0 flex-1 flex-col gap-1">
    <button type="button" className="touch-target flex min-h-8 min-w-0 items-center gap-1.5 text-left"
      aria-label={t("Ver audio {p0}", { p0: attachment.name })} aria-expanded={current?.phase === "ready"}
      disabled={current?.phase === "loading"} onClick={() => void open()}>
      <FileAudio size={13} className="shrink-0" /><span className="truncate">{attachment.name}</span>
    </button>
    {current?.phase === "loading" ? <span role="status">{t("Cargando audio…")}</span> : null}
    {current?.phase === "error" ? <span role="alert">{t("No se ha podido abrir este audio.")}</span> : null}
    {current?.phase === "ready" && current.links ? <span className="flex flex-wrap gap-x-2 text-[11px]">
      <a href={current.links.preview} target="_blank" rel="noreferrer" className="touch-target inline-flex min-h-8 items-center underline"
        aria-label={t("Ver transcripción de {p0}", { p0: attachment.name })}>{t("Ver transcripción")}</a>
      <a href={current.links.download} download={attachment.name} className="touch-target inline-flex min-h-8 items-center underline"
        aria-label={t("Descargar original de {p0}", { p0: attachment.name })}>{t("Descargar original")}</a>
    </span> : null}
  </span>;
}
