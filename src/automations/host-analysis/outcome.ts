/** Reserve at most five of the fifteen terminal seconds for the runtime's
 * existing turn/interrupt acknowledgement. The remaining reserve belongs to
 * the native conversation and failed-run journal, never to more inference. */
export const HOST_INTERRUPT_GRACE_MS = 5_000;

export function hostAbortError(signal: AbortSignal) {
  return signal.reason instanceof Error && /^HOST_[A-Z_]+$/.test(signal.reason.message)
    ? signal.reason
    : Error("HOST_ANALYSIS_CANCELED");
}

/** Cancellation is cooperative inside the runtime, but an unresponsive RPC or
 * source reader must not keep the native occurrence open indefinitely. This
 * only bounds the local wait; it does not claim a remote interrupt succeeded.
 * Promise.race observes late rejections and the caller fences late events. */
export async function awaitHostTurn(run: () => Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    timer = setTimeout(() => rejectAbort(hostAbortError(signal)), HOST_INTERRUPT_GRACE_MS);
    timer.unref?.();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([run(), aborted]);
    if (signal.aborted) throw hostAbortError(signal);
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (timer) clearTimeout(timer);
  }
}

export function hostFailure(error: unknown, signal: AbortSignal) {
  const cause = signal.aborted ? hostAbortError(signal) : error;
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = /^(HOST|AUTOMATION)_[A-Z_]+$/.test(message) ? message : "HOST_MODEL_ERROR";
  const label = code === "HOST_EXECUTION_TIMEOUT"
    ? "Se ha agotado el tiempo de análisis. El resultado parcial no se ha aceptado."
    : code === "AUTOMATION_NON_READ_ONLY_RESULT" || code === "HOST_ANALYSIS_READ_ONLY"
      ? "El análisis ha intentado una acción fuera de los permisos autorizados."
      : code === "HOST_ANALYSIS_CANCELED"
        ? "El análisis se ha cancelado. El resultado parcial no se ha aceptado."
        : "El análisis no se ha completado. El resultado parcial no se ha aceptado.";
  return { code, label, ...(message !== code ? { output: message } : {}),
    ...(signal.aborted ? { cancellation: "Se ha solicitado la interrupción al runtime; este cierre local no acredita su confirmación." } : {}) };
}
