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
    let next: ReturnType<typeof delta>;
    try { next = delta(lines[0]); }
    catch (error) {
      // Keep the invalid record queued so it still fails closed on the next
      // iteration, after the preceding valid output has been persisted.
      if (error instanceof SyntaxError) break;
      throw error;
    }
    if (!next || next.scope !== initial.scope ||
        Buffer.byteLength(text + next.text, "utf8") > 64 * 1024) break;
    lines.shift(); text += next.text; merged = true;
  }
  return merged ? JSON.stringify({ ...initial.value, params: { ...initial.value.params, delta: text } }) : first;
}

/** Group available notifications without adding a timer or collapsing their
 * identities. RPCs/auth remain barriers; each group is durable before delivery. */
export function takeAppServerOutputBatch(lines: string[]) {
  const first = takeAppServerOutput(lines);
  if (first === null) return [];
  const batch = [first];
  const notification = (line: string) => {
    const value = parseAppServerStdoutJson(line);
    return value && typeof value === "object" && !Array.isArray(value) && !("id" in value) && typeof value.method === "string";
  };
  if (!notification(first)) return batch;
  let bytes = Buffer.byteLength(first);
  while (lines.length && batch.length < 32) {
    try {
      if (!notification(lines[0]) || bytes + Buffer.byteLength(lines[0]) > 256 * 1024) break;
    } catch (error) {
      if (error instanceof SyntaxError) break; // Preserve the valid prefix before failing closed.
      throw error;
    }
    const next = takeAppServerOutput(lines)!;
    const nextBytes = Buffer.byteLength(next);
    // Coalescing can grow the peeked raw fragment. Keep that intact for the
    // next group rather than exceeding this group's exact byte boundary.
    if (bytes + nextBytes > 256 * 1024) { lines.unshift(next); break; }
    bytes += nextBytes; batch.push(next);
  }
  return batch;
}
