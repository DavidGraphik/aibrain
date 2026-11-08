"use client";
import { useUiText } from "@/i18n/provider";

import { useEffect, useState } from "react";

function pageUrl(previewUrl: string, page: number) {
  const separator = previewUrl.includes("?") ? "&" : "?";
  return `${previewUrl}${separator}page=${page}`;
}

export function AuthenticatedDocumentPagePreview({
  previewUrl,
  page,
  title,
  zoom,
  onLoad,
  onError,
  onPageCount,
}: {
  previewUrl: string;
  page: number;
  title: string;
  zoom: number;
  onLoad?: () => void;
  onError?: (error: Error) => void;
  onPageCount?: (pages: number) => void;
}) {
  const t = useUiText();
  const source = pageUrl(previewUrl, page);
  const [state, setState] = useState<{ source: string; blobUrl?: string; error?: string }>({ source });

  useEffect(() => {
    const controller = new AbortController();
    let blobUrl: string | null = null;
    void fetch(source, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "image/png" },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(response.status === 401
        ? t("La sesión ha caducado. Vuelve a iniciar sesión.")
        : response.status === 404
          ? t("El documento o esta página ya no están disponibles para esta conversación.")
          : t("No se ha podido preparar la página (HTTP {p0}).", { p0: response.status }));
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("image/png")) {
        throw new Error(t("La representación de la página no es una imagen segura."));
      }
      const image = await response.blob();
      if (!image.size || image.size > 20 * 1024 * 1024) throw new Error(t("La página excede el tamaño permitido."));
      if (controller.signal.aborted) return;
      const pages = Number(response.headers.get("X-Document-Page-Count"));
      if (Number.isSafeInteger(pages) && pages > 0 && pages <= 500) onPageCount?.(pages);
      blobUrl = URL.createObjectURL(new Blob([image], { type: "image/png" }));
      setState({ source, blobUrl });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : t("No se ha podido preparar la página.");
      setState({ source, error: message });
      onError?.(new Error(message));
    });
    return () => {
      controller.abort();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [onError, onPageCount, source, t]);

  if (state.source !== source || (!state.blobUrl && !state.error)) {
    return <div className="grid h-full place-items-center text-sm text-[var(--text-muted)]" role="status">{t("Preparando página")}{" "}{page}…</div>;
  }
  if (state.error) return null;
  return (
    <div className="scrollbar-thin h-full overflow-auto p-3 sm:p-6" tabIndex={0} aria-label={t("{p0}, página {p1}", { p0: title, p1: page })}>
      {/* Blob URLs are authenticated, ephemeral page renders and cannot use the Next image optimizer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={state.blobUrl}
        alt={t("{p0}, página {p1}", { p0: title, p1: page })}
        draggable={false}
        className="mx-auto block h-auto bg-white shadow-[0_12px_38px_rgba(0,0,0,.18)] transition-[width] duration-150"
        style={{ width: `${zoom}%`, maxWidth: `${9 * zoom}px` }}
        onLoad={onLoad}
        onError={() => onError?.(new Error(t("No se ha podido mostrar la página renderizada.")))}
      />
    </div>
  );
}
