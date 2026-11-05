import { parseAppServerStdoutJson } from "./app-server-output-json";

/** Coalesce only adjacent text fragments before assigning durable event IDs.
 * Replies, tool calls, scope changes and completion events are strict barriers.
 * No delivered or persisted event is rewritten or dropped.
 */
function delta(line: string) {
  const value = parseAppServerStdoutJson(line);
  if (!value || typeof value !== "object" || Array.isArray(value) || "id" in value ||
      value.method !== "item/agentMessage/delta" || !value.params ||
      typeof value.params !== "object" || Array.isArray(value.params) ||
      typeof value.params.delta !== "string") return null;
  const { delta: text, ...scope } = value.params;
  if (typeof scope.threadId !== "string" || typeof scope.turnId !== "string" || typeof scope.itemId !== "string") return null;
  return { value, text: text as string, scope: JSON.stringify(scope) };
}

export function takeAppServerOutput(lines: string[]) {
  const first = lines.shift();
  if (first === undefined) return null;
  const initial = delta(first);
  if (!initial) return first;
  let text = initial.text;
  let merged = false;
  while (lines.length && Buffer.byteLength(text, "utf8") < 64 * 1024) {
    const next = delta(lines[0]);
    if (!next || next.scope !== initial.scope ||
        Buffer.byteLength(text + next.text, "utf8") > 64 * 1024) break;
    lines.shift(); text += next.text; merged = true;
  }
  return merged ? JSON.stringify({ ...initial.value, params: { ...initial.value.params, delta: text } }) : first;
}
