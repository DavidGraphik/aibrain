"use client";
import { useUiText } from "@/i18n/provider";

import { useEffect, useState } from "react";

const DEFAULT_MAXIMUM_PDF_BYTES = 100 * 1024 * 1024;

function isPdfResponse(response: Response) {
  const mediaType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/pdf";
}

function declaredSizeWithinLimit(response: Response, maximumBytes: number) {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength === null) return true;
  const bytes = Number(contentLength);
  return Number.isSafeInteger(bytes) && bytes > 0 && bytes <= maximumBytes;
}

export function AuthenticatedPdfPreview({
  previewUrl,
  title,
  className,
  maximumBytes = DEFAULT_MAXIMUM_PDF_BYTES,
  onLoad,
  onError,
}: {
  previewUrl: string;
  title: string;
  className: string;
  maximumBytes?: number;
  onLoad?: () => void;
  onError?: (error: Error) => void;
}) {
  const t = useUiText();
  const [failure, setFailure] = useState<{ source: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const [preview, setPreview] = useState<{ source: string; url: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let currentBlobUrl: string | null = null;

    const fail = (message: string) => {
      setFailure({ source: previewUrl, message });
      onError?.(new Error(message));
    };
    if (!previewUrl.startsWith("/api/")) {
      fail(t("La URL de vista previa no es privada."));
      return () => controller.abort();
    }

    void fetch(previewUrl, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/pdf" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 401 ? t("La sesión ha caducado. Vuelve a iniciar sesión.") : response.status === 404 ? t("El archivo no está disponible para esta conversación.") : t("No se ha podido obtener el PDF privado (HTTP {p0}).", { p0: response.status }));
        if (!isPdfResponse(response)) throw new Error(t("La respuesta no es un PDF."));
        if (!declaredSizeWithinLimit(response, maximumBytes)) throw new Error(t("El PDF excede el tamaño permitido."));
        const pdf = await response.blob();
        if (!pdf.size || pdf.size > maximumBytes) throw new Error(t("El PDF excede el tamaño permitido."));
        if (controller.signal.aborted) return;
        currentBlobUrl = URL.createObjectURL(new Blob([pdf], { type: "application/pdf" }));
        setFailure(null);
        setPreview({ source: previewUrl, url: currentBlobUrl });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        fail(error instanceof Error ? error.message : t("No se ha podido obtener el PDF privado."));
      });

    return () => {
      controller.abort();
      if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    };
  }, [maximumBytes, onError, previewUrl, retry, t]);

  if (failure?.source === previewUrl && !onError) return (
    <div role="alert" className="p-4 text-sm">
      <p>{failure.message}</p>
      <button type="button" className="mt-2 rounded border px-3 py-2" onClick={() => { setFailure(null); setPreview(null); setRetry((value) => value + 1); }}>{t("Reintentar")}</button>
    </div>
  );
  if (!preview || preview.source !== previewUrl) return null;
  return (
    <iframe
      title={title}
      src={preview.url}
      referrerPolicy="no-referrer"
      className={className}
      onLoad={onLoad}
      onError={() => {
        const error = new Error(t("No se ha podido cargar el visor de PDF."));
        setFailure({ source: previewUrl, message: error.message });
        onError?.(error);
      }}
    />
  );
}
