import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileAutomationAudienceStore } from "@/automations/audience-store";

vi.mock("server-only", () => ({}));

const roots: string[] = [];
const delivery = {
  runKey: "10000000-0000-4000-8000-000000000001:2026-08-30T09:00:00.000Z",
  taskId: "10000000-0000-4000-8000-000000000001",
  ownerUserId: "00000000-0000-4000-8000-000000000001",
  projectId: "20000000-0000-4000-8000-000000000001",
  threadId: "30000000-0000-4000-8000-000000000001",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileAutomationAudienceStore", () => {
  it("records one delivery across retry and restart", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "aibrain-audience-delivery-"));
    roots.push(dataRoot);
    const now = () => Date.parse("2026-08-30T09:00:00.000Z");
    const first = new FileAutomationAudienceStore({ installationId: "audience-qa", dataRoot, now });
    const initial = await first.record(delivery);
    const retried = await first.record(delivery);
    const restarted = new FileAutomationAudienceStore({ installationId: "audience-qa", dataRoot, now });

    expect(retried).toEqual(initial);
    expect(await restarted.list()).toEqual([initial]);
    expect(await restarted.findByThread(delivery.threadId)).toEqual(initial);
  });

  it("fails closed if a run key or thread is rebound", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "aibrain-audience-delivery-"));
    roots.push(dataRoot);
    const store = new FileAutomationAudienceStore({ installationId: "audience-qa", dataRoot });
    await store.record(delivery);
    await expect(store.record({ ...delivery, threadId: "30000000-0000-4000-8000-000000000002" }))
      .rejects.toMatchObject({ code: "AUTOMATION_DELIVERY_CONFLICT" });
    await expect(store.record({ ...delivery, runKey: `${delivery.runKey}:retry`, taskId: "10000000-0000-4000-8000-000000000002" }))
      .rejects.toMatchObject({ code: "AUTOMATION_DELIVERY_CONFLICT" });
  });
});


it("preserves legacy delivery files and persists quiet only for the exact admitted delivery",async()=>{
 const dataRoot=await mkdtemp(path.join(os.tmpdir(),"aibrain-quiet-delivery-"));roots.push(dataRoot);
 const store=new FileAutomationAudienceStore({installationId:"audience-qa",dataRoot});await store.record(delivery);
 const file=path.join(dataRoot,"automation-audience","thread-deliveries.json"),legacy=JSON.parse(await readFile(file,"utf8"));
 await writeFile(file,JSON.stringify(legacy),{mode:0o600});
 expect(await store.listQuiet()).toEqual([]);
 await expect(store.markQuiet({...delivery,taskId:"90000000-0000-4000-8000-000000000009"})).rejects.toMatchObject({code:"AUTOMATION_DELIVERY_CONFLICT"});
 await store.markQuiet(delivery);expect(await store.listQuiet()).toEqual(await store.list());
 expect(await readFile(file,"utf8")).toBe(JSON.stringify(legacy));
 await store.markQuiet(delivery);expect(await store.listQuiet()).toHaveLength(1);
});


it("reuses only unchanged request metadata and detects newly bound deliveries and corruption", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "aibrain-audience-scan-")); roots.push(dataRoot);
  const store = new FileAutomationAudienceStore({ installationId: "audience-qa", dataRoot });
  const read = store.createThreadReader();
  expect(await read(delivery.threadId)).toBeNull();
  await store.record(delivery);
  const list = vi.spyOn(store, "list");
  const first = await read(delivery.threadId);
  expect(first).toMatchObject(delivery);
  first!.taskId = "mutated response";
  expect(await read(delivery.threadId)).toMatchObject(delivery);
  expect(list).toHaveBeenCalledTimes(1);
  const file = path.join(dataRoot, "automation-audience", "thread-deliveries.json");
  await writeFile(file, "{}");
  await expect(read(delivery.threadId)).rejects.toThrow();
  list.mockRestore();
});


it("keeps separate occurrence receipts in one task conversation and rejects cross-scope reuse",async()=>{
 const dataRoot=await mkdtemp(path.join(os.tmpdir(),"aibrain-recurring-delivery-"));roots.push(dataRoot);
 const store=new FileAutomationAudienceStore({installationId:"audience-qa",dataRoot});
 const second={...delivery,runKey:delivery.taskId+":2026-08-30T09:30:00.000Z"};
 await store.record(delivery);await store.record(second);await store.markQuiet(second);
 const restarted=new FileAutomationAudienceStore({installationId:"audience-qa",dataRoot});
 expect(await restarted.list()).toHaveLength(2);expect(await restarted.listQuiet()).toMatchObject([second]);
 expect(await restarted.createThreadReader()(delivery.threadId)).toMatchObject(second);
 for(const patch of [{taskId:"10000000-0000-4000-8000-000000000002"},{ownerUserId:"00000000-0000-4000-8000-000000000002"},{projectId:"20000000-0000-4000-8000-000000000002"}])
  await expect(store.record({...second,runKey:second.runKey+":cross-scope",...patch})).rejects.toMatchObject({code:"AUTOMATION_DELIVERY_CONFLICT"});
});
