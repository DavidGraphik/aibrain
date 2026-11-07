import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseInstallationConfig } from "@/config/installation-schema";
import { UserProvisioner } from "@/users/provisioner";
import { FileLocalSessionStore } from "@/auth/local-session-store";
import * as supportPolicy from "@/auth/support-access-policy";
import { bindLocalServerSession, localServerSessionHash } from "@/auth/server-session-binding";
import type { AuthSession } from "@/auth/types";
import { resolveServerTurnPermissions } from "@/runtime/permission-turn";
import { G03_NAMESPACE, G03_DYNAMIC_TOOLS, G03_THREAD_TOOLSET_REVISION, g03ToolsEnabled, handleG03Tool, type G03ToolContext } from "./dynamic-tools";
import { currentThreadToolsetRevision } from "@/runtime/thread-token";
import { runtimeThreadIdForChatMessage } from "@/runtime/chat-thread-selection";
import { developerModelQa } from "../../tests/support/g03-developer-model-qa";
vi.mock("server-only", () => ({}));

const roots: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const child of children.splice(0)) { if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); } }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const projectId = "03000000-0000-4000-8000-000000000011";
const sourceThreadId = "03000000-0000-4000-8000-000000000021";
const sourceTurnId = "03000000-0000-4000-8000-000000000031";
const ids = ["03000000-0000-4000-8000-000000000001", "03000000-0000-4000-8000-000000000002"];
async function fixture() {
  vi.stubEnv("AIBRAIN_ADMIN_USER_IDS", ids[0]);
  const root = await mkdtemp(path.join(tmpdir(), "g03-bound-runtime-")); roots.push(root);
  const template = JSON.parse(await readFile("deployments/g03/installation.qa.json", "utf8"));
  const config = parseInstallationConfig({ ...template, paths: { dataRoot: path.join(root, "data"), companyContextRoot: path.join(root, "data/company"), usersRoot: path.join(root, "data/users"), sourceReadRoot: path.join(root, "source"), publishWriteRoot: path.join(root, "publish"), backupsRoot: path.join(root, "data/backups") } });
  const provisioner = new UserProvisioner(config, { companyContextSeedRoot: path.resolve("config/company-context/g03") });
  for (const [index, userId] of ids.entries()) await provisioner.provision({ userId, email: `synthetic-${index}@g03.example.test`, displayName: `Synthetic G03 ${index}` });
  const sessions = new FileLocalSessionStore({ rootDirectory: path.join(config.paths.dataRoot, "sessions") });
  const issued = await Promise.all(ids.map(id => sessions.create(config.installationId, id)));
  const identities: AuthSession[] = ids.map((id, i) => bindLocalServerSession({ provider: "local", user: { id, name: `Synthetic G03 ${i}`, email: `synthetic-${i}@g03.example.test` }, tenant: { id: config.installationId, name: config.companyName }, expiresAt: new Date(issued[i].record.idleExpiresAt).toISOString() }, issued[i].record.sessionIdHash));
  const folder = path.join(config.paths.dataRoot, "g03"); await mkdir(folder, { mode: 0o700 });
  const secretFile = path.join(folder, "signing.key"); await writeFile(secretFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  const configPath = path.join(folder, "bridge.json");
  const bridge = { schemaVersion: 1, installationId: config.installationId, mode: "synthetic-local", dataRoot: config.paths.dataRoot, secretFile, endpoint: "http://127.0.0.1:1/api/g03/read", users: { [ids[0]]: { actor: "qa-jordi", enabled: true }, [ids[1]]: { actor: "qa-lidia", enabled: true } } };
  await writeFile(configPath, JSON.stringify(bridge), { mode: 0o600 });
  const child = spawn("python3", ["deployments/g03/operations/server.py", "--state", path.join(root, "operations"), "--port", "0", "--bridge-config", configPath], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Local fixture startup timeout")), 15_000);
    let output = "";
    child.stdout!.on("data", part => { output += part.toString(); if (output.includes("\n")) { clearTimeout(timeout); resolve(JSON.parse(output.split("\n")[0]).url + "/api/g03/read"); } });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
  });
  bridge.endpoint = endpoint; await writeFile(configPath, JSON.stringify(bridge));
  const contexts = await Promise.all(identities.map(async (session, index) => {
    const employeeTurn = index === 0 ? sourceTurnId : "03000000-0000-4000-8000-000000000032";
    const employeeThread = index === 0 ? sourceThreadId : "03000000-0000-4000-8000-000000000022";
    return { installation: config, session,
      permissions: await resolveServerTurnPermissions(config, { installationId: config.installationId, userId: session.user.id, projectId, turnId: employeeTurn }),
      projectId, sourceThreadId: employeeThread, sourceTurnId: employeeTurn, runtimeThreadId: "runtime-g03-" + session.user.id, runtimeTurnId: "turn-g03-" + session.user.id, configPath,
    } satisfies G03ToolContext;
  }));
  const tool = (index: number, operation: string, input: object = {}) => ({ namespace: G03_NAMESPACE, tool: operation, arguments: input, callId: "call-g03", threadId: contexts[index].runtimeThreadId, turnId: contexts[index].runtimeTurnId });
  return { root, config, sessions, issued, identities, contexts, tool, bridge, configPath };
}
describe("G03 actual local runtime binding with explicit synthetic employees/data", () => {
  it.runIf(process.env.AIBRAIN_G03_DEVELOPER_MODEL_QA === "1")("uses existing developer auth for two real model turns against synthetic employee-bound tools", async () => {
    const f = await fixture();
    const workspace = path.join(f.root, "model-workspace"); await mkdir(workspace);
    const evidence = await developerModelQa({ cwd: workspace, tools: G03_DYNAMIC_TOOLS,
      onTool: (params, employee) => handleG03Tool(params, { ...f.contexts[employee], runtimeThreadId: params.threadId, runtimeTurnId: params.turnId }) });
    await writeFile(path.join(f.root, "model-qa-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    expect(evidence.evidence).toHaveLength(2);
    expect(evidence.evidence[0]).toMatchObject({ calls: 2, denials: 0 });
    expect(evidence.evidence[1]).toMatchObject({ calls: 2, denials: 1 });
  }, 120_000);
  it("registers eight tools only for configured G03 and upgrades only its toolset", () => {
    vi.stubEnv("AIBRAIN_G03_BRIDGE_CONFIG", "/synthetic/g03/bridge.json");
    expect(g03ToolsEnabled("g03-rehearsal")).toBe(true);
    expect(g03ToolsEnabled("arnall")).toBe(false);
    expect(g03ToolsEnabled("trinalum-production")).toBe(false);
    expect(G03_DYNAMIC_TOOLS[0]).toMatchObject({ type: "namespace", name: G03_NAMESPACE });
    expect(G03_DYNAMIC_TOOLS[0].type === "namespace" && G03_DYNAMIC_TOOLS[0].tools.length).toBe(8);
    expect(runtimeThreadIdForChatMessage({ threadId: "legacy", toolsetRevision: G03_THREAD_TOOLSET_REVISION }, "consulta", "g03-production")).toBeNull();
    expect(runtimeThreadIdForChatMessage({ threadId: "old", toolsetRevision: null }, "consulta", "g03-production")).toBeNull();
    expect(runtimeThreadIdForChatMessage({ threadId: "g03", toolsetRevision: currentThreadToolsetRevision("g03-production") }, "consulta", "g03-production")).toBe("g03");
  });
  it("routes two distinct employee turns through real signed HTTP and denies cross-role/private reads", async () => {
    const f = await fixture();
    const results = await Promise.all(f.contexts.map((context, i) => handleG03Tool(f.tool(i, "list_work_orders") as never, context)));
    expect(results.every(r => r.success)).toBe(true);
    expect(results.map(r => JSON.parse((r.contentItems[0] as { text: string }).text).data[0].id)).toEqual(["OF-DEMO-001", "OF-DEMO-001"]);
    expect((await handleG03Tool(f.tool(1, "read_department", { resource: "quotes" }) as never, f.contexts[1])).success).toBe(false);
    expect((await handleG03Tool(f.tool(1, "read_document", { path: "ADMINISTRACIO/exemple-sintetic.txt" }) as never, f.contexts[1])).success).toBe(false);
    expect((await handleG03Tool(f.tool(0, "read_document", { path: "ADMINISTRACIO/exemple-sintetic.txt" }) as never, f.contexts[0])).success).toBe(true);
    const serialized = JSON.stringify(f.identities[0]);
    expect(serialized).not.toContain(localServerSessionHash(f.identities[0]));
    expect(serialized).not.toContain(f.issued[0].sessionId);
  }, 30_000);
  it("rejects forged identity/turn/input before any HTTP request and never accepts an unbound session DTO", async () => {
    const f = await fixture(); const fetcher = vi.fn() as unknown as typeof fetch;
    const ctx = { ...f.contexts[0], fetcher };
    for (const params of [{ ...f.tool(0, "list_work_orders"), turnId: "foreign" }, f.tool(0, "list_work_orders", { actor: "qa-jordi" }), f.tool(0, "send_mail")]) expect((await handleG03Tool(params as never, ctx)).success).toBe(false);
    expect((await handleG03Tool(f.tool(0, "list_work_orders") as never, { ...ctx, session: { ...f.identities[0] } })).success).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  }, 30_000);
  it("revokes a currently open turn after logout, without breaking the other employee", async () => {
    const f = await fixture();
    expect((await handleG03Tool(f.tool(0, "list_work_orders") as never, f.contexts[0])).success).toBe(true);
    await f.sessions.delete(f.issued[0].sessionId);
    expect((await handleG03Tool(f.tool(0, "list_work_orders") as never, f.contexts[0])).success).toBe(false);
    expect((await handleG03Tool(f.tool(1, "list_work_orders") as never, f.contexts[1])).success).toBe(true);
  }, 30_000);
  it("re-reads actor and permission revocation; signed-request replay is denied", async () => {
    const f = await fixture();
    let captured: { url: string; options: RequestInit } | undefined;
    const fetcher: typeof fetch = async (url, options) => { captured = { url: String(url), options: options! }; return fetch(url, options); };
    expect((await handleG03Tool(f.tool(0, "list_work_orders") as never, { ...f.contexts[0], fetcher })).success).toBe(true);
    expect((await fetch(captured!.url, captured!.options)).status).toBe(403);
    f.bridge.users[ids[0]].enabled = false; await writeFile(f.configPath, JSON.stringify(f.bridge));
    expect((await handleG03Tool(f.tool(0, "list_work_orders") as never, f.contexts[0])).success).toBe(false);
    const policyPath = path.join(f.config.paths.usersRoot, ids[1], "PERMISSIONS.md");
    await chmod(policyPath, 0o600);
    await writeFile(policyPath, (await readFile(policyPath, "utf8")) + "\n- `tools.execute` | execute | deny | Revoked in synthetic QA.\n");
    expect((await handleG03Tool(f.tool(1, "list_work_orders") as never, f.contexts[1])).success).toBe(false);
  }, 30_000);
  it("suppresses a response if logout occurs while the source read is in flight", async () => {
    const f = await fixture();
    const fetcher: typeof fetch = async (url, options) => { const response = await fetch(url, options); await f.sessions.delete(f.issued[0].sessionId); return response; };
    expect((await handleG03Tool(f.tool(0, "list_work_orders") as never, { ...f.contexts[0], fetcher })).success).toBe(false);
  }, 30_000);
  it.each(["marker", "operator"])("revokes an admitted support read when its %s is disabled", async kind => {
    const f = await fixture();
    let enabled = true;
    vi.spyOn(supportPolicy, "readSupportAccessPolicy").mockImplementation(async () => enabled ? {
      schemaVersion: 1, installationId: f.config.installationId,
      operatorUserId: ids[0], expiresAt: Date.now() + 60_000,
    } : null);
    const issued = await f.sessions.create(f.config.installationId, ids[1], {
      actorUserId: ids[0], actorEmail: "synthetic-0@g03.example.test", reason: "Verify support revocation during an active read",
    });
    const session = bindLocalServerSession({ ...f.identities[1],
      expiresAt: new Date(issued.record.absoluteExpiresAt).toISOString(),
    }, issued.record.sessionIdHash);
    const context = { ...f.contexts[1], session };
    expect((await handleG03Tool(f.tool(1, "list_work_orders") as never, context)).success).toBe(true);
    const fetcher: typeof fetch = async (url, options) => {
      const response = await fetch(url, options);
      if (kind === "marker") enabled = false;
      else {
        const file = path.join(f.config.paths.usersRoot, ids[0], "user.json");
        const operator = JSON.parse(await readFile(file, "utf8"));
        await chmod(file, 0o600);
        await writeFile(file, JSON.stringify({ ...operator, enabled: false }));
      }
      return response;
    };
    const result = await handleG03Tool(f.tool(1, "list_work_orders") as never, { ...context, fetcher });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("G03_SESSION_REVOKED");
  }, 30_000);
  it.each(["actor", "policy"])("suppresses an in-flight result after %s revocation", async kind => {
    const f = await fixture();
    const fetcher: typeof fetch = async (url, options) => {
      const response = await fetch(url, options);
      if (kind === "actor") {
        f.bridge.users[ids[1]].enabled = false;
        await writeFile(f.configPath, JSON.stringify(f.bridge));
      } else {
        const policyPath = path.join(f.config.paths.usersRoot, ids[1], "PERMISSIONS.md");
        await chmod(policyPath, 0o600);
        await writeFile(policyPath, (await readFile(policyPath, "utf8")) + "\n- `tools.execute` | execute | deny | Revoked in synthetic QA.\n");
      }
      return response;
    };
    expect((await handleG03Tool(f.tool(1, "list_work_orders") as never, { ...f.contexts[1], fetcher })).success).toBe(false);
  }, 30_000);
});
