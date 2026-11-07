import { spawn } from "node:child_process";
import { once } from "node:events";
import type { DynamicToolSpec } from "../../contracts/codex/0.162.1/types/v2/DynamicToolSpec";
import type { DynamicToolCallParams } from "../../contracts/codex/0.162.1/types/v2/DynamicToolCallParams";
import type { DynamicToolCallResponse } from "../../contracts/codex/0.162.1/types/v2/DynamicToolCallResponse";

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// Explicit developer-auth smoke only. No auth files are read/copied, no client
// worker receives developer credentials, and no production provider is enabled.
export async function developerModelQa(options: {
  cwd: string; tools: readonly DynamicToolSpec[];
  onTool: (params: DynamicToolCallParams, employee: number) => Promise<DynamicToolCallResponse>;
}) {
  const disabled = ["apps", "plugins", "remote_plugin", "shell_tool", "unified_exec", "browser_use", "browser_use_external",
    "computer_use", "in_app_browser", "image_generation", "multi_agent", "multi_agent_v2", "memories", "chronicle", "hooks", "skill_search"];
  const child = spawn("codex", ["app-server", "--stdio", ...disabled.flatMap(name => ["--disable", name]),
    "-c", "mcp_servers={}", "-c", 'web_search="disabled"'], { cwd: options.cwd, stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  const turns = new Map<string, { employee: number; resolve: (value: unknown) => void; reject: (reason: Error) => void; text: string; calls: number; denials: number }>();
  const employeeByThread = new Map<string, number>();
  let id = 0, buffer = "";
  const send = (value: object) => { child.stdin.write(JSON.stringify(value) + "\n"); };
  const request = (method: string, params: object): Promise<unknown> => new Promise((resolve, reject) => {
    const requestId = ++id; waiting.set(requestId, { resolve, reject }); send({ id: requestId, method, params });
  });
  const fail = (reason: Error) => { for (const pending of waiting.values()) pending.reject(reason); waiting.clear(); for (const turn of turns.values()) turn.reject(reason); turns.clear(); };
  child.once("error", fail); child.once("exit", () => fail(new Error("Developer QA App Server exited.")));
  const timeout = setTimeout(() => { fail(new Error("Developer QA bounded timeout.")); child.kill("SIGTERM"); }, 90_000);
  child.stdout.on("data", part => {
    buffer += part.toString();
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      let value: unknown; try { value = JSON.parse(line); } catch { continue; }
      if (!record(value)) continue;
      if (typeof value.id === "number" && !value.method) {
        const pending = waiting.get(value.id); waiting.delete(value.id);
        if (value.error) pending?.reject(new Error("Developer QA RPC rejected.")); else pending?.resolve(value.result);
        continue;
      }
      const params = record(value.params) ? value.params : {};
      const thread = typeof params.threadId === "string" ? params.threadId : "";
      const state = turns.get(thread);
      if (value.method === "item/tool/call" && value.id !== undefined) {
        const employee = employeeByThread.get(thread);
        if (employee === undefined || params.namespace !== "g03_business") {
          send({ id: value.id, result: { success: false, contentItems: [{ type: "inputText", text: "Developer QA allows only G03 readonly tools." }] } });
        } else {
          if (state) state.calls += 1;
          void options.onTool(params as unknown as DynamicToolCallParams, employee).then(result => {
            if (!result.success && state) state.denials += 1;
            send({ id: value.id, result });
          }).catch(() => send({ id: value.id, result: { success: false, contentItems: [{ type: "inputText", text: "QA denied." }] } }));
        }
      } else if (value.id !== undefined && value.method) {
        send({ id: value.id, result: value.method === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" } : { decision: "decline" } });
      } else if (value.method === "item/agentMessage/delta" && state && typeof params.delta === "string") state.text += params.delta;
      else if (value.method === "turn/completed" && state) {
        turns.delete(thread);
        if (record(params.turn) && params.turn.status === "completed") state.resolve({ calls: state.calls, denials: state.denials, text: state.text });
        else state.reject(new Error("Developer QA model turn did not complete."));
      }
    }
  });
  try {
    await request("initialize", { clientInfo: { name: "g03_developer_qa", title: "G03 synthetic developer QA", version: "1" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized", params: {} });
    const account = await request("account/read", { refreshToken: false });
    if (!record(account) || !account.account) throw new Error("Existing developer authentication unavailable.");
    const catalog = await request("model/list", { limit: 100, includeHidden: false });
    const models = record(catalog) && Array.isArray(catalog.data) ? catalog.data.filter(record) : [];
    const selected = models.find(m => m.model === "gpt-6.1-sol") ?? models.find(m => m.isDefault === true);
    if (!selected || typeof selected.model !== "string") throw new Error("Developer QA model unavailable.");
    const evidence = [];
    for (const employee of [0, 1]) {
      const started = await request("thread/start", { model: selected.model, cwd: options.cwd, runtimeWorkspaceRoots: [options.cwd],
        sandbox: "read-only", approvalPolicy: "never", ephemeral: true, environments: [], dynamicTools: options.tools,
        baseInstructions: "You are a bounded G03 synthetic QA assistant. Use ONLY g03_business tools. Never use any other tool or access files/network. Call list_work_orders and read_department(resource=quotes) exactly once each, then summarize in Spanish. Explicitly label synthetic data; explain denied permissions without bypassing. Do not create files or suggest using another identity.",
        config: { web_search: "disabled" } });
      const threadId = record(started) && record(started.thread) ? started.thread.id : undefined;
      if (typeof threadId !== "string") throw new Error("Developer QA thread unavailable.");
      employeeByThread.set(threadId, employee);
      const completed = new Promise((resolve, reject) => turns.set(threadId, { employee, resolve, reject, text: "", calls: 0, denials: 0 }));
      await request("turn/start", { threadId, input: [{ type: "text", text: "Consulta las OF y los presupuestos usando las dos herramientas indicadas. Son datos ficticios de ensayo." }],
        effort: "low", environments: [], cwd: options.cwd, approvalPolicy: "never" });
      evidence.push({ employee, ...(await completed as object) });
    }
    return { scope: "existing-developer-auth-only", model: selected.model, realEmployeeAuthAcceptance: false, evidence };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  }
}
