import type { ChatStreamEvent } from "@/lib/chat-contract";

type FrameScheduler = {
  request: (callback: () => void) => number;
  cancel: (handle: number) => void;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
};

type FrameDispatcherOptions = {
  onEventApplied?: (event: ChatStreamEvent) => void;
};

const browserScheduler: FrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs) as unknown as ReturnType<typeof setTimeout>,
  clearTimeout: (handle) => window.clearTimeout(handle as unknown as number),
};

/** A backgrounded or congested tab must not hold visible text indefinitely. */
export const CHAT_DELTA_MAX_BATCH_WAIT_MS = 48;

export function createChatEventFrameDispatcher(
  onEvent: (event: ChatStreamEvent) => void,
  scheduler: FrameScheduler = browserScheduler,
  options: FrameDispatcherOptions = {},
) {
  let pendingDelta = "";
  let frame: number | null = null;
  let fallback: ReturnType<typeof setTimeout> | null = null;
  let firstDeltaApplied = false;
  let closed = false;

  const cancelScheduledFlush = () => {
    if (frame !== null) scheduler.cancel(frame);
    frame = null;
    if (fallback !== null) scheduler.clearTimeout?.(fallback);
    fallback = null;
  };

  const applyDelta = (value: string) => {
    const event: ChatStreamEvent = { type: "delta", value };
    onEvent(event);
    options.onEventApplied?.(event);
  };

  const flushAll = () => {
    cancelScheduledFlush();
    if (!pendingDelta || closed) return;
    const value = pendingDelta;
    pendingDelta = "";
    applyDelta(value);
  };

  const scheduleFlush = () => {
    if (frame !== null) return;
    // Coalesce arrivals within one paint opportunity, never pace or subdivide
    // provider text. The fallback also drains the entire batch in hidden tabs.
    frame = scheduler.request(flushAll);
    fallback = scheduler.setTimeout?.(flushAll, CHAT_DELTA_MAX_BATCH_WAIT_MS) ?? null;
  };

  return {
    dispatch(event: ChatStreamEvent) {
      if (closed) return;
      if (event.type === "delta") {
        if (!event.value) return;
        // Apply the first non-empty delta synchronously. React still commits it
        // on its normal paint boundary, while the user avoids paying an extra
        // animation frame before the response can become visible.
        if (!firstDeltaApplied && !pendingDelta && frame === null && event.value) {
          firstDeltaApplied = true;
          applyDelta(event.value);
          return;
        }
        pendingDelta += event.value;
        scheduleFlush();
        return;
      }
      flushAll();
      onEvent(event);
      options.onEventApplied?.(event);
    },
    close() {
      if (closed) return;
      flushAll();
      closed = true;
    },
  };
}
