"use client";
import { useUiText } from "@/i18n/provider";

import NextImage from "next/image";
import { ArrowClockwise, CaretRight, Check, Copy, DownloadSimple, Eye, FileCode, Trash, WarningCircle } from "@phosphor-icons/react";
import { useCallback, useState } from "react";
import type { ActivityFileChange } from "@/lib/chat-contract";
import { AuthenticatedPdfPreview } from "@/components/authenticated-pdf-preview";

type WorkspaceFile = {
  path: string;
  name: string;
  kind: "text" | "image" | "pdf" | "office";
  mimeType: string;
  size: number;
  language: string | null;
  content: string | null;
  previewUrl: string | null;
  previewMimeType: string;
  downloadUrl: string;
};

function workspaceFile(value: unknown): WorkspaceFile | null {
  if (!value || typeof value !== "object" || !("file" in value)) return null;
  const file = value.file;
  if (!file || typeof file !== "object") return null;
  if (
    !("path" in file) || typeof file.path !== "string" ||
    !("name" in file) || typeof file.name !== "string" ||
    !("kind" in file) || (file.kind !== "text" && file.kind !== "image" && file.kind !== "pdf" && file.kind !== "office") ||
    !("mimeType" in file) || typeof file.mimeType !== "string" ||
    !("size" in file) || typeof file.size !== "number" ||
    !("language" in file) || (file.language !== null && typeof file.language !== "string") ||
    !("content" in file) || (file.content !== null && typeof file.content !== "string") ||
    !("previewUrl" in file) || (file.previewUrl !== null && typeof file.previewUrl !== "string") ||
    !("previewMimeType" in file) || typeof file.previewMimeType !== "string" ||
    !("downloadUrl" in file) || typeof file.downloadUrl !== "string" || !file.downloadUrl.startsWith("/api/")
  ) return null;
  return {
    path: file.path,
    name: file.name,
    kind: file.kind,
    mimeType: file.mimeType,
    size: file.size,
    language: file.language,
    content: file.content,
    previewUrl: file.previewUrl,
    previewMimeType: file.previewMimeType,
    downloadUrl: file.downloadUrl,
  };
}

function errorMessage(value: unknown) {
  return value && typeof value === "object" && "error" in value && typeof value.error === "string"
    ? value.error
    : "No se ha podido cargar la vista previa.";
}

const changeCopy: Record<ActivityFileChange["change"], string> = {
  add: "Creado",
  update: "Modificado",
  delete: "Eliminado",
};

export function WorkspaceFilePreview({ projectId, file }: { projectId: string; file: ActivityFileChange }) {
  const t = useUiText();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<WorkspaceFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const handlePdfError = useCallback(() => setError(t("No se ha podido cargar la representación privada del documento.")), [t]);

  const loadPreview = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent(file.path)}`, {
        headers: { Accept: "application/json" },
      });
      const body: unknown = await response.json().catch(() => null);
      const nextPreview = workspaceFile(body);
      if (!response.ok || !nextPreview) throw new Error(errorMessage(body));
      setPreview(nextPreview);
    } catch (caught) {
      setPreview(null);
      setError(caught instanceof Error ? caught.message : t("No se ha podido cargar la vista previa."));
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const nextOpen = !open;
    setOpen(nextOpen);
    if (nextOpen && !preview && !loading) void loadPreview();
  };

  const copyContent = async () => {
    if (!preview?.content) return;
    await navigator.clipboard.writeText(preview.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  if (file.change === "delete") {
    return (
      <div className="mt-1.5 flex min-w-0 items-center gap-2 rounded-md bg-[var(--surface-muted)] px-2.5 py-2 text-[11px] text-[var(--text-muted)]">
        <Trash size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
        <span className="shrink-0">{t("Eliminado")}</span>
      </div>
    );
  }

  return (
    <div className="mt-1.5 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)]">
      <button
        type="button"
        aria-expanded={open}
        className="touch-target flex min-h-10 w-full min-w-0 items-center gap-2 px-2.5 text-left text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        onClick={toggle}
      >
        <FileCode size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
        <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{changeCopy[file.change]}</span>
        <Eye size={13} className="shrink-0" />
        <CaretRight size={11} weight="bold" className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>

      {open ? (
        <div className="border-t border-[var(--border-subtle)]">
          {loading ? (
            <div className="px-3 py-6 text-center text-[11px] text-[var(--text-muted)]" role="status">{t("Cargando el archivo real…")}</div>
          ) : error ? (
            <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-[var(--danger)]" role="alert">
              <WarningCircle size={14} className="shrink-0" />
              <span className="min-w-0 flex-1">{error}</span>
              <button type="button" className="touch-target grid size-7 shrink-0 place-items-center rounded-md hover:bg-[var(--danger-soft)]" aria-label={t("Reintentar la vista previa de {p0}", { p0: file.path })} onClick={() => void loadPreview()}><ArrowClockwise size={13} /></button>
            </div>
          ) : preview ? (
            <>
              <header className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 text-[10px] text-[var(--text-muted)]">
                <span>{preview.language ?? preview.mimeType}</span>
                <span aria-hidden>·</span>
                <span>{Math.max(1, Math.ceil(preview.size / 1024))} {" "}{t("KB")}</span>
                <span className="flex-1" />
                {preview.content !== null ? (
                  <button type="button" className="touch-target flex min-h-7 items-center gap-1.5 rounded-md px-2 font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onClick={() => void copyContent()}>{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? t("Copiado") : t("Copiar")}</button>
                ) : null}
                <a href={preview.downloadUrl} download={preview.name} className="touch-target grid size-7 place-items-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" aria-label={t("Descargar {nombre}", { nombre: preview.name })} title={t("Descargar original para abrir o editar en escritorio")}><DownloadSimple size={13} /></a>
                <button type="button" className="touch-target grid size-7 place-items-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" aria-label={t("Actualizar la vista previa de {p0}", { p0: file.path })} onClick={() => void loadPreview()}><ArrowClockwise size={13} /></button>
              </header>
              {preview.kind === "text" && preview.content !== null ? (
                <pre tabIndex={0} className="scrollbar-thin max-h-[420px] overflow-auto whitespace-pre p-4 font-mono text-[12px] leading-5 text-[var(--text)]"><code>{preview.content}</code></pre>
              ) : preview.kind === "image" && preview.previewUrl ? (
                <div className="bg-[var(--surface-muted)] p-3">
                  <NextImage unoptimized width={1280} height={960} src={preview.previewUrl} alt={t("Vista previa de {p0}", { p0: preview.name })} className="mx-auto max-h-[420px] w-auto rounded-md border border-[var(--border)] bg-white object-contain shadow-[var(--shadow-sm)]" />
                </div>
              ) : (preview.kind === "pdf" || preview.kind === "office") && preview.previewUrl && preview.previewMimeType === "application/pdf" ? (
                <AuthenticatedPdfPreview
                  previewUrl={preview.previewUrl}
                  title={t("Vista previa de {p0}", { p0: preview.name })}
                  className="h-[420px] w-full bg-white"
                  onError={handlePdfError}
                />
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
