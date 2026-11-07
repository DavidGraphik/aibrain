import type { AutomationTask } from "@/automations/contracts";
import type { ChatMessage } from "@/lib/chat-contract";
import { MODEL_CAPACITY_MESSAGE } from "@/runtime/model-capacity-retry";

/** A scheduled read-only occurrence can resume after a terminal capacity
 * failure. Stable suffixes preserve failed evidence and fence replay after
 * restart. Never start a fresh submission for an uncertain or effectful run. */
export function capacityContinuationKey(task: AutomationTask, runKey: string, messages: readonly ChatMessage[], id: (key: string) => string) {
  let key = runKey;
  if (task.schedule.kind === "external" || task.executionContext.allowedEffects?.length || task.executionContext.effectGrant) return key;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user = messages.find(message => message.id === id(`${key}:user`));
    const assistant = messages.find(message => message.id === id(`${key}:assistant`));
    if (user?.role !== "user" || user.status !== "complete" || user.content !== task.prompt ||
        assistant?.role !== "assistant" || assistant.status !== "error" || assistant.content !== MODEL_CAPACITY_MESSAGE ||
        assistant.approvals.length || assistant.toolResults?.some(result => result.status === "running")) break;
    key = `${runKey}:capacity-continuation:${attempt}`;
  }
  return key;
}
