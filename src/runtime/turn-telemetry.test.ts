import { describe, expect, it } from "vitest";
import { TurnTelemetry } from "@/runtime/turn-telemetry";

describe("turn telemetry", () => {
  it("records payload-free phase timing for successful and failed setup work", async () => {
    let now = 2_000;
    const records: Array<{ event: string; attributes: Record<string, unknown> }> = [];
    const telemetry = new TurnTelemetry({
      installationId: "qa-company",
      userId: "00000000-0000-4000-8000-000000000001",
      projectId: "project-1",
      threadId: "thread-1",
      localTurnId: "turn-local-1",
      clientRequestId: "request-1",
    }, {
      now: () => now,
      logger: { info: (event, attributes = {}) => records.push({ event, attributes: { ...attributes } }) },
    });

    await telemetry.measure("memory", async () => {
      now = 2_014;
      return "ready";
    });
    await expect(telemetry.measure("catalog", async () => {
      now = 2_035;
      throw new Error("sensitive catalog error");
    })).rejects.toThrow("sensitive catalog error");

    expect(records).toEqual([
      expect.objectContaining({
        event: "codex.turn_phase",
        attributes: expect.objectContaining({ phase: "memory", outcome: "completed", phaseMs: 14 }),
      }),
      expect.objectContaining({
        event: "codex.turn_phase",
        attributes: expect.objectContaining({ phase: "catalog", outcome: "error", phaseMs: 21 }),
      }),
    ]);
    expect(JSON.stringify(records)).not.toMatch(/sensitive catalog error|prompt|content|token|secret/iu);
  });

  it("records queue wait and connector resolution without exposing their result or error", async () => {
    let now=10_000;
    const records: Array<{event:string;attributes:Record<string,unknown>}> = [];
    const telemetry=new TurnTelemetry({installationId:"qa",userId:"user",projectId:"project",threadId:"thread",localTurnId:"turn",clientRequestId:"request"},{now:()=>now,logger:{info:(event,attributes={})=>records.push({event,attributes:{...attributes}})}});
    const lease={complete:async()=>{}};
    expect(await telemetry.measure("model_queue",async()=>{now+=31_000;return lease;})).toBe(lease);
    await expect(telemetry.measure("connector_resolution",async()=>{now+=2_500;throw Error("private connector data");})).rejects.toThrow("private connector data");
    expect(records.map(x=>[x.attributes.phase,x.attributes.outcome,x.attributes.phaseMs])).toEqual([["model_queue","completed",31_000],["connector_resolution","error",2_500]]);
    expect(JSON.stringify(records)).not.toContain("private connector data");
  });

  it("records first server delta, cadence, reconnect and terminal error with a controlled clock", () => {
    let now = 1_000;
    const records: Array<{ event: string; attributes: Record<string, unknown> }> = [];
    const telemetry = new TurnTelemetry({
      installationId: "qa-company",
      userId: "00000000-0000-4000-8000-000000000001",
      projectId: "project-1",
      threadId: "thread-1",
      localTurnId: "turn-local-1",
      clientRequestId: "request-1",
      streamRequestId: "stream-1",
    }, {
      now: () => now,
      logger: { info: (event, attributes = {}) => records.push({ event, attributes: { ...attributes } }) },
    });

    telemetry.bindRuntimeThread("runtime-thread-1");
    telemetry.admitted();
    telemetry.workerReadiness(false);
    telemetry.resumed();
    now = 1_005;
    telemetry.delta();
    now = 1_025;
    telemetry.delta();
    now = 1_060;
    telemetry.delta();
    now = 1_070;
    telemetry.disconnected();
    now = 1_080;
    telemetry.reconnected();
    now = 1_085;
    telemetry.cancellationRequested();
    now = 1_100;
    const metrics = telemetry.finish("error");

    expect(metrics).toEqual({
      admissionMs: 0,
      memoryMs: null,
      workerWarm: false,
      workerStartupMs: null,
      catalogMs: null,
      skillsMs: null,
      threadStartMs: null,
      threadResumeMs: null,
      turnStartMs: null,
      firstMeaningfulMs: 5,
      serverFirstDeltaMs: 5,
      serverDeltaCount: 3,
      serverInterDeltaP50Ms: 20,
      serverInterDeltaP95Ms: 35,
      serverInterDeltaMaxMs: 35,
      firstActivityMs: null,
      firstSummaryMs: null,
      firstToolMs: null,
      firstActivityWithinBudget: null,
      firstTextWithinBudget: true,
      totalMs: 100,
      resumeCount: 1,
      reconnectCount: 1,
      disconnectCount: 1,
      cancelRequested: true,
      timeoutRequested: false,
    });
    expect(records).toEqual([
      expect.objectContaining({ event: "codex.turn_lifecycle", attributes: expect.objectContaining({ lifecycle: "resumed", requestElapsedMs: 0 }) }),
      expect.objectContaining({ event: "codex.turn_lifecycle", attributes: expect.objectContaining({ lifecycle: "disconnected", requestElapsedMs: 70 }) }),
      expect.objectContaining({ event: "codex.turn_lifecycle", attributes: expect.objectContaining({ lifecycle: "reconnected", requestElapsedMs: 80 }) }),
      expect.objectContaining({ event: "codex.turn_lifecycle", attributes: expect.objectContaining({ lifecycle: "cancel_requested", requestElapsedMs: 85 }) }),
      expect.objectContaining({
        event: "codex.turn_metrics",
        attributes: expect.objectContaining({
          terminal: "error",
          localTurnId: "turn-local-1",
          clientRequestId: "request-1",
          streamRequestId: "stream-1",
          runtimeThreadId: "runtime-thread-1",
          serverFirstDeltaMs: 5,
          serverInterDeltaP95Ms: 35,
          totalMs: 100,
        }),
      }),
    ]);
    expect(JSON.stringify(records)).not.toMatch(/prompt|content|token|secret/iu);
  });

  it("separates tool queue/execution timing and a bounded turn timeout without payloads", () => {
    let now = 5_000;
    const records: Array<{ event: string; attributes: Record<string, unknown> }> = [];
    const telemetry = new TurnTelemetry({
      installationId: "qa-company",
      userId: "user-1",
      projectId: "project-1",
      threadId: "thread-1",
      localTurnId: "turn-1",
      clientRequestId: "request-1",
    }, {
      now: () => now,
      logger: { info: (event, attributes = {}) => records.push({ event, attributes: { ...attributes } }) },
    });

    telemetry.toolQueued("private-call-id");
    now = 5_012;
    const finishTool = telemetry.toolExecution("private-call-id", "aibrain_documents.create");
    now = 5_040;
    finishTool("completed");
    now = 5_050;
    telemetry.timeout();
    const snapshot = telemetry.finish("stopped");

    expect(snapshot).toMatchObject({ firstToolMs: 12, timeoutRequested: true, cancelRequested: false });
    expect(records).toContainEqual(expect.objectContaining({
      event: "codex.tool_phase",
      attributes: expect.objectContaining({
        toolKind: "aibrain_documents.create",
        queueMs: 12,
        executionMs: 28,
      }),
    }));
    expect(records).toContainEqual(expect.objectContaining({
      event: "codex.turn_lifecycle",
      attributes: expect.objectContaining({ lifecycle: "timeout_requested", requestElapsedMs: 50 }),
    }));
    expect(JSON.stringify(records)).not.toContain("private-call-id");
  });

  it("records the selected and rerouted effective model without prompt payloads", () => {
    const records: Array<{ event: string; attributes: Record<string, unknown> }> = [];
    const telemetry = new TurnTelemetry({
      installationId: "qa-company", userId: "user-1", projectId: "project-1",
      threadId: "thread-1", localTurnId: "turn-1", clientRequestId: "request-1",
    }, { logger: { info: (event, attributes = {}) => records.push({ event, attributes: { ...attributes } }) } });

    telemetry.modelSelected({
      experience: "expert", requestedModel: "gpt-5.6-sol", effectiveModel: "gpt-5.6-sol",
      effort: "high", source: "runtime",
    });
    telemetry.modelRerouted("gpt-5.6-sol", "gpt-6-astra", "capacity");

    expect(records).toEqual([
      expect.objectContaining({ event: "codex.turn_model", attributes: expect.objectContaining({
        experience: "expert", requestedModel: "gpt-5.6-sol", effectiveModel: "gpt-5.6-sol",
        effort: "high", source: "runtime",
      }) }),
      expect.objectContaining({ event: "codex.turn_model_rerouted", attributes: expect.objectContaining({
        fromModel: "gpt-5.6-sol", effectiveModel: "gpt-6-astra", reason: "capacity",
      }) }),
    ]);
    expect(JSON.stringify(records)).not.toMatch(/prompt|content|token|secret/iu);
  });
});
