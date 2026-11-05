import { BackgroundModelAdmissionDeferred } from "@/runtime/model-turn-queue";

/** Fixed non-sensitive IPC classifications. Never relay provider error text. */
export function hostAnalysisFailure(error: unknown) {
  if (error instanceof BackgroundModelAdmissionDeferred) return {code:"HOST_ANALYSIS_CAPACITY_DEFERRED",exitCode:75};
  if (error instanceof Error && error.message === "HOST_QUEUE_TIMEOUT") return {code:"HOST_QUEUE_TIMEOUT",exitCode:76};
  if (error instanceof Error && error.message === "HOST_TERMINAL_TIMEOUT") return {code:"HOST_TERMINAL_TIMEOUT",exitCode:77};
  return {code:"HOST_ANALYSIS_UNAVAILABLE",exitCode:1};
}
