import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { AppServerRpcRouter } from "@/runtime/transport";
import { LocalGatewayWorkerRuntimeFactory } from "./local-gateway-runtime";
import type { WorkerLaunchContext } from "./types";
import * as ownedProcess from "./owned-process";
import { execFileSync } from "node:child_process";

vi.mock("server-only", () => ({}));

// Real installed binary, intentionally anonymous: no borrowed auth, no model
// turns, no tools, no customer paths. Opt-in only, one process generation.
it.runIf(process.env.AIBRAIN_REAL_ISOLATED_APP_SERVER === "1")("initializes the real App Server in an empty isolated home", async () => {
  const root = await mkdtemp("/tmp/aibrain-a1-real-anonymous-");
  const environment = { HOME: `${root}/home`, CODEX_HOME: `${root}/codex`, XDG_CACHE_HOME: `${root}/xdg/cache`, XDG_CONFIG_HOME: `${root}/xdg/config`, XDG_DATA_HOME: `${root}/xdg/data`, XDG_STATE_HOME: `${root}/xdg/state`, TMPDIR: `${root}/tmp` };
  await Promise.all([...Object.values(environment), `${root}/workspace`].map((p) => mkdir(p, { recursive: true, mode: 0o700 })));
  const context = { installationId: "a1-anonymous", userId: "00000000-0000-4000-8000-000000000001", workerId: "worker-a1-anonymous", environment, workspace: `${root}/workspace`, transportAudit: `${root}/audit` } as WorkerLaunchContext;
  const runtime = new LocalGatewayWorkerRuntimeFactory({ runtimeInstanceId: "anonymous-preflight" }).create(context);
  const stop = ownedProcess.stopOwnedWorkerProcess;
  const cleanupDiagnostic = vi.spyOn(ownedProcess, "stopOwnedWorkerProcess").mockImplementation(async (child, group, ...limits) => {
    try { await stop(child, group, ...limits); }
    catch (error) {
      let members: string[][] = [];
      try {
        members = execFileSync("ps", ["-axo", "pid,ppid,pgid,stat"], { encoding: "utf8" }).split("\n")
          .map((line) => line.trim().split(/\s+/)).filter((fields) => fields[2] === String(child.pid));
      } catch { /* Never replace the cleanup failure with a diagnostic failure. */ }
      process.stdout.write(`${JSON.stringify({ scope: "owned-cleanup-diagnostic", pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, group, members })}\n`);
      throw error;
    }
  });
  const router = new AppServerRpcRouter(runtime.transport);
  const start = performance.now();
  try {
    await runtime.start();
    const gatewayReadyMs = performance.now() - start;
    const initialized = await router.request({ method: "initialize", id: "anonymous-init", params: { clientInfo: { name: "aibrain_anonymous_preflight", title: "Anonymous preflight", version: "1" }, capabilities: null } }, 5_000);
    expect(initialized).toBeTruthy();
    const initializeCompleteMs = performance.now() - start;
    await router.notify({ method: "initialized" }, "anonymous-initialized");
    const account = await router.request({ method: "account/read", id: "anonymous-account", params: { refreshToken: false } }, 5_000);
    expect(account).toMatchObject({ account: null });
    process.stdout.write(`${JSON.stringify({ scope: "real-anonymous-app-server-no-model", n: 1, gatewayReadyMs, initializeCompleteMs, accountReadCompleteMs: performance.now() - start, authenticated: false })}\n`);
  } finally {
    try { await router.close(); await runtime.stop(); await rm(root, { recursive: true, force: true }); }
    finally { cleanupDiagnostic.mockRestore(); }
  }
}, 15_000);
