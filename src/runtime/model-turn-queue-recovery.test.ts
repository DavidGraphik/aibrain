import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DurableTurnSubmission } from "./turn-submission-store";
import { FileModelTurnQueue, BackgroundModelAdmissionDeferred } from "./model-turn-queue";
import { exactQueueTerminal, modelQueueReconciler, readQueueTerminal } from "./model-turn-queue-recovery";
const roots: string[] = [];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const admissionOptions = () => ({ signal: new AbortController().signal, recovering: false, onWaiting: async () => {} });
async function fixture(maxConcurrent = 1) {
  const root = await mkdtemp(path.join(tmpdir(),"queue-recovery-")); roots.push(root);
  const usersRoot = path.join(root,"users");
  const userRoot = path.join(usersRoot,id(1));
  const workspace = path.join(userRoot,"workspace");
  await mkdir(workspace,{recursive:true,mode:0o700});
  const identity = {installationId:"test-company",userId:id(1),threadId:id(2),turnId:id(3)};
  const receipt = await DurableTurnSubmission.open({...identity,userRoot,workspace,projectId:id(4),assistantMessageId:id(3),binding:"a".repeat(64)});
  await receipt.prepareInputs(async()=>({directory:null,codexInputs:[]}));
  await receipt.bindThread("remote-thread");
  await receipt.dispatchOnce({threadId:"remote-thread",input:[],clientUserMessageId:id(5)},`turn-start:${id(3)}`);
  await receipt.bindTurn("remote-turn");
  const queue = new FileModelTurnQueue(path.join(root,"queue"),{maxConcurrent,pollMs:5,waitMs:500});
  const admission = await queue.acquire(identity,admissionOptions());
  const readTerminal = vi.fn(async()=>"interrupted" as const);
  const reconcile = modelQueueReconciler({installationId:identity.installationId,usersRoot,readTerminal});
  return {root,queue,receipt,identity,admission,reconcile,readTerminal};
}
afterEach(async()=>{ await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true}))); });
describe("orphan admission reconciliation",()=>{
  it("persists proven terminal before releasing an orphan and admits another user",async()=>{
    const f=await fixture(); await f.receipt.close();
    await f.queue.reconcileRunning(f.reconcile);
    const receipt=JSON.parse(await readFile(f.receipt.filePath,"utf8"));
    expect(receipt).toMatchObject({phase:"terminal",terminal:"interrupted",runtimeTurnId:"remote-turn"});
    expect(f.readTerminal).toHaveBeenCalledWith(id(1),"remote-thread","remote-turn",null);
    expect(JSON.parse(await readFile(path.join(f.root,"queue/queue.json"),"utf8")).tickets).toEqual([]);
    await (await f.queue.acquire({...f.identity,userId:id(6),turnId:id(7)},admissionOptions())).complete();
  });
  it("keeps a live runner's admission and never probes its provider",async()=>{
    const f=await fixture();
    try { await f.queue.reconcileRunning(f.reconcile); expect(f.readTerminal).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(path.join(f.root,"queue/queue.json"),"utf8")).tickets).toHaveLength(1);
    } finally {await f.receipt.close();}
  });
  it.each([null,"failure"])("retains unknown or failed reads regardless of age: %s",async status=>{
    const f=await fixture(); await f.receipt.close();
    const file=path.join(f.root,"queue/queue.json"); const state=JSON.parse(await readFile(file,"utf8"));state.tickets[0].seenAt=1;
    await writeFile(file,JSON.stringify(state),{mode:0o600});
    const reconcile=modelQueueReconciler({installationId:f.identity.installationId,usersRoot:path.join(f.root,"users"),readTerminal:async()=>{if(status==="failure")throw Error("unavailable");return null;}});
    await f.queue.reconcileRunning(reconcile);
    expect(JSON.parse(await readFile(file,"utf8")).tickets).toHaveLength(1);
    expect(JSON.parse(await readFile(f.receipt.filePath,"utf8")).phase).toBe("dispatched");
  });
  it("preserves both occupied slots when one runner is live and the other has no terminal proof",async()=>{
    const f=await fixture(2);
    const other=await f.queue.acquire({...f.identity,userId:id(8),turnId:id(9)},admissionOptions());
    try {
      await f.queue.reconcileRunning(f.reconcile);
      const state=JSON.parse(await readFile(path.join(f.root,"queue/queue.json"),"utf8"));
      expect(state.tickets.filter((ticket:{state:string})=>ticket.state==="running")).toHaveLength(2);
      expect(f.readTerminal).not.toHaveBeenCalled();
    } finally {await f.receipt.close();await other.complete();await f.admission.complete();}
  });
  it("releases a crashed pre-dispatch admission without contacting the provider",async()=>{
    const f=await fixture();await f.receipt.close();
    const data=JSON.parse(await readFile(f.receipt.filePath,"utf8"));
    Object.assign(data,{phase:"preparing",terminal:null,runtimeThreadId:null,runtimeTurnId:null,turnRequest:null,inputs:null});
    await writeFile(f.receipt.filePath,JSON.stringify(data),{mode:0o600});
    await f.queue.reconcileRunning(f.reconcile);
    expect(f.readTerminal).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path.join(f.root,"queue/queue.json"),"utf8")).tickets).toEqual([]);
  });
  it("does not delete a changed queue owner after a reconciliation snapshot",async()=>{
    const f=await fixture();await f.receipt.close();
    let successor:Awaited<ReturnType<FileModelTurnQueue["acquire"]>>|undefined;
    await f.queue.reconcileRunning(async(_ticket,release)=>{
      successor=await f.queue.acquire(f.identity,{...admissionOptions(),recovering:true});
      await release();
    });
    expect(JSON.parse(await readFile(path.join(f.root,"queue/queue.json"),"utf8")).tickets).toHaveLength(1);
    await successor!.complete();
  });
  it("reconciles from FIFO admission without waiting for the abandoned chat to reopen",async()=>{
    const f=await fixture();await f.receipt.close();
    await (await f.queue.acquire({...f.identity,userId:id(8),turnId:id(9)},{...admissionOptions(),reconcileRunning:f.reconcile})).complete();
    expect(f.readTerminal).toHaveBeenCalledTimes(1);
  });
  it.each(["durable-terminal", "provider-terminal"] as const)("reconciles a real legacy reservation before background deferral: %s", async evidence => {
    const f = await fixture(2);
    if (evidence === "durable-terminal") await f.receipt.observeTerminal("remote-turn", "completed");
    await f.receipt.close();
    await rm(path.join(f.root, "queue/execution-classes.json")); // old four-field queue, no class
    const reconcile = vi.fn(f.reconcile), dispatch = vi.fn();
    const next = await f.queue.acquire({ ...f.identity, userId: id(8), turnId: id(9) }, {
      ...admissionOptions(), backgroundExecution: true, reconcileRunning: reconcile,
      onWaiting: async () => { throw new Error("Background must not enter human waiting UI"); },
    });
    dispatch(); // only reachable once admission returns
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(f.readTerminal).toHaveBeenCalledTimes(evidence === "provider-terminal" ? 1 : 0);
    expect(JSON.parse(await readFile(f.receipt.filePath, "utf8"))).toMatchObject({ phase: "terminal", terminal: evidence === "durable-terminal" ? "completed" : "interrupted" });
    const state = JSON.parse(await readFile(path.join(f.root, "queue/queue.json"), "utf8"));
    expect(state.tickets).toHaveLength(1);
    expect(state.tickets[0].state).toBe("running");
    expect(Object.keys(state.tickets[0]).sort()).toEqual(["key", "owner", "seenAt", "state"]);
    await next.complete();
  });

  it.each(["live", "unknown", "unavailable"] as const)("probes once then defers background without dispatch or eviction when %s", async status => {
    const f = await fixture(2);
    if (status !== "live") await f.receipt.close();
    await rm(path.join(f.root, "queue/execution-classes.json"));
    const file = path.join(f.root, "queue/queue.json");
    const original = JSON.parse(await readFile(file, "utf8")); original.tickets[0].seenAt = 1;
    await writeFile(file, JSON.stringify(original), { mode: 0o600 });
    const readTerminal = vi.fn(async () => { if (status === "unavailable") throw Error("unavailable"); return null; });
    const reconcile = vi.fn(modelQueueReconciler({ installationId: f.identity.installationId, usersRoot: path.join(f.root, "users"), readTerminal }));
    const dispatch = vi.fn();
    const attempt = async () => {
      const next = await f.queue.acquire({ ...f.identity, userId: id(8), turnId: id(9) }, { ...admissionOptions(), backgroundExecution: true, reconcileRunning: reconcile });
      dispatch(); await next.complete();
    };
    try {
      await expect(attempt()).rejects.toBeInstanceOf(BackgroundModelAdmissionDeferred);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(readTerminal).toHaveBeenCalledTimes(status === "live" ? 0 : 1);
      expect(dispatch).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(original);
      expect(JSON.parse(await readFile(f.receipt.filePath, "utf8")).terminal).toBeNull();
    } finally { if (status === "live") await f.receipt.close(); }
  });

  it("does not re-observe background admission if a recovered owner invalidated the release proof", async () => {
    const f = await fixture(2); await f.receipt.close();
    await rm(path.join(f.root, "queue/execution-classes.json"));
    let successor: Awaited<ReturnType<FileModelTurnQueue["acquire"]>> | undefined;
    const reconcile = vi.fn<import("./model-turn-queue").ModelQueueReconciler>(async (_ticket, release) => {
      successor = await f.queue.acquire(f.identity, { ...admissionOptions(), recovering: true });
      await release(); // snapshotted owner has changed; nothing may be removed
    });
    try {
      await expect(f.queue.acquire({ ...f.identity, userId: id(8), turnId: id(9) }, { ...admissionOptions(), backgroundExecution: true, reconcileRunning: reconcile })).rejects.toBeInstanceOf(BackgroundModelAdmissionDeferred);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await readFile(path.join(f.root, "queue/queue.json"), "utf8")).tickets).toHaveLength(1);
    } finally { await successor?.complete(); }
  });

  it("uses bounded summary pagination for the exact provider turn",async()=>{
    const request=vi.fn().mockResolvedValueOnce({thread:{id:"thread",turns:[]}})
      .mockResolvedValueOnce({data:[{id:"other",status:"completed"}],nextCursor:"next"})
      .mockResolvedValueOnce({data:[{id:"turn",status:"interrupted"}],nextCursor:null});
    expect(await readQueueTerminal({request},"thread","turn","queue-test")).toBe("interrupted");
    expect(request.mock.calls[0][1]).toEqual({threadId:"thread",includeTurns:false});
    expect(request.mock.calls[1][1]).toMatchObject({itemsView:"summary",limit:25});
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("does not trust a warm process's reconstructed status for an unloaded thread",async()=>{
    const request=vi.fn().mockResolvedValue({thread:{id:"thread",status:{type:"notLoaded"},turns:[{id:"turn",status:"interrupted"}]}});
    await expect(readQueueTerminal({request},"thread","turn","queue-warm",5000,{requireLoaded:true})).rejects.toThrow("does not own");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects foreign thread metadata before paging",async()=>{
    const request=vi.fn().mockResolvedValue({thread:{id:"foreign"}});
    expect(await readQueueTerminal({request},"thread","turn","queue-test")).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("accepts only exact unique terminal provider evidence",()=>{
    const reply=(id:string,status:string)=>({thread:{id:"thread",turns:[{id,status}]}});
    expect(exactQueueTerminal(reply("turn","completed"),"thread","turn")).toBe("completed");
    for(const value of [reply("other","completed"),reply("turn","inProgress"),reply("turn","unexpected"),{thread:{id:"other",turns:[{id:"turn",status:"completed"}]}},{thread:{id:"thread",turns:[{id:"turn",status:"completed"},{id:"turn",status:"failed"}]}}]) expect(exactQueueTerminal(value,"thread","turn")).toBeNull();
  });
});
