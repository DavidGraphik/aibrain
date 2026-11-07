"use client";
import { useUiText } from "@/i18n/provider";

import NextImage from "next/image";
import {
  Browser,
  DownloadSimple,
  Eye,
  FileDoc,
  FilePdf,
  FilePpt,
  FileText,
  FileXls,
  SpinnerGap,
  WarningCircle,
} from "@phosphor-icons/react";
import type { DocumentArtifact, GeneratedArtifact } from "@/lib/chat-contract";
import { ImageGeneration } from "@/components/assistant-ui/elements/image-generation";

const publicationCopy: Record<NonNullable<DocumentArtifact["publicationStatus"]>, string> = {
  awaiting_confirmation: "Pendiente de confirmación segura",
  publishing: "Publicando…",
  published: "Publicado y versionado",
  declined: "Publicación rechazada",
  conflict: "Conflicto: el original ha cambiado",
};

function DocumentIcon({ kind }: { kind: DocumentArtifact["kind"] }) {
  if (kind === "pdf") return <FilePdf size={18} />;
  if (kind === "docx") return <FileDoc size={18} />;
  if (kind === "xlsx" || kind === "xls") return <FileXls size={18} />;
  if (kind === "pptx") return <FilePpt size={18} />;
  return <FileText size={18} />;
}

function DocumentCard({ artifact, onPreview }: {
  artifact: DocumentArtifact;
  onPreview?: (artifact: DocumentArtifact) => void;
}) {
  const t = useUiText();
  return (
    <article className="max-w-[420px] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-raised)]">
      <header className="flex items-center gap-2.5 px-3 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[var(--surface-muted)] text-[var(--text-secondary)]"><DocumentIcon kind={artifact.previewFormat === "spreadsheet" ? "xlsx" : artifact.kind} /></span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-body-2-semibold text-[var(--text)]">{artifact.name}</h3>
          <p className="mt-0.5 text-caption-1-regular text-[var(--text-muted)]">{artifact.previewFormat === "spreadsheet" ? t("Excel · vista de datos") : artifact.kind === "text" && !/^(?:text\/|application\/json$)/i.test(artifact.mimeType) ? t("Archivo") : artifact.kind.toUpperCase()} · {Math.ceil(artifact.size / 1024)} {" "}{t("KB")}{artifact.pages ? ` · ${artifact.pages} ${artifact.pages === 1 ? t("página") : t("páginas")}` : ""}</p>
        </div>
        {artifact.status === "ready" && artifact.previewUrl && onPreview ? <button type="button" className="touch-target grid size-8 shrink-0 place-items-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-muted)] hover:text-[var(--text)] active:scale-[0.98]" aria-label={t("Previsualizar {nombre}", { nombre: artifact.name })} title={t("Vista previa")} onClick={() => onPreview(artifact)}><Eye size={15} /></button> : null}
        {artifact.status === "ready" ? <a href={artifact.url} download={artifact.previewFormat === "spreadsheet" ? `${artifact.name}.preview.json` : artifact.name} className="touch-target grid size-8 shrink-0 place-items-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-muted)] hover:text-[var(--text)] active:scale-[0.98]" aria-label={artifact.previewFormat === "spreadsheet" ? t("Descargar datos de la vista previa") : t("Descargar {nombre}", { nombre: artifact.name })} title={t("Descargar")}><DownloadSimple size={15} /></a> : null}
      </header>
      {artifact.status === "processing" ? (
        <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] px-3 py-2 text-body-2-regular text-[var(--text-muted)]" role="status"><SpinnerGap size={14} className="motion-safe:animate-spin" />{t("Preparando una vista previa segura…")}</div>
      ) : artifact.status === "error" ? (
        <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] px-3 py-2 text-body-2-medium text-[var(--danger)]" role="alert"><WarningCircle size={15} className="shrink-0" />{artifact.error ?? t("No se ha podido generar la vista previa.")}</div>
      ) : artifact.previewUrl && onPreview ? (
        <button type="button" className="touch-target flex min-h-10 w-full items-center justify-between border-t border-[var(--border-subtle)] px-3 text-left text-body-2-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] active:bg-[var(--surface-selected)]" onClick={() => onPreview(artifact)}><span>{artifact.previewFormat === "spreadsheet" ? t("Ver hojas del libro") : t("Revisar antes de descargar")}</span><span aria-hidden>›</span></button>
      ) : artifact.previewUrl ? (
        <details className="border-t border-[var(--border-subtle)]">
          <summary className="cursor-pointer list-none px-3 py-2 text-caption-1-medium text-[var(--text-muted)] hover:text-[var(--text)] [&::-webkit-details-marker]:hidden">{t("Vista previa ›")}</summary>
          <a href={artifact.url} target="_blank" rel="noreferrer" className="block bg-[var(--surface-muted)] p-3" aria-label={t("Abrir {p0}", { p0: artifact.name })}>
            <NextImage unoptimized width={960} height={540} src={artifact.previewUrl} alt={t("Vista previa de {p0}", { p0: artifact.name })} className="mx-auto max-h-72 w-auto rounded-md border border-[var(--border)] bg-white object-contain shadow-[var(--shadow-sm)]" />
          </a>
        </details>
      ) : (
        <div className="border-t border-[var(--border-subtle)] px-3 py-2 text-caption-1-regular text-[var(--text-muted)]">{t("Documento listo para descargar.")}</div>
      )}
      {artifact.publicationStatus || artifact.publicationError ? <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-3 py-2">{artifact.publicationError ? <span className="text-body-2-medium text-[var(--danger)]" role="alert">{artifact.publicationError}</span> : artifact.publicationStatus ? <span className="text-body-2-medium text-[var(--text)]">{t(publicationCopy[artifact.publicationStatus] ?? "")}</span> : null}{artifact.targetLabel ? <span className="max-w-52 truncate text-caption-1-regular text-[var(--text-muted)]">{artifact.targetLabel}</span> : null}</footer> : null}
    </article>
  );
}

export function TurnArtifactCard({ artifact, onPreviewDocument }: {
  artifact: GeneratedArtifact;
  onPreviewDocument?: (artifact: DocumentArtifact) => void;
}) {
  const t = useUiText();
  if (artifact.type === "document") return <DocumentCard artifact={artifact} onPreview={onPreviewDocument} />;
  // Preserve old conversation records without exposing retired viewer URLs.
  if (artifact.type === "browser") {
    return <article className="max-w-[420px] rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2.5">
      <header className="flex items-center gap-2.5"><Browser size={16} className="shrink-0 text-[var(--text-secondary)]" /><h3 className="truncate text-body-2-semibold text-[var(--text)]">{artifact.name}</h3></header>
      <p className="mt-1 text-caption-1-regular text-[var(--text-muted)]">{t("Registro histórico")}</p>
      {artifact.error ? <p className="mt-1 text-caption-1-regular text-[var(--text-muted)]">{artifact.error}</p> : null}
    </article>;
  }
  return <ImageGeneration
    key={artifact.url}
    name={artifact.name}
    prompt={artifact.prompt ?? artifact.name}
    generating={false}
    src={artifact.url}
    alt={artifact.prompt ?? artifact.name}
    downloadUrl={`${artifact.url}?download=1`}
    downloadName={artifact.name}
    width={artifact.width}
    height={artifact.height}
    className="w-full max-w-[640px]"
  />;
}
