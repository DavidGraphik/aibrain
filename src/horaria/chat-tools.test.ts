import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstallationConfig } from "@/config/installation-schema";
import type { ResolvedPermissions } from "@/permissions";
import type { AuthSession } from "@/auth/types";
import { handleHorariaToolCall, HORARIA_NAMESPACE } from "./chat-tools";
import { resolveOperation } from "./operations";
import { callHoraria, loadHorariaConfig } from "./client";
vi.mock("server-only", () => ({}));
vi.mock("./client", () => ({ callHoraria: vi.fn(), loadHorariaConfig: vi.fn() }));
const roots: string[] = [];
afterEach(async () => { vi.resetAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "horaria-chat-test-")); roots.push(root);
  const session = { provider: "local", tenant: { id: "test-shop", name: "Test" }, user: { id: "10000000-0000-4000-8000-000000000001", name: "Manager", email: "manager@example.test" }, expiresAt: "2099-01-01" } as AuthSession;
  const config = { installationId: "test-shop", baseUrl: "http://127.0.0.1:3210", secret: "x".repeat(40), eventsEnabled: false, users: { [session.user.id]: { employeeId: 1, backgroundOperations: [] as string[] } } };
  vi.mocked(loadHorariaConfig).mockResolvedValue(config);
  vi.mocked(callHoraria).mockResolvedValue({ saved: true });
  const context = { projectId: "project-a", permissions: { installationId: session.tenant.id, userId: session.user.id, projectId: "project-a", rules: [{ ruleId: "tools.execute", action: "execute", effect: "allow" }] } as unknown as ResolvedPermissions, session, installation: { installationId: "test-shop", paths: { usersRoot: root } } as InstallationConfig, sourceThreadId: "thread-a", sourceTurnId: "turn-1", sourceMessage: "Prepara el canvi", runtimeThreadId: "runtime-a", runtimeTurnId: "runtime-1", projectWorkspace: root, background: false, preview: vi.fn() };
  const run = async (tool: string, args: Record<string, unknown>, overrides = {}, callId = "call-1") => {
    const result = await handleHorariaToolCall({ namespace: HORARIA_NAMESPACE, tool, arguments: args as never, threadId: "runtime-a", turnId: "runtime-1", callId }, { ...context, ...overrides });
    return JSON.parse((result.contentItems[0] as { text: string }).text);
  };
  return { context, config, run };
}
describe("horarIA chat boundary", () => {
  it("retains the registered original receipt across draft retries and keeps reviewed delivery behind confirmation", async () => {
    const { run, context } = await setup();
    const draft: Record<string, unknown> = { draftOnly: true };
    context.preview.mockImplementation(async value => { Object.assign(value, { reviewSourceId: "a".repeat(64) }); });
    vi.mocked(callHoraria).mockResolvedValue(draft);
    const input = { operation: "schedules.draft", body: { establecimientoId: 3, semana: "2026-W42" } };
    expect((await run("run", input)).reviewSourceId).toBe("a".repeat(64));
    expect((await run("run", input)).reviewSourceId).toBe("a".repeat(64));
    expect(callHoraria).toHaveBeenCalledTimes(1);
    const pending = await run("run", { operation: "schedules.reviewed-send", body: { establecimientoId: 3, reviewId: "b".repeat(64), sha256: "c".repeat(64), previewHash: "d".repeat(64) } });
    expect(pending.confirmationRequired).toBe(true);
    expect(callHoraria).toHaveBeenCalledTimes(1);
    expect(() => resolveOperation({ operation: "schedules.review-source" })).toThrow();
    expect(() => resolveOperation({ operation: "schedules.review-upload" })).toThrow("Excel");
  });
  it("queries workflow readiness without preparing a business change", async () => {
    const { run } = await setup();
    const input = { operation: "workflow.readiness", query: { establecimiento: 3 } };
    vi.mocked(callHoraria).mockResolvedValue({ collection: { configurationReady: false, blockers: ["EMPLOYEE_PHONES_MISSING"] } });
    const result = await run("run", input);
    expect(result.collection.configurationReady).toBe(false);
    expect(result.confirmationRequired).toBeUndefined();
    expect(resolveOperation(input)).toMatchObject({ effect: "read", method: "GET", target: "/api/integration/readiness?establecimiento=3" });
  });
  it("completes the draft and review with six pending prerequisite proposals, without confirmation or writes", async () => {
    const { run, context } = await setup();
    const requests = [1, 2, 3, 4].map(employeeId => ({ employeeId, maxHours: 40 }));
    const coverage = { minDependientasManana: 1, minDependientasTarde: 1, minElaboracionManana: 1, minElaboracionTarde: 1 };
    const changes = [
      ...requests.map(r => ({ operation: "preferences.update", id: String(r.employeeId), body: { semana: "2026-W40", maxHorasSemana: 40 } })),
      { operation: "absences.create", body: { empleadoId: 3, tipo: "VACACIONES", fechaInicio: "2026-10-01", fechaFin: "2026-10-03" } },
      { operation: "rules.create", body: { establecimientoId: 5, ...coverage } },
    ];
    for (const change of changes) {
      const proposal = await run("run", change);
      expect(proposal.confirmationRequired).toBe(true);
      expect(proposal.draftAlternative).toMatchObject({ operation: "schedules.draft", confirmationRequired: false });
    }
    expect(callHoraria).not.toHaveBeenCalled();
    const draft = { draftOnly: true, review: { checks: [{ status: "respected" }], conflicts: ["Cobertura insuficient"], notVerified: ["Descans"], allRespected: false } };
    vi.mocked(callHoraria).mockResolvedValue(draft);
    const input = { operation: "schedules.draft", body: { establecimientoId: 5, semana: "2026-W40", requests, coverage } };
    // No confirming message or extra turn is required even after the model
    // mistakenly staged all six business changes.
    expect(await run("run", input)).toEqual(draft);
    expect(callHoraria).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callHoraria).mock.calls[0][2]).toEqual(input);
    expect(context.preview).toHaveBeenCalledWith(draft);
  });
  it("generates and attaches a draft in the requesting turn without business-write confirmation", async () => {
    const { run, context } = await setup();
    const draft = { title: "Proves", draftOnly: true, review: { allRespected: false, conflicts: ["Cobertura insuficient"] } };
    vi.mocked(callHoraria).mockResolvedValue(draft);
    const input = { operation: "schedules.draft", body: { establecimientoId: 5, semana: "2026-W40", requests: [{ employeeId: 1, noSplit: true }] } };
    expect(await run("run", input)).toEqual(draft);
    expect(context.preview).toHaveBeenCalledWith(draft);
    expect(await run("run", input)).toEqual(draft);
    expect(callHoraria).toHaveBeenCalledTimes(1);
    expect(resolveOperation(input).effect).toBe("draft");
  });
  it("does not rerun generation when only draft attachment failed", async () => {
    const { run, context } = await setup();
    context.preview.mockRejectedValueOnce(new Error("Preview unavailable"));
    const input = { operation: "schedules.draft", body: { establecimientoId: 5, semana: "2026-W40" } };
    await expect(run("run", input)).rejects.toThrow("Preview unavailable");
    await run("run", input, {}, "call-retry");
    expect(callHoraria).toHaveBeenCalledTimes(1);
  });
  it("keeps durable authorization for background drafts and confirmation for permanent preferences", async () => {
    const { run } = await setup();
    await expect(run("run", { operation: "schedules.draft", body: { establecimientoId: 5, semana: "2026-W40" } }, { background: true }))
      .rejects.toThrow("autorización permanente");
    const result = await run("run", { operation: "preferences.update", id: "1", body: { semana: "2026-W40", diasNoDisponible: ["MARTES"] } });
    expect(result.confirmationRequired).toBe(true);
    expect(callHoraria).not.toHaveBeenCalled();
  });
  it("queries preview and projects its real data through the existing artifact callback", async () => {
    const { run, context } = await setup();
    const value = { title: "Week", rows: [["Persona", "Dl"], ["Test", "Matí"]] };
    vi.mocked(callHoraria).mockResolvedValue(value);
    expect(await run("run", { operation: "preview", query: { semana: "2026-W38", establecimiento: 1 } })).toEqual(value);
    expect(context.preview).toHaveBeenCalledWith(value);
  });
  it.each(["collection.template", "collection.export", "collection.preview"])("attaches %s data without a business-write confirmation", async operation => {
    const { run, context } = await setup();
    const value = { artifactPurpose: "collection", title: "Availability", rows: [["Persona", "Lunes"], ["Test", "SIN_INDICAR"]] };
    vi.mocked(callHoraria).mockResolvedValue(value);
    const input = operation === "collection.preview" ? { operation, body: { establecimientoId: 1, semana: "2026-W41", responses: [] } } : { operation, query: { establecimiento: 1, semana: "2026-W41" } };
    expect(await run("run", input)).toEqual(value);
    expect(context.preview).toHaveBeenCalledWith(value);
    expect(callHoraria).toHaveBeenCalledOnce();
  });
  it("freezes a change, rejects same-turn/cross-thread confirmation and executes once", async () => {
    const { run } = await setup();
    const input = { operation: "schedules.update", id: "11", body: { turno: "LIBRE" } };
    const proposal = await run("run", input);
    expect(callHoraria).not.toHaveBeenCalled();
    await expect(run("confirm", { proposalId: proposal.proposalId }, { sourceMessage: "sí" })).rejects.toThrow();
    await expect(run("confirm", { proposalId: proposal.proposalId }, { sourceMessage: "sí", sourceTurnId: "turn-2", sourceThreadId: "other" })).rejects.toThrow();
    const overrides = { sourceTurnId: "turn-2", sourceMessage: "fes-ho" };
    await run("confirm", { proposalId: proposal.proposalId }, overrides);
    await run("confirm", { proposalId: proposal.proposalId }, overrides);
    expect(callHoraria).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callHoraria).mock.calls[0][2]).toEqual(input);
  });
  it("will not retry a write whose response was lost", async () => {
    const { run } = await setup();
    const p = await run("run", { operation: "whatsapp.broadcast", body: { establecimientoId: 1, semana: "2026-W38" } });
    vi.mocked(callHoraria).mockRejectedValue(new Error("Connection lost"));
    const overrides = { sourceMessage: "endavant", sourceTurnId: "turn-2" };
    await expect(run("confirm", { proposalId: p.proposalId }, overrides)).rejects.toThrow("Connection lost");
    await expect(run("confirm", { proposalId: p.proposalId }, overrides)).rejects.toThrow("puede haberse aplicado");
    expect(callHoraria).toHaveBeenCalledTimes(1);
  });
  it("background text cannot confirm or grant itself write permission", async () => {
    const { run, config, context } = await setup();
    const input = { operation: "schedules.generate", body: { establecimientoId: 1, semana: "2026-W38" } };
    await expect(run("run", input, { background: true })).rejects.toThrow("autorización permanente");
    expect(callHoraria).not.toHaveBeenCalled();
    config.users[context.session.user.id].backgroundOperations.push("schedules.generate");
    await run("run", input, { background: true });
    expect(callHoraria).toHaveBeenCalledTimes(1);
  });
  it("honors a revoked AiBrain tools.execute permission before reading business data", async () => {
    const { run, context } = await setup();
    context.permissions.rules[0].effect = "deny";
    await expect(run("run", { operation: "status" })).rejects.toThrow("permiso");
    expect(callHoraria).not.toHaveBeenCalled();
  });
  it("reports missing configuration without exposing internal failure details or contacting the service", async () => {
    const { run } = await setup();
    vi.mocked(loadHorariaConfig).mockRejectedValue(new Error("private path and credential details"));
    const result = await run("run", { operation: "status" });
    expect(result).toMatchObject({ code: "HORARIA_NOT_CONFIGURED", retryable: false, noActionExecuted: true });
    expect(JSON.stringify(result)).not.toContain("credential details");
    expect(callHoraria).not.toHaveBeenCalled();
  });
  it("rejects unmapped users and host/path injection", async () => {
    const { run, config } = await setup(); config.users = {};
    expect(await run("run", { operation: "status" })).toMatchObject({ code: "HORARIA_NOT_ASSIGNED", retryable: false, noActionExecuted: true });
    expect(callHoraria).not.toHaveBeenCalled();
    expect(() => resolveOperation({ operation: "__proto__" })).toThrow();
    expect(() => resolveOperation({ operation: "employees.update", id: "../whatsapp/webhook" })).toThrow();
    expect(() => resolveOperation({ operation: "status", query: { secret: "guess" } })).toThrow();
  });
});
