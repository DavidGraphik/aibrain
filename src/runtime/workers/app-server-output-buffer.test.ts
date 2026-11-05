import { describe, expect, it } from "vitest";
import { takeAppServerOutput, takeAppServerOutputBatch } from "./app-server-output-buffer";
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

describe("bounded notification groups", () => {
  const note = (id: number) => JSON.stringify({method:"warning",params:{threadId:null,message:String(id)}});
  it("keeps identities and order while leaving RPC and auth barriers queued", () => {
    const request=JSON.stringify({id:0,method:"item/tool/call",params:{}});
    const auth=JSON.stringify({id:"auth",method:"account/chatgptAuthTokens/refresh",params:{}});
    const queue=[note(1),note(2),request,note(3),auth];
    expect(takeAppServerOutputBatch(queue)).toEqual([note(1),note(2)]);
    expect(takeAppServerOutputBatch(queue)).toEqual([request]);
    expect(takeAppServerOutputBatch(queue)).toEqual([note(3)]);
    expect(takeAppServerOutputBatch(queue)).toEqual([auth]);
  });
  it("enforces the byte boundary after text coalescing without dropping its tail", () => {
    const large=JSON.stringify({method:"warning",params:{threadId:null,message:"x".repeat(70000)}});
    const queue=[large,large,large,...Array.from({length:10},()=>fragment("y".repeat(10000)))];
    const first=takeAppServerOutputBatch(queue);
    expect(first).toHaveLength(3);
    expect(first.reduce((bytes,line)=>bytes+Buffer.byteLength(line),0)).toBeLessThanOrEqual(256*1024);
    const tail:string[]=[];while(queue.length)tail.push(...takeAppServerOutputBatch(queue));
    expect(tail.map(line=>JSON.parse(line).params.delta).join("")).toBe("y".repeat(100000));
  });
  it("bounds groups and preserves a valid prefix before a malformed record", () => {
    const queue=Array.from({length:35},(_,i)=>note(i));
    expect(takeAppServerOutputBatch(queue)).toHaveLength(32);expect(queue).toHaveLength(3);
    queue.push("{invalid");expect(takeAppServerOutputBatch(queue)).toHaveLength(3);
    expect(queue).toEqual(["{invalid"]);expect(()=>takeAppServerOutputBatch(queue)).toThrow(SyntaxError);
    const large=JSON.stringify({method:"warning",params:{threadId:null,message:"x".repeat(200000)}});
    expect(takeAppServerOutputBatch([large,large])).toHaveLength(1);
  });
});
