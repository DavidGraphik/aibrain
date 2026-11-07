"use client";
import { useUiText } from "@/i18n/provider";

import { Microphone, SpeakerHigh, Stop, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

type RecognitionResultLike = {
  isFinal: boolean;
  0: { transcript: string };
};

type RecognitionEventLike = Event & {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
};

type RecognitionErrorEventLike = Event & { error?: string };

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: RecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

type DictationState = "idle" | "requesting" | "listening" | "processing" | "error";

const DICTATION_CONSENT_KEY = "aibrain.voice.dictation-consent.v1";
const READ_RATE_KEY = "aibrain.voice.read-rate.v1";
const subscribeToNoEvents = () => () => undefined;

function recognitionConstructor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function recognitionError(error?: string) {
  if (error === "service-not-allowed") return "El servicio de reconocimiento de voz está bloqueado en este navegador. Prueba un navegador compatible o usa el dictado del teclado.";
  if (error === "not-allowed") {
    return "No se ha autorizado el micrófono. Revisa los permisos del sitio y del sistema y vuelve a intentarlo.";
  }
  if (error === "audio-capture") return "No se ha encontrado un micrófono disponible.";
  if (error === "no-speech") return "No se ha detectado voz. Puedes intentarlo de nuevo o escribir el mensaje.";
  if (error === "network") return "El servicio de voz del navegador no está disponible ahora mismo.";
  return "No se ha podido completar el dictado. El texto anterior sigue intacto.";
}

function microphonePermissionError(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "No se ha autorizado el micrófono. Revisa los permisos del sitio y del sistema y vuelve a intentarlo.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No se ha encontrado un micrófono disponible.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "El micrófono está ocupado por otra aplicación o no se puede leer.";
  }
  return "No se ha podido solicitar acceso al micrófono.";
}

export type VoiceNoticeKind = "status" | "success" | "warning" | "error";

function anchoredDialogFocusables(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => element.tabIndex >= 0);
}

function useAnchoredDialogFocus(
  open: boolean,
  onDismiss: (restoreFocus: boolean) => void,
  initialFocusRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      initialFocusRef.current?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (dialogRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      dismissRef.current(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissRef.current(true);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = anchoredDialogFocusables(dialog);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [initialFocusRef, open, triggerRef]);

  return dialogRef;
}

export function VoiceDictationControl({
  value,
  disabled,
  language = "es-ES",
  onChange,
  onNotice,
}: {
  value: string;
  disabled: boolean;
  language?: string;
  onChange: (value: string) => void;
  onNotice?: (message: string, kind: VoiceNoticeKind) => void;
}) {
  const t = useUiText();
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const startingValueRef = useRef("");
  const finalTranscriptRef = useRef("");
  const cancelledRef = useRef(false);
  const failedRef = useRef(false);
  const processingTimerRef = useRef<number | null>(null);
  const startAttemptRef = useRef(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const stopButtonRef = useRef<HTMLButtonElement>(null);
  const consentDeclineRef = useRef<HTMLButtonElement>(null);
  const fallbackDismissRef = useRef<HTMLButtonElement>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [permissionHelp, setPermissionHelp] = useState(false);
  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState<string | null>(null);
  const closePopover = useCallback((restoreFocus: boolean) => {
    setConsentOpen(false);
    setFallbackOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);
  const dictationDialogRef = useAnchoredDialogFocus(
    consentOpen || fallbackOpen,
    closePopover,
    consentOpen ? consentDeclineRef : fallbackDismissRef,
    triggerRef,
  );

  useEffect(() => {
    return () => {
      startAttemptRef.current += 1;
      cancelledRef.current = true;
      recognitionRef.current?.abort();
      if (processingTimerRef.current !== null) window.clearTimeout(processingTimerRef.current);
    };
  }, []);

  const finishProcessing = () => {
    setState("processing");
    if (processingTimerRef.current !== null) window.clearTimeout(processingTimerRef.current);
    processingTimerRef.current = window.setTimeout(() => {
      setState("idle");
      processingTimerRef.current = null;
      onNotice?.(t("Dictado añadido. Revísalo y edítalo antes de enviar."), "success");
      requestAnimationFrame(() => triggerRef.current?.focus());
    }, 350);
  };

  const start = async () => {
    const Recognition = recognitionConstructor();
    if (!Recognition) {
      setFallbackOpen(true);
      return;
    }

    setConsentOpen(false);
    setFallbackOpen(false);
    setError(null);
    setPermissionHelp(false);
    setState("processing");
    cancelledRef.current = false;
    failedRef.current = false;
    startingValueRef.current = value;
    finalTranscriptRef.current = "";
    const attempt = ++startAttemptRef.current;
    if (window.isSecureContext === false || !navigator.mediaDevices?.getUserMedia) {
      const message = t("El micrófono necesita una conexión HTTPS y un navegador compatible.");
      setError(message);
      setState("error");
      setFallbackOpen(true);
      onNotice?.(message, "error");
      requestAnimationFrame(() => triggerRef.current?.focus());
      return;
    }
    const policyDocument = document as Document & { permissionsPolicy?: { allowsFeature: (feature: string) => boolean }; featurePolicy?: { allowsFeature: (feature: string) => boolean } };
    const policy = policyDocument.permissionsPolicy ?? policyDocument.featurePolicy;
    if (policy && !policy.allowsFeature("microphone")) {
      const message = t("Esta página está bloqueando el micrófono. Recarga la página; si persiste, contacta con el administrador de la aplicación.");
      setError(message); setState("error"); setFallbackOpen(true);
      onNotice?.(message, "error");
      return;
    }
    setState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
    } catch (reason) {
      if (attempt !== startAttemptRef.current) return;
      setPermissionHelp(reason instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(reason.name));
      const message = t(microphonePermissionError(reason));
      setError(message);
      setState("error");
      setFallbackOpen(true);
      onNotice?.(message, "error");
      requestAnimationFrame(() => triggerRef.current?.focus());
      return;
    }
    if (attempt !== startAttemptRef.current || cancelledRef.current) return;
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = language;
    recognition.onstart = () => {
      setState("listening");
      requestAnimationFrame(() => stopButtonRef.current?.focus());
    };
    recognition.onresult = (event) => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript?.trim() ?? "";
        if (!transcript) continue;
        if (result.isFinal) finalTranscriptRef.current = `${finalTranscriptRef.current} ${transcript}`.trim();
        else interim = `${interim} ${transcript}`.trim();
      }
      const spoken = [finalTranscriptRef.current, interim].filter(Boolean).join(" ");
      const prefix = startingValueRef.current.trimEnd();
      onChange([prefix, spoken].filter(Boolean).join(prefix ? " " : ""));
    };
    recognition.onerror = (event) => {
      if (cancelledRef.current) return;
      setPermissionHelp(event.error === "not-allowed");
      const message = t(recognitionError(event.error));
      failedRef.current = true;
      setError(message);
      setState("error");
      setFallbackOpen(true);
      onNotice?.(message, "error");
      requestAnimationFrame(() => triggerRef.current?.focus());
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      if (cancelledRef.current || failedRef.current) return;
      finishProcessing();
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      const message = t("El micrófono ya está en uso o no ha podido iniciarse.");
      setError(message);
      setState("error");
      setFallbackOpen(true);
      onNotice?.(message, "error");
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  const requestStart = () => {
    if (!recognitionConstructor()) {
      setFallbackOpen(true);
      return;
    }
    if (localStorage.getItem(DICTATION_CONSENT_KEY) !== "accepted") {
      setConsentOpen(true);
      return;
    }
    void start();
  };

  const confirmConsent = () => {
    localStorage.setItem(DICTATION_CONSENT_KEY, "accepted");
    void start();
  };

  const stop = () => {
    setState("processing");
    recognitionRef.current?.stop();
  };

  const cancel = () => {
    startAttemptRef.current += 1;
    cancelledRef.current = true;
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    onChange(startingValueRef.current);
    setState("idle");
    setError(null);
    onNotice?.(t("Dictado cancelado. No se ha enviado nada."), "status");
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const active = state === "listening" || state === "processing";
  return (
    <div className="relative shrink-0">
      {state === "listening" ? (
        <div className="flex items-center gap-1" role="group" aria-label={t("Dictado activo")}>
          <span className="hidden items-center gap-1 text-[10px] font-medium text-[var(--danger)] sm:flex" role="status">
            <span className="size-1.5 animate-pulse rounded-full bg-[var(--danger)] motion-reduce:animate-none" />{t("Escuchando")}{" "}</span>
          <button ref={stopButtonRef} type="button" className="composer-tool !grid !size-8 !place-items-center !rounded-full text-[var(--danger)] sm:!rounded-full" aria-label={t("Terminar dictado")} title={t("Terminar dictado")} onClick={stop}><Stop size={12} weight="fill" /></button>
          <button type="button" className="composer-tool !grid !size-8 !place-items-center !rounded-full sm:!rounded-full" aria-label={t("Cancelar dictado")} title={t("Cancelar y descartar dictado")} onClick={cancel}><X size={14} /></button>
        </div>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          className={`composer-tool !grid !size-8 !place-items-center !rounded-full sm:!rounded-full ${state === "error" ? "text-[var(--danger)]" : ""}`}
          aria-label={state === "requesting" ? t("Esperando permiso del micrófono") : state === "processing" ? t("Procesando dictado") : t("Dictar mensaje")}
          title={state === "requesting" ? t("Esperando permiso del micrófono") : state === "processing" ? t("Procesando dictado") : t("Dictar mensaje")}
          aria-haspopup="dialog"
          aria-expanded={consentOpen || fallbackOpen}
          disabled={disabled || state === "processing" || state === "requesting"}
          onClick={requestStart}
        >
          <Microphone size={15} className={state === "processing" ? "motion-safe:animate-pulse" : ""} />
        </button>
      )}

      {consentOpen ? (
        <div ref={dictationDialogRef} role="dialog" aria-label={t("Permiso para dictar")} tabIndex={-1} className="menu-enter absolute bottom-full right-0 z-40 mb-2 w-[min(320px,calc(100vw-2rem))] rounded-[18px] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-4 text-left shadow-[var(--shadow-popover)]">
          <p className="text-[12px] font-semibold text-[var(--text)]">{t("Usar el micrófono para dictar")}</p>
          <p className="mt-1.5 text-[11px] leading-4 text-[var(--text-subtle)]">{t("El navegador procesa tu voz con su propio servicio y añadirá el texto al mensaje. La aplicación no recibe audio ni lo guarda, y nunca enviará el mensaje automáticamente.")}</p>
          <div className="mt-3 flex justify-end gap-2">
            <button ref={consentDeclineRef} type="button" className="min-h-10 rounded-full px-3 text-[11px] font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]" onClick={() => closePopover(true)}>{t("Ahora no")}</button>
            <button type="button" className="min-h-10 rounded-full bg-[var(--brain-accent)] px-4 text-[11px] font-semibold text-[var(--brain-contrast)]" onClick={confirmConsent}>{t("Activar dictado")}</button>
          </div>
        </div>
      ) : null}

      {state === "requesting" ? <p role="status" className="sr-only">{t("Responde a la solicitud de permiso del navegador para continuar.")}</p> : null}

      {fallbackOpen ? (
        <div ref={dictationDialogRef} role="dialog" aria-label={error ? t("Revisar el micrófono") : t("Dictado no disponible")} tabIndex={-1} className="menu-enter absolute bottom-full right-0 z-40 mb-2 w-[min(320px,calc(100vw-2rem))] rounded-[18px] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-4 text-left shadow-[var(--shadow-popover)]">
          <p className="text-[12px] font-semibold text-[var(--text)]">{error ? t("Revisar el micrófono") : t("Dictado no disponible")}</p>
          {error ? <><p role="alert" className="mt-2 text-[12px] leading-5">{error}</p>{permissionHelp ? <p className="mt-2 text-[11px] leading-4 text-[var(--text-subtle)]">{t("Chrome: abre el icono de controles junto a la dirección → Configuración del sitio → Micrófono → Permitir. Safari: revisa los permisos de este sitio. Si ya está permitido, revisa el acceso al micrófono del navegador en los ajustes de privacidad del sistema. En móvil puedes usar el dictado del teclado.")}</p> : null}<button type="button" className="mt-3 min-h-10 w-full rounded-full border border-[var(--border)] text-[11px] font-semibold" onClick={() => void start()}>{permissionHelp ? t("Volver a solicitar permiso") : t("Reintentar dictado")}</button></> : <p className="mt-1.5 text-[11px] leading-4 text-[var(--text-subtle)]">{t("Este navegador no ofrece dictado. Escribe o pega el texto en el mensaje. Esta instalación tampoco publica una transcripción de archivos de audio, así que no la simulamos.")}</p>}
          <button ref={fallbackDismissRef} type="button" className="mt-3 min-h-10 w-full rounded-full border border-[var(--border)] text-[11px] font-semibold text-[var(--text)] hover:bg-[var(--surface-hover)]" onClick={() => closePopover(true)}>{t("Entendido")}</button>
        </div>
      ) : null}

      {error && !active && !fallbackOpen ? <span className="sr-only" role="alert">{error}</span> : null}
    </div>
  );
}

const READ_RATES = [0.75, 1, 1.25, 1.5] as const;

export function ReadAloudControl({ text, language = "es-ES" }: { text: string; language?: string }) {
  const t = useUiText();
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rateSelectRef = useRef<HTMLSelectElement>(null);
  const [open, setOpen] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [rate, setRate] = useState<number>(() => {
    if (typeof window === "undefined") return 1;
    const stored = Number(localStorage.getItem(READ_RATE_KEY));
    return READ_RATES.includes(stored as (typeof READ_RATES)[number]) ? stored : 1;
  });
  const supported = useSyncExternalStore(
    subscribeToNoEvents,
    () => typeof window.speechSynthesis !== "undefined" && typeof window.SpeechSynthesisUtterance !== "undefined",
    () => false,
  );
  const closePopover = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);
  const readDialogRef = useAnchoredDialogFocus(open, closePopover, rateSelectRef, triggerRef);

  useEffect(() => {
    return () => {
      const utterance = utteranceRef.current;
      if (utterance) window.speechSynthesis?.cancel();
    };
  }, []);

  const stop = () => {
    window.speechSynthesis.cancel();
    utteranceRef.current = null;
    setSpeaking(false);
  };

  const read = () => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = language;
    utterance.rate = rate;
    utterance.onend = () => { utteranceRef.current = null; setSpeaking(false); };
    utterance.onerror = () => { utteranceRef.current = null; setSpeaking(false); };
    utteranceRef.current = utterance;
    setSpeaking(true);
    closePopover(true);
    window.speechSynthesis.speak(utterance);
  };

  if (!supported) return null;
  return (
    <div className="relative">
      <button ref={triggerRef} type="button" title={speaking ? t("Detener lectura") : t("Leer en voz alta")} aria-label={speaking ? t("Detener lectura") : t("Leer en voz alta")} aria-expanded={open} aria-haspopup="dialog" className={`result-action ${speaking ? "text-[var(--brain-accent)]" : ""}`} onClick={() => speaking ? stop() : setOpen((current) => !current)}>{speaking ? <Stop size={13} weight="fill" /> : <SpeakerHigh size={14} />}</button>
      {open ? (
        <div ref={readDialogRef} role="dialog" aria-label={t("Lectura en voz alta")} tabIndex={-1} className="menu-enter absolute bottom-full left-0 z-30 mb-2 w-56 rounded-[18px] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3 shadow-[var(--shadow-popover)]">
          <p className="text-[11px] font-semibold text-[var(--text)]">{t("Leer esta respuesta")}</p>
          <label className="mt-2 block text-[10px] text-[var(--text-subtle)]">{t("Velocidad")}{" "}<select ref={rateSelectRef} aria-label={t("Velocidad de lectura")} className="mt-1 min-h-10 w-full rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-2 text-[11px] text-[var(--text)]" value={rate} onChange={(event) => { const next = Number(event.target.value); setRate(next); localStorage.setItem(READ_RATE_KEY, String(next)); }}>
              {READ_RATES.map((option) => <option key={option} value={option}>{option === 1 ? "Normal" : `${option}×`}</option>)}
            </select>
          </label>
          <p className="mt-2 text-[9px] leading-3 text-[var(--text-subtle)]">{t("La voz se genera en tu navegador. La velocidad queda guardada solo en este dispositivo.")}</p>
          <button type="button" className="mt-3 min-h-10 w-full rounded-full bg-[var(--brain-accent)] px-3 text-[11px] font-semibold text-[var(--brain-contrast)]" onClick={read}>{t("Reproducir")}</button>
        </div>
      ) : null}
    </div>
  );
}
