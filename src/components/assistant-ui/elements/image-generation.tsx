"use client";
import { useUiText } from "@/i18n/provider";

import { useState, type ComponentProps } from "react";
import NextImage from "next/image";
import { DownloadIcon, ExpandIcon, RefreshCwIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const imageAction = "touch-target inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]";

type PreviewState = { src: string | null; status: "loading" | "ready" | "error"; width?: number; height?: number };

export function ImageGeneration({
  name,
  prompt,
  generating,
  src = null,
  alt,
  width,
  height,
  dimensions,
  downloadUrl,
  downloadName,
  onRegenerate,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "prompt" | "generating"> & {
  name?: string;
  prompt: string;
  generating: boolean;
  src?: string | null;
  alt?: string;
  width?: number;
  height?: number;
  dimensions?: string;
  downloadUrl?: string;
  downloadName?: string;
  onRegenerate?: () => void;
}) {
  const t = useUiText();
  const [preview, setPreview] = useState<PreviewState>({ src, status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const status = preview.src === src ? preview.status : "loading";
  const naturalWidth = preview.src === src ? preview.width : undefined;
  const naturalHeight = preview.src === src ? preview.height : undefined;
  const imageWidth = naturalWidth || width;
  const imageHeight = naturalHeight || height;
  const ratio = imageWidth && imageHeight ? imageWidth / imageHeight : 1;
  const frameRatio = Math.min(3, Math.max(1 / 3, ratio));
  const sizeLabel = imageWidth && imageHeight ? `${imageWidth} × ${imageHeight} px` : dimensions;
  const title = name ?? downloadName ?? t("Imagen");
  const ready = Boolean(src) && !generating && status === "ready";
  const failed = Boolean(src) && !generating && status === "error";

  return (
    <div
      data-slot="image-generation"
      aria-busy={generating || (Boolean(src) && status === "loading") || undefined}
      className={cn("flex min-w-0 w-full max-w-full flex-col gap-3", className)}
      {...props}
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-[var(--text)]" title={title}>{title}</p>
        {sizeLabel ? <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{t("PNG ·")}{" "}{sizeLabel}</p> : null}
      </div>
      <div
        data-slot="image-preview"
        className={cn("relative max-w-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]", failed && "min-h-40")}
        style={{ aspectRatio: frameRatio, width: `min(100%, ${480 * frameRatio}px)` }}
      >
        {failed ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center text-sm text-[var(--text-secondary)]">
            <p role="alert">{t("No se ha podido cargar la imagen. Comprueba la conexión y vuelve a intentarlo.")}</p>
            <button type="button" className={imageAction} onClick={() => {
              setPreview({ src, status: "loading" });
              setAttempt((value) => value + 1);
            }}>{t("Volver a cargar")}</button>
          </div>
        ) : src && !generating ? (
          <>
            <a href={src} target="_blank" rel="noreferrer" className="absolute inset-0" aria-label={t("Ampliar {p0} (nueva pestaña)", { p0: title })}>
              <NextImage
                key={`${src}:${attempt}`}
                unoptimized
                fill
                sizes="(max-width: 640px) 100vw, 640px"
                src={src}
                alt={alt ?? prompt}
                className="object-contain"
                onLoad={(event) => setPreview({ src, status: "ready", width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                onError={() => setPreview({ src, status: "error" })}
              />
            </a>
            {status === "loading" ? <span role="status" className="pointer-events-none absolute inset-0 grid place-items-center bg-[var(--surface-muted)] text-sm text-[var(--text-secondary)]">{t("Cargando imagen…")}</span> : null}
          </>
        ) : <span role="status" className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-[var(--text-secondary)]">{generating ? t("Generando imagen…") : t("Imagen no disponible.")}</span>}
      </div>
      <details className="min-w-0 text-xs leading-5 text-[var(--text-secondary)]">
        <summary className="touch-target w-fit cursor-pointer rounded py-2 font-medium">{t("Ver descripción")}</summary>
        <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{prompt}</p>
      </details>
      {ready ? <div className="flex min-w-0 flex-wrap gap-2">
        <a href={src!} target="_blank" rel="noreferrer" aria-label={t("Ampliar imagen {p0} (nueva pestaña)", { p0: title })} className={imageAction}><ExpandIcon className="size-3.5" aria-hidden />{t("Ampliar")}</a>
        {downloadUrl ? <a href={downloadUrl} download={downloadName} aria-label={downloadName ? t("Descargar {nombre}", { nombre: downloadName }) : t("Descargar imagen")} className={imageAction}><DownloadIcon className="size-3.5" aria-hidden />{t("Descargar PNG")}</a> : null}
        {onRegenerate ? <button type="button" aria-label={t("Volver a generar la imagen")} onClick={onRegenerate} className={imageAction}><RefreshCwIcon className="size-3.5" aria-hidden />{t("Volver a generar")}</button> : null}
      </div> : null}
    </div>
  );
}
