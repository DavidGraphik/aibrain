import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { Server } from "node:http";
import { expect, it, vi } from "vitest";
import { LocalGatewayWorkerRuntimeFactory, PrivateWorkerGateway } from "./local-gateway-runtime";
import type { WorkerLaunchContext } from "./types";

vi.mock("server-only", () => ({}));

// Regression adapted from runtime QA's deterministic R1 reproduction.
it.each([false, true])("fences delayed journal startup after stop (managed=%s)", async (managed) => {
  const root = await mkdtemp("/tmp/aibrain-a1-race-");
  const context = { installationId: "a1-test", userId: "00000000-0000-4000-8000-000000000001",
    workerId: "worker-test", environment: {}, workspace: root, transportAudit: root } as WorkerLaunchContext;
  const processFactory = vi.fn(() => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["pipe", "pipe", "pipe"], env: { NODE_ENV: "test" } }));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const original = PrivateWorkerGateway.prototype.start;
  let captured: PrivateWorkerGateway | undefined;
  const spy = vi.spyOn(PrivateWorkerGateway.prototype, "start").mockImplementation(function(this: PrivateWorkerGateway) {
    captured = this;
    vi.spyOn((this as unknown as { events: { verifyAndRepair(): Promise<void> } }).events, "verifyAndRepair").mockImplementation(() => blocked);
    return original.call(this);
  });
  const worker = managed ? new LocalGatewayWorkerRuntimeFactory({ processFactory }).create(context)
    : new PrivateWorkerGateway({ context, processFactory });
  const start = worker.start().catch((error: unknown) => error);
  try {
    await worker.stop();
    release();
    await start;
    expect(processFactory).not.toHaveBeenCalled();
    expect((await worker.health()).state).toBe("stopped");
  } finally {
    release();
    await start;
    spy.mockRestore();
    await captured?.stop();
    if ("transport" in worker) await worker.transport.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("joins concurrent starts and stops, and rejects pending transport readiness on stop", async () => {
  const root = await mkdtemp("/tmp/aibrain-a1-deferred-");
  const context = { installationId: "a1-test", userId: "00000000-0000-4000-8000-000000000001",
    workerId: "worker-test", environment: {}, workspace: root, transportAudit: root } as WorkerLaunchContext;
  const processFactory = vi.fn(() => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["pipe", "pipe", "pipe"], env: { NODE_ENV: "test" } }));
  const runtime = new LocalGatewayWorkerRuntimeFactory({ processFactory }).create(context);
  try {
    await Promise.all([runtime.start(), runtime.start(), runtime.start()]);
    expect(processFactory).toHaveBeenCalledTimes(1);
    await Promise.all([runtime.stop(), runtime.stop(), runtime.stop()]);
    const child = processFactory.mock.results[0].value;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await expect(runtime.start()).rejects.toThrow(/cancelled/);
    const unstarted = new LocalGatewayWorkerRuntimeFactory({ processFactory }).create(context);
    const connecting = unstarted.transport.connect().catch((error: unknown) => error);
    await unstarted.stop();
    expect(await connecting).toMatchObject({ message: "Worker transport is closed." });
    expect(processFactory).toHaveBeenCalledTimes(1);
  } finally { await runtime.stop(); await rm(root, { recursive: true, force: true }); }
});

it("drains a delayed listen before releasing the child and leaves another user alive", async () => {
  const root = await mkdtemp("/tmp/aibrain-a1-listen-");
  const context = { installationId: "a1-test", userId: "00000000-0000-4000-8000-000000000001",
    workerId: "worker-test", environment: {}, workspace: root, transportAudit: root } as WorkerLaunchContext;
  const processFactory = vi.fn(() => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["pipe", "pipe", "pipe"], env: { NODE_ENV: "test" } }));
  const other = new PrivateWorkerGateway({ context: { ...context, userId: "00000000-0000-4000-8000-000000000002", transportAudit: `${root}/other` }, processFactory });
  await other.start();
  const original = Server.prototype.listen;
  let release!: () => void;
  const spy = vi.spyOn(Server.prototype, "listen").mockImplementationOnce(function(this: Server, ...args: Parameters<Server["listen"]>) {
    release = () => { release = () => undefined; Reflect.apply(original, this, args); };
    return this;
  });
  const worker = new PrivateWorkerGateway({ context, processFactory });
  const starting = worker.start().catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(await starting).toMatchObject({ message: "Worker gateway startup was cancelled." });
    const child = processFactory.mock.results[1].value;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect((await worker.health()).state).toBe("stopped");
    const otherChild = processFactory.mock.results[0].value;
    expect(otherChild.exitCode).toBe(null);
    expect(otherChild.signalCode).toBe(null);
    expect((await other.health()).healthy).toBe(true);
  } finally { release?.(); spy.mockRestore(); await starting; await worker.stop(); await other.stop(); await rm(root, { recursive: true, force: true }); }
});
