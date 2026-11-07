"use client";

import { useEffect, useState, type DragEvent } from "react";

const hasFiles = (transfer: DataTransfer | null) => Array.from(transfer?.types ?? []).includes("Files") || Boolean(transfer?.files?.length);

export function useComposerFileDrop(options: {
  enabled: boolean;
  selection: string;
  onFiles: (files: File[]) => void;
  onNotice: (message: string) => void;
}) {
  const [activeSelection, setActiveSelection] = useState<string | null>(null);
  useEffect(() => {
    // A missed drop must never navigate away from an unsent draft.
    const preventNavigation = (event: globalThis.DragEvent) => {
      if (hasFiles(event.dataTransfer)) event.preventDefault();
      if (event.type === "drop") setActiveSelection(null);
    };
    const clear = () => setActiveSelection(null);
    window.addEventListener("dragover", preventNavigation);
    window.addEventListener("drop", preventNavigation);
    window.addEventListener("dragend", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("dragover", preventNavigation);
      window.removeEventListener("drop", preventNavigation);
      window.removeEventListener("dragend", clear);
      window.removeEventListener("blur", clear);
    };
  }, []);
  return {
    dragActive: options.enabled && activeSelection === options.selection,
    dropProps: {
      onDragEnter(event: DragEvent<HTMLElement>) {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        if (options.enabled) setActiveSelection(options.selection);
      },
      onDragOver(event: DragEvent<HTMLElement>) {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = options.enabled ? "copy" : "none";
      },
      onDragLeave(event: DragEvent<HTMLElement>) {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setActiveSelection(null);
      },
      onDrop(event: DragEvent<HTMLElement>) {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        setActiveSelection(null);
        if (!options.enabled) return;
        const items = Array.from(event.dataTransfer.items ?? []).filter((item) => item.kind === "file");
        const hasDirectory = items.some((item) => item.webkitGetAsEntry?.()?.isDirectory);
        if (hasDirectory) options.onNotice("Las carpetas no se pueden adjuntar. Selecciona archivos individuales.");
        const itemFiles = items
          .filter((item) => !item.webkitGetAsEntry?.()?.isDirectory)
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null);
        // Finder can expose protected DataTransferItems whose getAsFile()
        // returns null even though the same drop has a populated FileList.
        // Fall back to that canonical list so native drops share the selector
        // pipeline instead of being silently discarded.
        const files = itemFiles.length ? itemFiles : Array.from(event.dataTransfer.files);
        if (files.length) options.onFiles(files);
      },
    },
  };
}
