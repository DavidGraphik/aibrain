import { describe, expect, it } from "vitest";
import { takeAppServerOutput } from "./app-server-output-buffer";
import { appServerStdoutJsonDiagnostic } from "./app-server-output-json";
const fragment = (text: string, threadId = "a", itemId = "answer") => JSON.stringify({
  method: "item/agentMessage/delta", params: { threadId, turnId: "turn", itemId, delta: text },
});
describe("durable stdout batching", () => {
  it("preserves a long structured answer while collapsing its queued token fragments", () => {
    const text = JSON.stringify({ horario: Array.from({ length: 210 }, (_, n) => ({ id: n, turno: "MAÑANA" })) });
    const queue = [...text].map(char => fragment(char));
    const batches: string[] = [];
    while (queue.length) batches.push(JSON.parse(takeAppServerOutput(queue)!).params.delta);
    expect(batches.join("")).toBe(text);
    expect(batches).toHaveLength(1);
  });
  it("never combines users, turns, items, tool calls or completion barriers", () => {
    const response = JSON.stringify({ id: "stop", result: {} });
    const complete = JSON.stringify({ method: "turn/completed", params: { threadId: "a", turn: { id: "turn", status: "completed" } } });
    const input = [fragment("one"), fragment("two", "b"), fragment("three", "a", "other"), response, complete, fragment("four")];
    const queue = [...input], output: string[] = [];
    while (queue.length) output.push(takeAppServerOutput(queue)!);
    expect(output).toEqual(input);
  });
  it("bounds each merged fragment and preserves malformed input as an error", () => {
    const queue = [fragment("x".repeat(40000)), fragment("y".repeat(40000))];
    expect(JSON.parse(takeAppServerOutput(queue)!).params.delta).toHaveLength(40000);
    expect(queue).toHaveLength(1);
    expect(() => takeAppServerOutput(["invalid"])).toThrow();
  });
  it("emits valid text before rejecting malformed lookahead without losing either", () => {
    const queue = [fragment("valid"), fragment(" text"), " \t"];
    expect(JSON.parse(takeAppServerOutput(queue)!).params.delta).toBe("valid text");
    expect(queue).toEqual([" \t"]);
    let error: unknown;
    try { takeAppServerOutput(queue); } catch (failure) { error = failure; }
    expect(error).toBeInstanceOf(SyntaxError);
    expect(appServerStdoutJsonDiagnostic(error)).toEqual({byteCount:2,prefixClass:"empty",parsePosition:null});
  });
});
