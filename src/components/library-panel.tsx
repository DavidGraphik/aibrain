"use client";
import { useUiLocale } from "@/i18n/provider";
import { useUiText } from "@/i18n/provider";

import NextImage from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowSquareOut,
  Browser,
  ChartLineUp,
  File,
  FileText,
  GlobeHemisphereWest,
  ImagesSquare,
  MagnifyingGlass,
  SpinnerGap,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import {
  advancedArtifactLibraryItem,
  buildLibraryItems,
  isLibraryItem,
  type LibraryItem,
  type LibraryItemType,
} from "@/library/contracts";
import { isAdvancedArtifactSummary, type AdvancedArtifactKind } from "@/artifacts/contracts";
import { workbenchProjectAccess, type WorkbenchProject, type WorkbenchThread } from "@/workbench/types";
import { useModalFocus } from "@/ui/use-modal-focus";
import { SafeVisualizationPreview } from "@/components/safe-visualization-preview";
import { AuthenticatedPdfPreview } from "@/components/authenticated-pdf-preview";
import { AuthenticatedTextPreview } from "@/components/authenticated-text-preview";

type LibraryFilter = "all" | LibraryItemType;

const filterCopy: Array<{ id: LibraryFilter; label: string }> = [
  { id: "all", label: "Todo" },
  { id: "upload", label: "Subidos" },
  { id: "document", label: "Documentos" },
  { id: "image", label: "Imágenes" },
  { id: "result", label: "Resultados" },
  { id: "browser", label: "Navegador" },
  { id: "visualization", label: "Visualizaciones" },
  { id: "internal-site", label: "Sitios internos" },
];

function icon(type: LibraryItemType) {
  if (type === "image") return <ImagesSquare size={17} />;
  if (type === "result") return <FileText size={17} />;
  if (type === "browser") return <Browser size={17} />;
  if (type === "visualization") return <ChartLineUp size={17} />;
  if (type === "internal-site") return <GlobeHemisphereWest size={17} />;
  return <File size={17} />;
}

function formatSize(size: number | null) {
  if (size === null) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function label(type: LibraryItemType) {
  return {
    upload: "Archivo subido",
    document: "Documento generado",
    image: "Imagen generada",
    result: "Respuesta descargable",
    browser: "Resultado del navegador",
    visualization: "Visualización segura",
    "internal-site": "Sitio interno",
  }[type];
}

function responseItems(value: unknown): LibraryItem[] | null {
  if (!value || typeof value !== "object" || !("items" in value) || !Array.isArray(value.items) ||
      !value.items.every(isLibraryItem)) return null;
  return value.items;
}

type DocumentHistoryVersion = {
  versionId: string;
  number: number;
  etag: string;
  fileName: string;
  kind: "docx" | "xlsx" | "xls" | "pptx" | "pdf" | "text" | "image" | "audio";
  mediaType: string;
  size: number;
  author: { userId: string; name: string };
  createdAt: string;
  provenance: { type: "original_upload" | "roundtrip_upload" | "restore"; sourceVersionId: string | null };
  downloadUrl: string;
  previewUrl: string;
};

type DocumentHistory = {
  documentId: string;
  threadId: string;
  title: string;
  scope: { kind: "private" | "project" | "company"; id: string };
  originalVersionId: string;
  latestVersionId: string;
  versions: DocumentHistoryVersion[];
};

function parsedDocumentHistory(value: unknown): DocumentHistory | null {
  if (!value || typeof value !== "object" || !("document" in value) || !value.document ||
      typeof value.document !== "object" || Array.isArray(value.document)) return null;
  const document = value.document as Record<string, unknown>;
  const scope = document.scope;
  const versions = document.versions;
  if (typeof document.documentId !== "string" || typeof document.threadId !== "string" ||
      typeof document.title !== "string" || typeof document.originalVersionId !== "string" ||
      typeof document.latestVersionId !== "string" || !scope || typeof scope !== "object" || Array.isArray(scope) ||
      !("kind" in scope) || (scope.kind !== "private" && scope.kind !== "project" && scope.kind !== "company") ||
      !("id" in scope) || typeof scope.id !== "string" || !Array.isArray(versions) || !versions.length) return null;
  const parsed = versions.flatMap((candidate): DocumentHistoryVersion[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const version = candidate as Record<string, unknown>;
    const author = version.author;
    const provenance = version.provenance;
    if (typeof version.versionId !== "string" || !Number.isSafeInteger(version.number) ||
        typeof version.etag !== "string" || !/^[0-9a-f]{64}$/.test(version.etag) ||
        typeof version.fileName !== "string" ||
        (version.kind !== "docx" && version.kind !== "xlsx" && version.kind !== "xls" && version.kind !== "pptx" &&
          version.kind !== "pdf" && version.kind !== "text" && version.kind !== "image" && version.kind !== "audio") ||
        typeof version.mediaType !== "string" || !Number.isSafeInteger(version.size) ||
        typeof version.createdAt !== "string" || Number.isNaN(Date.parse(version.createdAt)) ||
        typeof version.downloadUrl !== "string" || !version.downloadUrl.startsWith("/api/") ||
        typeof version.previewUrl !== "string" || !version.previewUrl.startsWith("/api/") ||
        !author || typeof author !== "object" || Array.isArray(author) || !("userId" in author) ||
        typeof author.userId !== "string" || !("name" in author) || typeof author.name !== "string" ||
        !provenance || typeof provenance !== "object" || Array.isArray(provenance) || !("type" in provenance) ||
        (provenance.type !== "original_upload" && provenance.type !== "roundtrip_upload" && provenance.type !== "restore") ||
        !("sourceVersionId" in provenance) || (provenance.sourceVersionId !== null && typeof provenance.sourceVersionId !== "string")) return [];
    return [{
      versionId: version.versionId,
      number: version.number as number,
      etag: version.etag,
      fileName: version.fileName,
      kind: version.kind,
      mediaType: version.mediaType,
      size: version.size as number,
      author: { userId: author.userId, name: author.name },
      createdAt: version.createdAt,
      provenance: { type: provenance.type, sourceVersionId: provenance.sourceVersionId },
      downloadUrl: version.downloadUrl,
      previewUrl: version.previewUrl,
    }];
  });
  if (parsed.length !== versions.length || parsed.at(-1)?.versionId !== document.latestVersionId) return null;
  return {
    documentId: document.documentId,
    threadId: document.threadId,
    title: document.title,
    scope: { kind: scope.kind, id: scope.id },
    originalVersionId: document.originalVersionId,
    latestVersionId: document.latestVersionId,
    versions: parsed,
  };
}

function uploadedDocumentIds(item: LibraryItem | null) {
  if (!item || item.type !== "upload") return null;
  const parts = item.id.split(":");
  return parts.length === 3 && parts[0] === "upload" ? { threadId: parts[1]!, documentId: parts[2]! } : null;
}

function scopeLabel(scope: DocumentHistory["scope"]) {
  if (scope.kind === "company") return "Empresa";
  if (scope.kind === "project") return "Proyecto";
  return "Privado";
}

function provenanceLabel(type: DocumentHistoryVersion["provenance"]["type"]) {
  if (type === "original_upload") return "Original";
  if (type === "restore") return "Restauración";
  return "Edición externa";
}

function actionFailure(status: number, fallback: string) {
  if (status === 403) return "No tienes permisos para modificar este elemento.";
  if (status === 409 || status === 412) return "El elemento ha cambiado. Se ha actualizado el historial para que puedas intentarlo de nuevo.";
  if (status === 413) return "El archivo supera el tamaño permitido.";
  if (status === 429) return "Hay demasiadas solicitudes. Espera un momento e inténtalo de nuevo.";
  return fallback;
}

export function LibraryPanel({
  open,
  projects,
  threads,
  onClose,
  onOpenConversation,
}: {
  open: boolean;
  projects: WorkbenchProject[];
  threads: WorkbenchThread[];
  onClose: () => void;
  onOpenConversation: (threadId: string, messageId: string) => void;
}) {
  const locale = useUiLocale();
  const t = useUiText();
  const fallbackItems = useMemo(() => buildLibraryItems({ projects, threads }), [projects, threads]);
  const [remoteItems, setRemoteItems] = useState<LibraryItem[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [offlineFallback, setOfflineFallback] = useState(false);
  const [artifactAction, setArtifactAction] = useState<AdvancedArtifactKind | "publish" | null>(null);
  const [artifactNotice, setArtifactNotice] = useState<string | null>(null);
  const [documentHistory, setDocumentHistory] = useState<DocumentHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [versionAction, setVersionAction] = useState<"upload" | "restore" | null>(null);
  const [versionNotice, setVersionNotice] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const versionInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalFocus(open, onClose, searchRef);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) setLoading(true);
      return fetch("/api/library", { cache: "no-store", signal: controller.signal });
    })
      .then(async (response) => response.ok ? responseItems(await response.json()) : null)
      .then((result) => {
        if (!result) {
          setRemoteItems(null);
          setOfflineFallback(true);
          return;
        }
        setRemoteItems(result);
        setOfflineFallback(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setRemoteItems(null);
          setOfflineFallback(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open]);

  const items = remoteItems ?? fallbackItems;

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("es");
    return items.filter((item) => (filter === "all" || item.type === filter) &&
      (!needle || `${item.name} ${item.projectName} ${item.threadTitle}`.toLocaleLowerCase("es").includes(needle)));
  }, [filter, items, query]);
  const selected = visible.find((item) => item.id === selectedId) ?? visible[0] ?? null;
  const selectedDocumentIds = useMemo(() => uploadedDocumentIds(selected), [selected]);
  const selectedProject = selected ? projects.find((project) => project.id === selected.projectId) : null;
  const selectedCanMutate = selected?.capabilities?.mutate ??
    (selectedProject ? workbenchProjectAccess(selectedProject).canEdit : true);
  const selectedHasHistory = Boolean(selectedDocumentIds && (selected?.capabilities?.history ?? true));
  const activeDocumentHistory = selectedHasHistory && documentHistory && selectedDocumentIds &&
    documentHistory.documentId === selectedDocumentIds.documentId &&
    documentHistory.threadId === selectedDocumentIds.threadId ? documentHistory : null;

  const loadDocumentHistory = useCallback(async (ids: { threadId: string; documentId: string }, signal?: AbortSignal) => {
    const response = await fetch(`/api/threads/${encodeURIComponent(ids.threadId)}/documents/${encodeURIComponent(ids.documentId)}`, {
      cache: "no-store",
      signal,
    });
    const body: unknown = await response.json().catch(() => null);
    const parsed = parsedDocumentHistory(body);
    if (!response.ok || !parsed) throw new Error(t("No se ha podido cargar el historial versionado."));
    return parsed;
  }, [t]);

  useEffect(() => {
    if (!open || !selectedDocumentIds || !selectedHasHistory) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) {
        setDocumentHistory(null);
        setVersionNotice(null);
        setHistoryLoading(true);
      }
      return loadDocumentHistory(selectedDocumentIds, controller.signal);
    })
      .then((history) => {
        if (!controller.signal.aborted) setDocumentHistory(history);
      })
      .catch(() => {
        if (!controller.signal.aborted) setVersionNotice(t("El original sigue disponible, pero no se ha podido cargar su historial."));
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false);
      });
    return () => controller.abort();
  }, [loadDocumentHistory, open, selectedDocumentIds, selectedHasHistory, t]);

  const replaceHistory = (value: unknown) => {
    const parsed = parsedDocumentHistory(value);
    if (!parsed) throw new Error(t("La respuesta del historial no cumple el contrato seguro."));
    setDocumentHistory(parsed);
    return parsed;
  };

  const uploadNewVersion = async (file: File) => {
    if (!selectedCanMutate || !selectedDocumentIds || !activeDocumentHistory) return;
    const latest = activeDocumentHistory.versions.at(-1)!;
    setVersionAction("upload");
    setVersionNotice(null);
    try {
      const form = new FormData();
      form.set("uploadId", crypto.randomUUID());
      form.set("file", file);
      const response = await fetch(
        `/api/threads/${encodeURIComponent(selectedDocumentIds.threadId)}/documents`,
        { method: "POST", headers: { "If-Match": `"${latest.etag}"`, "X-AiBrain-Document-Id": selectedDocumentIds.documentId }, body: form },
      );
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(actionFailure(response.status, t("No se ha podido subir la nueva versión.")));
      }
      replaceHistory(body);
      setVersionNotice(t("Nueva versión guardada sin reemplazar el original."));
    } catch (error) {
      setVersionNotice(error instanceof Error ? error.message : t("No se ha podido subir la nueva versión."));
      void loadDocumentHistory(selectedDocumentIds).then(setDocumentHistory).catch(() => undefined);
    } finally {
      setVersionAction(null);
      if (versionInputRef.current) versionInputRef.current.value = "";
    }
  };

  const restoreVersion = async (version: DocumentHistoryVersion) => {
    if (!selectedCanMutate || !selectedDocumentIds || !activeDocumentHistory) return;
    const latest = activeDocumentHistory.versions.at(-1)!;
    setVersionAction("restore");
    setVersionNotice(null);
    try {
      const response = await fetch(
        `/api/threads/${encodeURIComponent(selectedDocumentIds.threadId)}/documents/${encodeURIComponent(selectedDocumentIds.documentId)}/versions/${encodeURIComponent(version.versionId)}/restore`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "If-Match": `"${latest.etag}"` },
          body: JSON.stringify({ restoreVersionId: crypto.randomUUID() }),
        },
      );
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(actionFailure(response.status, t("No se ha podido restaurar la versión.")));
      }
      replaceHistory(body);
      setVersionNotice(t("La versión {p0} se ha restaurado como una versión nueva.", { p0: version.number }));
    } catch (error) {
      setVersionNotice(error instanceof Error ? error.message : t("No se ha podido restaurar la versión."));
      void loadDocumentHistory(selectedDocumentIds).then(setDocumentHistory).catch(() => undefined);
    } finally {
      setVersionAction(null);
    }
  };

  const upsertAdvancedItem = (summary: unknown) => {
    if (!isAdvancedArtifactSummary(summary)) return null;
    const projectName = projects.find((project) => project.id === summary.projectId)?.name;
    const threadTitle = threads.find((thread) => thread.id === summary.threadId)?.title;
    if (!projectName || !threadTitle) return null;
    const item = advancedArtifactLibraryItem(summary, { projectName, threadTitle });
    setRemoteItems((current) => [item, ...(current ?? fallbackItems).filter((candidate) => candidate.id !== item.id)]);
    setFilter("all");
    setSelectedId(item.id);
    return item;
  };

  const createArtifact = async (kind: AdvancedArtifactKind) => {
    if (!selectedCanMutate || !selected || selected.type !== "result") return;
    setArtifactAction(kind);
    setArtifactNotice(null);
    try {
      const titleBase = selected.name.replace(/\.(?:md|txt)$/i, "");
      const response = await fetch("/api/artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          title: kind === "visualization" ? t("Visualización · {p0}", { p0: titleBase }) : `Sitio interno · ${titleBase}`,
          threadId: selected.threadId,
          messageId: selected.messageId,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setArtifactNotice(actionFailure(response.status, t("No se ha podido crear el artefacto.")));
        return;
      }
      const summary = payload && typeof payload === "object" && "summary" in payload ? payload.summary : null;
      const item = upsertAdvancedItem(summary);
      setArtifactNotice(item ? (kind === "visualization" ? t("Visualización creada desde los datos reales de la respuesta.") : t("Sitio interno creado. Puedes revisarlo antes de publicarlo.")) : t("Artefacto creado."));
    } catch {
      setArtifactNotice(t("No se ha podido conectar con el servicio de artefactos."));
    } finally {
      setArtifactAction(null);
    }
  };

  const publishArtifact = async () => {
    if (!selectedCanMutate || !selected?.artifactId) return;
    setArtifactAction("publish");
    setArtifactNotice(null);
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(selected.artifactId)}/publish`, { method: "POST" });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setArtifactNotice(actionFailure(response.status, t("No se ha podido publicar.")));
        return;
      }
      const summary = payload && typeof payload === "object" && "summary" in payload ? payload.summary : null;
      upsertAdvancedItem(summary);
      setArtifactNotice(t("Snapshot publicado como sitio interno. Sigue protegido por tu sesión de empresa."));
    } catch {
      setArtifactNotice(t("No se ha podido conectar con el servicio de publicación."));
    } finally {
      setArtifactAction(null);
    }
  };

  if (!open) return null;
  const latestDocumentVersion = activeDocumentHistory?.versions.at(-1) ?? null;
  const effectivePreviewUrl = latestDocumentVersion?.previewUrl ?? selected?.previewUrl ?? null;
  const effectiveDownloadUrl = latestDocumentVersion?.downloadUrl ?? selected?.downloadUrl ?? null;
  const effectiveMimeType = latestDocumentVersion?.mediaType ?? selected?.mimeType ?? null;
  const effectiveName = latestDocumentVersion?.fileName ?? selected?.name ?? "documento";
  const previewIsImage = effectivePreviewUrl && effectiveMimeType?.startsWith("image/");
  const previewIsPdf = effectiveMimeType === "application/pdf" ||
    effectiveMimeType?.startsWith("application/vnd.openxmlformats-officedocument.");
  const previewIsText = effectiveMimeType?.startsWith("text/") || effectiveMimeType === "application/json" || effectiveMimeType === "audio/ogg";

  return (
    <div className="workspace-overlay fixed inset-0 z-[75] flex sm:p-5">
      <button aria-label={t("Cerrar biblioteca")} className="absolute inset-0" onClick={onClose} />
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("Biblioteca")}
        className="workspace-panel panel-enter relative m-auto flex h-full w-full max-w-[1120px] flex-col overflow-hidden bg-[var(--surface-raised)] shadow-[var(--shadow-popover)] sm:h-[min(800px,calc(100dvh-2.5rem))] sm:rounded-[22px] sm:border sm:border-[var(--border-subtle)]"
      >
        <header className="workspace-panel-header flex shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] sm:px-6 sm:pt-0">
          <div className="min-w-0 flex-1">
            <h2 className="workspace-panel-title text-[var(--text)]">{t("Biblioteca")}</h2>
            <p className="workspace-panel-subtitle mt-0.5 hidden sm:block">{t("Archivos y resultados creados en tus conversaciones.")}</p>
          </div>
          <button aria-label={t("Cerrar biblioteca")} className="grid size-10 place-items-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div className="flex min-h-0 max-h-[44%] w-full flex-col border-b border-[var(--border-subtle)] md:max-h-none md:w-[48%] md:border-b-0 md:border-r">
            <div className="shrink-0 space-y-3 p-3 sm:p-4">
              <label className="flex h-11 items-center gap-2.5 rounded-[14px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text-subtle)] focus-within:border-[var(--border-strong)]">
                <MagnifyingGlass size={16} />
                <input ref={searchRef} aria-label={t("Buscar en la biblioteca")} className="min-w-0 flex-1 bg-transparent text-[14px] text-[var(--text)] outline-none placeholder:text-[var(--text-subtle)]" placeholder={t("Buscar archivos y resultados")} value={query} onChange={(event) => setQuery(event.target.value)} />
              </label>
              <div className="scrollbar-thin flex gap-1 overflow-x-auto pb-0.5" aria-label={t("Filtros de biblioteca")}>
                {filterCopy.map((option) => <button key={option.id} type="button" aria-pressed={filter === option.id} className={`touch-target min-h-8 shrink-0 rounded-full px-3 text-[11px] font-medium transition ${filter === option.id ? "bg-[var(--text)] text-[var(--surface)]" : "bg-[var(--surface-muted)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"}`} onClick={() => setFilter(option.id)}>{t(option.label ?? "")}</button>)}
              </div>
              {offlineFallback ? <p className="text-[10px] text-[var(--text-subtle)]" role="status">{t("Mostrando el historial ya cargado en este dispositivo.")}</p> : null}
            </div>

            <ul aria-label={t("Elementos de la biblioteca")} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3 sm:px-3">
              {loading && !items.length ? <li role="status" aria-busy="true" className="flex min-h-40 items-center justify-center gap-2 text-[12px] text-[var(--text-subtle)]"><SpinnerGap size={16} className="motion-safe:animate-spin" />{t("Cargando biblioteca…")}</li> :
                visible.length ? visible.map((item) => {
                  const active = item.id === selected?.id;
                  return <li key={item.id}><button type="button" aria-pressed={active} className={`mb-1 flex min-h-[70px] w-full items-center gap-3 rounded-[16px] px-3 py-2.5 text-left transition ${active ? "bg-[var(--surface-selected)]" : "hover:bg-[var(--surface-hover)]"}`} onClick={() => setSelectedId(item.id)}>
                    <span className={`grid size-10 shrink-0 place-items-center rounded-[12px] ${active ? "bg-[var(--surface-raised)] text-[var(--text)]" : "bg-[var(--surface-muted)] text-[var(--text-secondary)]"}`}>{icon(item.type)}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-semibold text-[var(--text)]">{item.name}</span><span className="mt-1 block truncate text-[10px] text-[var(--text-subtle)]">{t(label(item.type) ?? "")} · {item.projectName}</span></span>
                    <span className="shrink-0 text-[9px] tabular-nums text-[var(--text-subtle)]">{formatSize(item.size)}</span>
                  </button></li>;
                }) : <li className="grid min-h-48 place-items-center px-8 text-center"><div className="workspace-empty-state"><span className="mx-auto grid size-11 place-items-center rounded-2xl bg-[var(--surface-muted)] text-[var(--text-subtle)]"><File size={19} /></span><p className="mt-3 text-[13px] font-semibold text-[var(--text)]">{t("No hay resultados")}</p><p className="mt-1 text-[11px] leading-5 text-[var(--text-subtle)]">{t("Prueba otro filtro o busca por nombre, proyecto o conversación.")}</p></div></li>}
            </ul>
          </div>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto bg-[var(--surface)] p-4 sm:p-5 lg:p-8">
            {selected ? <div className="mx-auto flex min-h-full max-w-xl flex-col">
              <div className="flex items-start gap-3">
                <span className="grid size-11 shrink-0 place-items-center rounded-[14px] bg-[var(--surface-raised)] text-[var(--text-secondary)] shadow-[var(--shadow-sm)]">{icon(selected.type)}</span>
                <div className="min-w-0 flex-1"><h3 className="break-words text-[16px] font-semibold text-[var(--text)]">{effectiveName}</h3><p className="mt-1 text-[11px] text-[var(--text-subtle)]">{t(label(selected.type) ?? "")} · {formatSize(latestDocumentVersion?.size ?? selected.size) ?? t("Tamaño no disponible")}{activeDocumentHistory ? ` · v${latestDocumentVersion?.number}` : ""}{!selectedCanMutate ? " · Solo lectura" : ""}</p></div>
              </div>
              <div className="mt-5 grid min-h-64 flex-1 place-items-center overflow-hidden rounded-[20px] border border-[var(--border-subtle)] bg-[var(--surface-raised)]">
                {selected.type === "visualization" && selected.artifactId ? <SafeVisualizationPreview artifactId={selected.artifactId} title={selected.name} /> : previewIsImage && effectivePreviewUrl ? <NextImage unoptimized width={960} height={720} src={effectivePreviewUrl} alt={t("Vista previa de {p0}", { p0: effectiveName })} className="max-h-[460px] w-full object-contain" /> : previewIsPdf && effectivePreviewUrl ? <AuthenticatedPdfPreview previewUrl={effectivePreviewUrl} title={t("Vista previa de {p0}", { p0: effectiveName })} className="h-[min(460px,42dvh)] min-h-64 w-full bg-white" /> : previewIsText && effectivePreviewUrl ? <AuthenticatedTextPreview previewUrl={effectivePreviewUrl} title={t("Texto de {p0}", { p0: effectiveName })} /> : effectivePreviewUrl ? <iframe sandbox="" referrerPolicy="no-referrer" title={t("Vista previa de {p0}", { p0: effectiveName })} src={effectivePreviewUrl} className="h-[min(460px,42dvh)] min-h-64 w-full bg-white" /> : <div className="px-8 text-center"><span className="mx-auto grid size-14 place-items-center rounded-2xl bg-[var(--surface-muted)] text-[var(--text-subtle)]">{icon(selected.type)}</span><p className="mt-4 text-[13px] font-semibold text-[var(--text)]">{t("Vista previa no disponible")}</p><p className="mt-1 text-[11px] leading-5 text-[var(--text-subtle)]">{t("Puedes descargar el archivo o abrir la conversación donde se creó.")}</p></div>}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {effectiveDownloadUrl ? <a href={effectiveDownloadUrl} download={effectiveName} className="touch-target flex min-h-10 items-center gap-2 rounded-full bg-[var(--text)] px-4 text-[12px] font-semibold text-[var(--surface)]"><ArrowDown size={14} />{activeDocumentHistory ? t("Descargar versión actual") : t("Descargar archivo")}</a> : null}
                {activeDocumentHistory && selectedCanMutate ? <><input ref={versionInputRef} className="sr-only" type="file" aria-label={t("Seleccionar una nueva versión")} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadNewVersion(file); }} /><button type="button" disabled={versionAction !== null} className="touch-target flex min-h-10 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-raised)] px-4 text-[12px] font-semibold text-[var(--text)] disabled:opacity-50" onClick={() => versionInputRef.current?.click()}><UploadSimple size={14} />{versionAction === "upload" ? t("Subiendo…") : t("Subir versión editada")}</button></> : null}
                {selected.downloadZipUrl ? <a href={selected.downloadZipUrl} download className="touch-target flex min-h-10 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-raised)] px-4 text-[12px] font-semibold text-[var(--text)]"><ArrowDown size={14} />{t("Exportar ZIP")}</a> : null}
                {effectivePreviewUrl ? <a href={effectivePreviewUrl} target="_blank" rel="noreferrer" className="touch-target flex min-h-10 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-raised)] px-4 text-[12px] font-semibold text-[var(--text)]"><ArrowSquareOut size={14} />{t("Abrir representación")}</a> : null}
                {selected.artifactId && selectedCanMutate ? <button type="button" disabled={artifactAction !== null} className="touch-target min-h-10 rounded-full border border-[var(--border)] bg-[var(--surface-raised)] px-4 text-[12px] font-semibold text-[var(--text)] disabled:opacity-50" onClick={() => void publishArtifact()}>{artifactAction === "publish" ? t("Publicando…") : selected.internalSiteUrl ? t("Actualizar sitio interno") : t("Publicar sitio interno")}</button> : null}
                {selected.internalSiteUrl ? <a href={selected.internalSiteUrl} target="_blank" rel="noreferrer" className="touch-target flex min-h-10 items-center gap-2 rounded-full bg-[var(--positive)] px-4 text-[12px] font-semibold text-[var(--positive-contrast)]"><ArrowSquareOut size={14} />{t("Ver sitio interno")}</a> : null}
                <button type="button" className="touch-target min-h-10 rounded-full px-3 text-[12px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]" onClick={() => onOpenConversation(selected.threadId, selected.messageId)}>{t("Ver conversación")}</button>
              </div>
              {selectedDocumentIds && selectedHasHistory ? <section className="mt-4 rounded-[16px] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3" aria-label={t("Historial de versiones del documento")}>
                <div className="flex items-center justify-between gap-3"><div><p className="text-[11px] font-semibold text-[var(--text)]">{t("Historial de versiones")}</p>{activeDocumentHistory ? <p className="mt-1 text-[10px] text-[var(--text-subtle)]">{t(scopeLabel(activeDocumentHistory.scope) ?? "")} {" "}{t("· original conservado ·")}{" "}{activeDocumentHistory.versions.length} {activeDocumentHistory.versions.length === 1 ? t("versión") : t("versiones")}</p> : null}</div>{historyLoading ? <SpinnerGap size={15} className="motion-safe:animate-spin text-[var(--text-subtle)]" aria-label={t("Cargando historial")} /> : null}</div>
                {activeDocumentHistory ? <ol className="mt-3 space-y-2">{[...activeDocumentHistory.versions].reverse().map((version) => {
                  const latest = version.versionId === activeDocumentHistory.latestVersionId;
                  return <li key={version.versionId} className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--surface-muted)] px-3 py-2"><div className="min-w-0 flex-1"><p className="truncate text-[11px] font-medium text-[var(--text)]">{t("v")}{version.number} · {version.fileName}{latest ? t(" · actual") : ""}</p><p className="mt-0.5 truncate text-[9px] text-[var(--text-subtle)]">{t(provenanceLabel(version.provenance.type) ?? "")} · {version.author.name} · {new Date(version.createdAt).toLocaleString(locale)}</p></div><a href={version.downloadUrl} download={version.fileName} className="touch-target min-h-8 rounded-full px-2.5 py-1.5 text-[10px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">{t("Descargar")}</a>{!latest && selectedCanMutate ? <button type="button" disabled={versionAction !== null} className="touch-target min-h-8 rounded-full border border-[var(--border)] px-2.5 text-[10px] font-medium text-[var(--text)] disabled:opacity-50" onClick={() => void restoreVersion(version)}>{t("Restaurar")}</button> : null}</li>;
                })}</ol> : null}
                <p className="mt-3 text-[9px] leading-4 text-[var(--text-subtle)]">{t("Para editar en Word, Excel o PowerPoint, descarga el original, edítalo en tu aplicación y súbelo aquí. El navegador no simula guardado nativo automático.")}</p>
              </section> : null}
              {selected.type === "result" && selectedCanMutate ? <div className="mt-4 rounded-[16px] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3"><p className="text-[11px] font-semibold text-[var(--text)]">{t("Crear desde esta respuesta")}</p><p className="mt-1 text-[10px] leading-4 text-[var(--text-subtle)]">{t("La visualización usa una tabla numérica existente. El sitio interno conserva el contenido y elimina código inseguro.")}</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={artifactAction !== null} className="touch-target min-h-9 rounded-full bg-[var(--surface-muted)] px-3 text-[11px] font-medium text-[var(--text)] disabled:opacity-50" onClick={() => void createArtifact("visualization")}>{artifactAction === "visualization" ? t("Creando…") : t("Crear visualización")}</button><button type="button" disabled={artifactAction !== null} className="touch-target min-h-9 rounded-full bg-[var(--surface-muted)] px-3 text-[11px] font-medium text-[var(--text)] disabled:opacity-50" onClick={() => void createArtifact("internal-site")}>{artifactAction === "internal-site" ? t("Creando…") : t("Crear sitio interno")}</button></div></div> : null}
              {artifactNotice ? <p className="mt-3 text-[10px] leading-4 text-[var(--text-secondary)]" role="status">{artifactNotice}</p> : null}
              {selectedHasHistory && versionNotice ? <p className="mt-3 text-[10px] leading-4 text-[var(--text-secondary)]" role="status">{versionNotice}</p> : null}
              <p className="mt-3 truncate text-[10px] text-[var(--text-subtle)]">{selected.projectName} · {selected.threadTitle}</p>
            </div> : <div className="workspace-empty-state m-auto text-center"><span className="mx-auto grid size-12 place-items-center rounded-2xl bg-[var(--surface-muted)] text-[var(--text-subtle)]"><ImagesSquare size={20} /></span><p className="mt-3 font-semibold text-[var(--text)]">{t("Selecciona un elemento")}</p><p className="mt-1">{t("Aquí podrás previsualizarlo, descargarlo o volver a la conversación donde se creó.")}</p></div>}
          </div>
        </div>

        {selected ? <footer className="flex min-h-14 shrink-0 items-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 pb-[env(safe-area-inset-bottom)] md:hidden">
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-secondary)]">{selected.name}</span>
          <button type="button" className="touch-target min-h-9 rounded-full px-3 text-[11px] font-medium text-[var(--text-secondary)]" onClick={() => onOpenConversation(selected.threadId, selected.messageId)}>{t("Ver chat")}</button>
          {effectiveDownloadUrl ? <a href={effectiveDownloadUrl} download={effectiveName} className="touch-target flex min-h-9 items-center gap-1.5 rounded-full bg-[var(--text)] px-3 text-[11px] font-semibold text-[var(--surface)]"><ArrowDown size={13} />{t("Descargar")}</a> : null}
        </footer> : null}
      </section>
    </div>
  );
}
