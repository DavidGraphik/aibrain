import { setTimeout as delay } from "node:timers/promises";
import type { HostAnalysisJob } from "./contracts";
type Store = { result(job: HostAnalysisJob, id: string): Promise<unknown>; cancel(job: HostAnalysisJob, id: string): Promise<unknown>; waitDeadline(job: HostAnalysisJob, id: string): Promise<number>; expire(job: HostAnalysisJob, id: string): Promise<boolean> };
export async function waitForHostAnalysis(input: { store: Store; job: HostAnalysisJob; requestId: string; signal: AbortSignal;
  now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> }) {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  try {
    while (true) {
      input.signal.throwIfAborted();
      const result = await input.store.result(input.job, input.requestId);
      if (result) return result; // terminal cached results stay readable; no new admission
      const deadline = await input.store.waitDeadline(input.job, input.requestId);
      if (now() >= deadline) {
        if (await input.store.expire(input.job, input.requestId)) {
          // Re-read the authenticated cancellation so CLI and worker expose
          // the same queue/terminal classification. No deadline is renewed.
          await input.store.waitDeadline(input.job, input.requestId);
          throw Error("HOST_ANALYSIS_TIMEOUT");
        }
        continue; // re-read after admission/terminal won the atomic expiry race
      }
      await sleep(Math.min(500, deadline - now()), input.signal);
    }
  } catch (error) {
    // Only explicit termination cancels. An uncertain read/transport error must
    // not overwrite a valid occurrence or cancel a concurrently completed turn.
    if (input.signal.aborted) await input.store.cancel(input.job, input.requestId).catch(() => undefined);
    throw error;
  }
}
