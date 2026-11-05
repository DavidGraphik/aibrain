"use client";
import { useUiText } from "@/i18n/provider";

import { useEffect, useRef, useState, type RefObject } from "react";
import { WarningCircle, X } from "@phosphor-icons/react";
import { useModalFocus } from "@/ui/use-modal-focus";

export function TextDialog({
  open,
  title,
  label,
  initialValue = "",
  maxLength = 120,
  submitLabel,
  busy,
  returnFocusRef,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  label: string;
  initialValue?: string;
  maxLength?: number;
  submitLabel: string;
  busy: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSubmit: (value: string) => void;
}) {
  const t = useUiText();
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalFocus<HTMLFormElement>(open, onClose, inputRef, returnFocusRef);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      setValue(initialValue);
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [initialValue, open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/15 px-4 backdrop-blur-[1px]">
      <button aria-label={t("Cerrar diálogo")} className="absolute inset-0" onClick={onClose} />
      <form
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="text-dialog-title"
        className="dialog-enter relative max-h-[calc(100dvh-2rem)] w-full max-w-[448px] overflow-y-auto rounded-[24px] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-6 shadow-[var(--shadow-popover)]"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim() && !busy) onSubmit(value.trim());
        }}
      >
        <div className="flex items-center justify-between gap-4">
          <h2 id="text-dialog-title" className="text-[18px] font-semibold tracking-[-0.02em] text-[var(--text)]">{title}</h2>
          <button type="button" aria-label={t("Cerrar")} className="grid size-9 place-items-center rounded-full text-[var(--text-subtle)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onClick={onClose}><X size={16} /></button>
        </div>
        <label className="mt-5 block">
          <span className="mb-2 block text-[13px] font-medium text-[var(--text-secondary)]">{label}</span>
          <input
            ref={inputRef}
            className="w-full rounded-[14px] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-[14px] text-[var(--text)] outline-none transition focus:border-[var(--brain-accent)] focus:shadow-[0_0_0_3px_var(--brain-accent-soft)]"
            value={value}
            maxLength={maxLength}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="min-h-10 rounded-full px-4 text-[13px] font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onClick={onClose}>{t("Cancelar")}</button>
          <button type="submit" disabled={busy || !value.trim()} className="min-h-10 rounded-full bg-[var(--brain-accent)] px-5 text-[13px] font-semibold text-[var(--brain-contrast)] transition active:scale-[.98] disabled:opacity-40">{busy ? t("Guardando…") : submitLabel}</button>
        </div>
      </form>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy,
  returnFocusRef,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useUiText();
  const dialogRef = useModalFocus<HTMLDivElement>(open, onClose, undefined, returnFocusRef);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/15 px-4 backdrop-blur-[1px]">
      <button aria-label={t("Cerrar confirmación")} className="absolute inset-0" onClick={onClose} />
      <div ref={dialogRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" className="dialog-enter relative max-h-[calc(100dvh-2rem)] w-full max-w-[448px] overflow-y-auto rounded-[24px] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-6 shadow-[var(--shadow-popover)]">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-[var(--warning-soft)] text-[var(--warning)]"><WarningCircle size={17} /></span>
          <div>
            <h2 id="confirm-title" className="text-[18px] font-semibold tracking-[-0.02em] text-[var(--text)]">{title}</h2>
            <p className="mt-2 text-[13px] leading-5 text-[var(--text-muted)]">{description}</p>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button className="min-h-10 rounded-full px-4 text-[13px] font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onClick={onClose}>{t("Cancelar")}</button>
          <button disabled={busy} className="min-h-10 rounded-full bg-[var(--danger)] px-5 text-[13px] font-semibold text-[var(--danger-contrast)] transition active:scale-[.98] disabled:opacity-40" onClick={onConfirm}>{busy ? t("Archivando…") : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
