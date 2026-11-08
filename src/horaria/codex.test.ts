import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/runtime/worker-runtime-service", () => ({ acquireWorkerTurnActivity: vi.fn(), workerAppServerForUser: vi.fn() }));
import { codexInput, codexResult, runHorariaCodex } from "./codex";
import { bridgeToken, type HorariaConfig } from "./client";
import { verifyCodexRequest } from "./codex-auth";
import { acquireWorkerTurnActivity, workerAppServerForUser } from "@/runtime/worker-runtime-service";
describe("horarIA connected Codex", () => {
  it("binds internal requests to the mapped account, body, route and a single nonce", () => {
    const config = { installationId: "company", secret: "a-test-secret-longer-than-32-characters", users: { owner: { employeeId: 7, backgroundOperations: [] } } } as unknown as HorariaConfig;
    const body = Buffer.from("{}");
    const token = bridgeToken(config, { kind: "user", actorId: "owner", employeeId: 7, method: "POST", target: "/api/horaria-codex", contentType: "application/json", body });
    expect(() => verifyCodexRequest(config, token, Buffer.from("changed"))).toThrow();
    expect(() => verifyCodexRequest({ ...config, installationId: "other" }, token, body)).toThrow();
    expect(verifyCodexRequest(config, token, body)).toEqual({ userId: "owner", employeeId: 7 });
    expect(() => verifyCodexRequest(config, token, body)).toThrow();
  });
  it("translates structured outputs and accepts only attached inline images", () => {
    const tools = [{ name: "horario", input_schema: { type: "object" } }];
    expect(codexResult(JSON.stringify({ text: "", toolName: "horario", toolInput: '{"horario":[]}' }), tools).content[1]).toMatchObject({ type: "tool_use", name: "horario", input: { horario: [] } });
    expect(() => codexResult(JSON.stringify({ text: "", toolName: "send", toolInput: '{}' }), tools)).toThrow();
    expect(() => codexInput({ messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://other" } }] }] })).toThrow();
    expect(codexInput({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }] }).input[1]).toEqual({ type: "image", url: "data:image/png;base64,AAAA" });
  });
  it("uses the user's worker with tools disabled, releases maintenance and preserves the structured answer", async () => {
    const release = vi.fn(); const dispose = vi.fn(); const bindRuntimeTurn = vi.fn();
    vi.mocked(acquireWorkerTurnActivity).mockResolvedValue({ release } as never);
    let handlers: { onNotification: (value: unknown) => void };
    const request = vi.fn(async (method, params, _purpose, _timeout, beforeResolve) => {
      if (method === "thread/start") {
        expect(params.ephemeral).toBe(true); expect(params.environments).toEqual([]);
        expect(params.config["features.shell_tool"]).toBe(false);
        expect(params.config["features.apps"]).toBe(false);
        expect(params.model).toBeUndefined();
        return { thread: { id: "calculation" } };
      }
      if (method === "turn/start") {
        expect(params.effort).toBe("medium");
        beforeResolve({ turn: { id: "calculation-turn" } });
        handlers.onNotification({ method: "item/completed", params: { item: { type: "agentMessage", text: JSON.stringify({ text: "Calculated", toolName: "", toolInput: "" }) } } });
        handlers.onNotification({ method: "turn/completed", params: { turn: { status: "completed" } } });
      }
      return {};
    });
    vi.mocked(workerAppServerForUser).mockResolvedValue({ handle: { roots: { workspace: "/private/user" } }, client: { request, router: { registerTurn: (_a: string, _b: string, h: typeof handlers) => { handlers = h; return { bindRuntimeTurn, dispose }; } } } } as never);
    expect(await runHorariaCodex("owner", { messages: [{ role: "user", content: "Calculate" }] })).toEqual({ content: [{ type: "text", text: "Calculated" }] });
    expect(workerAppServerForUser).toHaveBeenCalledWith("owner", { release });
    expect(release).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
    expect(bindRuntimeTurn).toHaveBeenCalledWith("calculation-turn");
  });
});

describe("WhatsApp execution authority", () => {
  it("requires the currently enabled operator binding for every WhatsApp calculation", () => {
    const config: HorariaConfig = { installationId: "company", baseUrl: "http://horaria:3210", secret: "a-test-secret-longer-than-32-characters", users: { owner: { employeeId: 7, backgroundOperations: [] }, other: { employeeId: 8, backgroundOperations: [] } }, eventsEnabled: true, eventActorId: "owner" };
    const body = Buffer.from('{"authorizationOnly":true}');
    const token = () => bridgeToken(config, { kind: "user", source: "whatsapp", actorId: "owner", employeeId: 7, method: "POST", target: "/api/horaria-codex", contentType: "application/json", body });
    expect(() => verifyCodexRequest({ ...config, eventsEnabled: false }, token(), body)).toThrow();
    expect(() => verifyCodexRequest({ ...config, eventActorId: "other" }, token(), body)).toThrow();
    expect(() => verifyCodexRequest({ ...config, users: {} }, token(), body)).toThrow();
    expect(verifyCodexRequest(config, token(), body)).toEqual({ userId: "owner", employeeId: 7, source: "whatsapp" });
  });
});
