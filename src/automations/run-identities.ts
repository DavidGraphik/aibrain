import { createHash } from 'node:crypto';
export function automationRunUuid(value: string) {
  const chars = createHash('sha256').update(value).digest('hex').slice(0,32).split('');
  chars[12]='4'; chars[16]='8'; const hex=chars.join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function automationRunIdentities(runKey: string) {
  return { threadId:automationRunUuid(`${runKey}:workbench-thread`), userMessageId:automationRunUuid(`${runKey}:user`), assistantMessageId:automationRunUuid(`${runKey}:assistant`) };
}

/** Recurring results share one conversation. Project/owner/tenant are part of
 * its identity; moving a task never imports a former project's conversation.
 * Message identities remain occurrence-scoped for recovery and exact readback. */
type TaskConversationIdentity = {id:string;projectId:string;userId:string;installationId:string;schedule:{kind:string}};
function taskConversationId(task:TaskConversationIdentity) {
  return automationRunUuid(`${task.installationId}:${task.userId}:${task.projectId}:${task.id}:automation-conversation`);
}
export function automationTaskThreadId(task:TaskConversationIdentity) {
  return task.schedule.kind === "once" || task.schedule.kind === "external" ? null : taskConversationId(task);
}
export function isAutomationResultThread(task: Parameters<typeof automationTaskThreadId>[0], runKey:string, threadId:string) {
  return threadId === automationRunIdentities(runKey).threadId || threadId === taskConversationId(task);
}
