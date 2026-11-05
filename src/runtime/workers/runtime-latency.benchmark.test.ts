import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { parseInstallationConfig } from "@/config/installation-schema";
import type { WorkerLifecycleMetric } from "./registry";
import type { WorkerRuntimeHandle } from "./types";
import { WorkerProvisioner } from "./provisioner";
import type { JsonValue } from "@/runtime/transport";

vi.mock("server-only", () => ({}));
vi.mock("@/operations/server-logger", () => ({ operationalLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Opt-in, real local process + TCP/WS + durable journals; NOT a provider benchmark.
// A fixed five samples prevents accidental load loops. Baseline snapshots may
// be selected by the caller, but the fixture never selects credentials/models.
it.runIf(process.env.AIBRAIN_RUNTIME_BENCH === "1")("measures cold, warm and three-chat runtime phases", async () => {
  const source = process.env.AIBRAIN_RUNTIME_BENCH_SOURCE;
  const { LocalGatewayWorkerRuntimeFactory } = source
    ? await import(`${source}/local-gateway-runtime.ts`) : await import("./local-gateway-runtime");
  const { WorkerRuntimeRegistry } = source
    ? await import(`${source}/registry.ts`) : await import("./registry");
  const { WorkerAppServerClient } = source
    ? await import(`${source}/worker-runtime-service.ts`) : await import("../worker-runtime-service");
  const samples: Record<string, number[]> = {};
  const add = (name: string, value: number) => { (samples[name] ??= []).push(value); };
  const fixture = `
    const lines = require('node:readline').createInterface({input:process.stdin});
    const write = value => process.stdout.write(JSON.stringify(value)+'\\n');
    let thread = 0, turn = 0;
    lines.on('line', line => {
      const r = JSON.parse(line); if (r.id === undefined) return;
      let result = {};
      if (r.method === 'initialize') result = {userAgent:'local-fixture'};
      if (r.method === 'account/read') result = {account:{type:'chatgpt',planType:'team'}};
      if (r.method === 'thread/start') result = {thread:{id:'thread-'+(++thread),turns:[]}};
      if (r.method === 'thread/resume') result = {thread:{id:r.params.threadId,turns:[]}};
      if (r.method === 'turn/start') result = {turn:{id:'turn-'+(++turn)}};
      write({id:r.id,result});
      if (r.method === 'turn/start') {
        const scope = {threadId:r.params.threadId,turnId:result.turn.id};
        write({method:'item/agentMessage/delta',params:{...scope,itemId:'item-'+turn,delta:'fixture'}});
        write({method:'turn/completed',params:{threadId:scope.threadId,turn:{id:scope.turnId,status:'completed',items:[],error:null}}});
      }
    });`;
  {
    for (let sample = 0; sample < 5; sample++) {
      const root = await mkdtemp("/tmp/aibrain-a1-benchmark-");
      const config = parseInstallationConfig({ schemaVersion: 1, installationId: "a1-benchmark", companyName: "Benchmark", companySlug: "benchmark", publicUrl: "http://127.0.0.1:3000",
        branding: { productName: "Benchmark", logoPath: "/logo.svg", faviconPath: "/favicon.svg", accentColor: "#3366ff" },
        paths: { dataRoot: `${root}/data`, companyContextRoot: `${root}/data/company`, usersRoot: `${root}/data/users`, sourceReadRoot: `${root}/source`, publishWriteRoot: `${root}/publish`, backupsRoot: `${root}/data/backups` } });
      await Promise.all([config.paths.companyContextRoot, config.paths.sourceReadRoot, config.paths.publishWriteRoot].map((p) => mkdir(p, { recursive: true })));
      const processes = [] as ReturnType<typeof spawn>[];
      const registry = new WorkerRuntimeRegistry({ config, provisioner: new WorkerProvisioner({ config, sharedCodexAuth: null }), onLifecycleMetric: (metric: WorkerLifecycleMetric) => add(metric.phase, metric.durationMs),
        factory: new LocalGatewayWorkerRuntimeFactory({ processFactory: () => {
          const child = spawn(process.execPath, ["-e", fixture], { cwd: root, env: { NODE_ENV: "test" }, stdio: ["pipe", "pipe", "pipe"] });
          processes.push(child); return child;
        } }) });
      let client: InstanceType<typeof WorkerAppServerClient> | undefined;
      let serial = 0;
      const measure = async <T,>(phase: string, action: () => Promise<T>): Promise<T> => {
        const start = performance.now(); const result = await action(); add(phase, performance.now() - start); return result;
      };
      try {
        const user = "00000000-0000-4000-8000-000000000001";
        const handle = await measure<WorkerRuntimeHandle>("coldRegistryAdmission", () => registry.start(user));
        client = new WorkerAppServerClient(handle);
        const active = client;
        await measure("initializeAndAccount", () => active.initialize());
        const newThread = async () => {
          const response = await active.request("thread/start", { cwd: handle.roots.workspace, config: { web_search: "live" } }, `thread-${++serial}`);
          return (response as { thread: { id: string } }).thread.id;
        };
        const firstThread = await measure("threadStart", newThread);
        const turn = async (threadId: string, phase: string) => {
          const started = performance.now();
          let resolve!: () => void; let reject!: (error: Error) => void;
          const completed = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
          const timer = setTimeout(() => reject(new Error("Fixture turn timed out")), 5_000);
          const registration = active.router.registerTurn(threadId, `local-${++serial}`, {
            onNotification(notification: { method: string }) {
              if (notification.method === "item/agentMessage/delta") add(`${phase}FirstDelta`, performance.now() - started);
              if (notification.method === "turn/completed") resolve();
            }, onServerRequest: () => { throw new Error("Fixture must not request tools"); }, onFailure: reject,
          });
          try {
            await measure(`${phase}TurnStartResponse`, () => active.request("turn/start", { threadId, input: [{ type: "text", text: "fixture", text_elements: [] }] }, `turn-${++serial}`, 5_000,
              (value: JsonValue) => registration.bindRuntimeTurn((value as { turn: { id: string } }).turn.id)));
            await completed;
          } finally { clearTimeout(timer); registration.dispose(); }
        };
        await turn(firstThread, "cold");
        await measure("warmRegistryAdmission", () => registry.start(user));
        await measure("warmInitialize", () => active.initialize());
        expect(active.canReuseLoadedThread(firstThread, true)).toBe(true);
        await turn(firstThread, "warm");
        // Explicit loaded-thread resume measures RPC overhead, not disk restore.
        await measure("explicitResume", () => active.request("thread/resume", { threadId: firstThread }, `resume-${++serial}`));
        const threads = [firstThread, await newThread(), await newThread()];
        await measure("threeChatsCompletion", () => Promise.all(threads.map((threadId) => turn(threadId, "threeChats"))));
        expect(processes).toHaveLength(1);
      } finally {
        await client?.close(); await registry.close();
        expect(processes.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
        await rm(root, { recursive: true, force: true });
      }
    }
    const report = Object.fromEntries(Object.entries(samples).map(([phase, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const round = (n: number) => Math.round(n * 1000) / 1000;
      return [phase, { n: values.length, medianMs: round(sorted[Math.floor(sorted.length / 2)]), minMs: round(sorted[0]), maxMs: round(sorted.at(-1)!) }];
    }));
    process.stdout.write(`${JSON.stringify({ scope: "local-node-fixture-real-runtime-path", revision: source ? path.basename(source) : "candidate", excludes: ["provider inference", "HTTP chat admission", "UI", "real persisted-thread restore"], phases: report })}\n`);
  }
}, 60_000);
