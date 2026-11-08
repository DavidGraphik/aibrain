import type { WorkbenchThread } from "@/workbench/types";

export function isUnboundAutomationThread(
  thread: WorkbenchThread,
  scope: { projectId: string; jobs: ReadonlySet<string>; prefix: string; restartedAt: string },
) {
  const job = thread.title.split(" · ")[0];
  const messages = thread.messages;
  const runPrefix = `Run Trinalum job \`${job}\` in review_only mode`;
  return thread.projectId === scope.projectId && thread.status === "active" &&
    scope.jobs.has(job) && /^\S+ · \d{4}-\d{2}-\d{2}T/.test(thread.title) &&
    Date.parse(thread.updatedAt) < Date.parse(scope.restartedAt) && messages.length === 2 &&
    messages[0].role === "user" && messages[0].status === "complete" &&
    messages[0].content.startsWith(scope.prefix) &&
    (messages[0].content.includes(runPrefix + ".") || messages[0].content.includes(runPrefix + " for\n")) &&
    messages[1].role === "assistant" && messages[1].status === "streaming" &&
    messages[1].content === "";
}
