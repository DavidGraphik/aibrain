import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DurableTurnSubmission, TurnSubmissionRecoveryRequired, turnSubmissionBinding } from "./turn-submission-store";
import * as storage from "@/storage";
import { atomicWriteFile } from "@/storage/atomic-file";
import { FileDocumentStagingStore } from "@/documents/staging-store";
import { validateUploadedDocument } from "@/documents/upload-validation";
import { generateLocalDocument } from "@/runtime/documents/local-document-generator";
import { prepareTurnDocumentWorkspaceInputs } from "@/documents/turn-attachments";

const roots: string[] = [];
const leases: DurableTurnSubmission[] = [];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rpc = { threadId: "remote-thread", clientUserMessageId: id(5), input: [{ type: "text", text: "Fictional invoice", text_elements: [] }] };
const requestId = `turn-start:${id(4)}`;

async function fixture() {
  const userRoot = await mkdtemp(path.join(tmpdir(), "aibrain-submission-test-"));
  roots.push(userRoot);
  const workspace = path.join(userRoot, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const options = { userRoot, workspace, installationId: "test-company", userId: id(1),
    projectId: id(2), threadId: id(3), assistantMessageId: id(4),
    binding: turnSubmissionBinding(["test-company", id(1), id(2), id(3), id(4), id(5), "permission-fingerprint", "source-hash"]) };
  const open = async (overrides: Partial<typeof options> = {}) => {
    const value = await DurableTurnSubmission.open({ ...options, ...overrides });
    leases.push(value);
    return value;
  };
  const prepare = vi.fn(async (created: (directory: string) => Promise<void>) => {
    const directory = await mkdtemp(path.join(workspace, ".aibrain-turn-inputs-"));
    await created(directory);
    await writeFile(path.join(directory, "input-1.xlsx"), "original synthetic bytes", { mode: 0o600 });
    return { directory, codexInputs: [{ type: "text" as const,
      text: JSON.stringify([{ relativePath: `${path.basename(directory)}/input-1.xlsx` }]), text_elements: [] }] };
  });
  return { userRoot, options, open, prepare };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(leases.splice(0).map(lease => lease.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("durable turn submission", () => {
  it("persists the exact execution generation before dispatch in a rollback-compatible private sidecar", async () => {
    const f=await fixture();const receipt=await f.open();
    const origin={generation:id(20),instanceId:"automation-worker",dev:1,ino:2};
    await receipt.bindExecutionOrigin(origin,requestId);
    expect(await receipt.executionOrigin()).toBeNull();
    await receipt.prepareInputs(async()=>({directory:null,codexInputs:[]}));
    await receipt.bindThread("remote-thread");await receipt.dispatchOnce(rpc,requestId);await receipt.bindTurn("origin-turn");
    expect(await receipt.executionOrigin()).toEqual(origin);
    await expect(receipt.bindExecutionOrigin({...origin,generation:id(21)},requestId)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
    const stored=JSON.parse(await readFile(receipt.filePath,"utf8"));expect(stored.schemaVersion).toBe(1);expect(stored).not.toHaveProperty("origin");
    await receipt.close();const reopened=await f.open();expect(await reopened.executionOrigin()).toEqual(origin);
    await reopened.close();
    const rollback=JSON.parse(await readFile(receipt.filePath,"utf8"));rollback.runtimeTurnId="rollback-later-turn";
    await writeFile(receipt.filePath,JSON.stringify(rollback),{mode:0o600});
    const afterRollback=await f.open();expect(await afterRollback.executionOrigin()).toBeNull();
  });

  it("settles only the exact proven unsent turn into a durable no-replay tombstone", async () => {
    const f = await fixture();
    const receipt = await f.open();
    await receipt.prepareInputs(f.prepare);
    await receipt.bindThread("remote-thread");
    await receipt.dispatchOnce(rpc, requestId);
    await expect(receipt.rejectTurnBeforeSend("wrong-request")).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
    await receipt.rejectTurnBeforeSend(requestId);
    expect(receipt.turnRejectedBeforeSend).toBe(true);
    await receipt.close();
    const restarted = await f.open();
    expect(restarted.turnRejectedBeforeSend).toBe(true);
    expect(restarted.runtimeTurnId).toBeNull();
    const record = JSON.parse(await readFile(receipt.filePath, "utf8"));
    expect(record).toMatchObject({ phase: "terminal", terminal: "failed", inputs: null, inputDirectory: null,
      turnRequest: JSON.stringify({ method: "turn/start", id: requestId, params: rpc }) });
    await expect(restarted.dispatchOnce(rpc, requestId)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
  });

  it("never settles a bound remote model turn as a local pre-send rejection", async () => {
    const f = await fixture();
    const receipt = await f.open();
    await receipt.prepareInputs(f.prepare);
    await receipt.bindThread("remote-thread");
    await receipt.dispatchOnce(rpc, requestId);
    await receipt.bindTurn("accepted-remote-turn");
    await expect(receipt.rejectTurnBeforeSend(requestId)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
    expect(receipt.hasPendingModelTurn).toBe(true);
  });

  it("persists a confirmed pre-creation rejection as a terminal no-replay tombstone", async () => {
    const f = await fixture();
    const receipt = await f.open();
    await receipt.prepareInputs(f.prepare);
    const creationId = `thread-start:${id(4)}`;
    const creation = { cwd: f.options.workspace, ephemeral: false };
    await receipt.startThreadOnce(creation, creationId);
    await expect(receipt.rejectThreadStart("foreign-request", -32600)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
    await expect(receipt.rejectThreadStart(creationId, -32603)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
    await receipt.rejectThreadStart(creationId, -32600);
    expect(receipt.threadCreationRejected).toBe(true);
    await receipt.close();
    const restarted = await f.open();
    expect(restarted.threadCreationRejected).toBe(true);
    expect(restarted.terminal).toBe("failed");
    expect(JSON.parse(await readFile(receipt.filePath, "utf8"))).toMatchObject({ phase: "terminal", terminal: "failed",
      threadRequest: JSON.stringify({ method: "thread/start", id: creationId, params: creation }),
      runtimeThreadId: null, runtimeTurnId: null, turnRequest: null, inputs: null, inputDirectory: null });
    await expect(restarted.startThreadOnce(creation, creationId)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
    await expect(restarted.dispatchOnce(rpc, requestId)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
  });

  it("cannot declare a bound or dispatched remote turn rejected before creation", async () => {
    const f = await fixture();
    const receipt = await f.open();
    const creationId = `thread-start:${id(4)}`;
    await receipt.startThreadOnce({ cwd: f.options.workspace }, creationId);
    await receipt.bindThread("remote-thread");
    await expect(receipt.rejectThreadStart(creationId, -32600)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
    await receipt.prepareInputs(f.prepare);
    await receipt.dispatchOnce(rpc, requestId);
    await expect(receipt.rejectThreadStart(creationId, -32600)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
    expect(receipt.threadCreationRejected).toBe(false);
    expect(receipt.terminal).toBeNull();
  });

  it("admits original PDF working copies through durable submission and restart while rejecting modified bytes", async () => {
    const f = await fixture();
    const stagingRoot = path.join(f.userRoot, "staging");
    const staging = new FileDocumentStagingStore(stagingRoot, new storage.ResourceLockManager({rootDirectory:path.join(f.userRoot,"locks")}));
    const pdf = await generateLocalDocument({format:"pdf",title:"Fictional original scan",content:"Fictional commission EUR 47.08"});
    const document = await staging.stage({threadId:id(3),uploadId:id(7),validated:validateUploadedDocument({fileName:"source.pdf",declaredMimeType:"application/pdf",data:pdf.data}),data:pdf.data});
    const prepare = vi.fn((onDirectoryCreated: (directory: string) => Promise<void>) => prepareTurnDocumentWorkspaceInputs({documents:[{document,absolutePath:path.join(stagingRoot,document.relativePath),codexInputs:[]}],projectWorkspace:f.options.workspace,stagingRoot,onDirectoryCreated}));
    const first = await f.open();
    const inputs = await first.prepareInputs(prepare);
    await first.validateWorkingCopies();
    await first.close();
    const restarted = await f.open();
    expect(await restarted.prepareInputs(prepare)).toEqual(inputs);
    expect(prepare).toHaveBeenCalledOnce();
    await restarted.bindThread("remote-thread");
    await restarted.dispatchOnce(rpc,requestId);
    expect(await readFile(path.join(inputs.directory!,"input-1.pdf"))).toEqual(pdf.data);
    await writeFile(path.join(inputs.directory!,"input-1.pdf"),"%PDF-modified",{mode:0o600});
    await expect(restarted.validateWorkingCopies()).rejects.toThrow("Admitted PDF bytes changed");
    expect(await readFile(path.join(stagingRoot,document.relativePath))).toEqual(pdf.data);
  });

  it.each([
    ["png", "image/png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/1cAAAAASUVORK5CYII=", "base64")],
    ["jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ["gif", "image/gif", Buffer.from("GIF89a synthetic original")],
    ["webp", "image/webp", Buffer.from("RIFF0000WEBP synthetic original")],
  ])("admits a staged original %s image through real workspace preparation, restart and turn dispatch", async (extension, mediaType, bytes) => {
    const f = await fixture();
    const stagingRoot = path.join(f.userRoot, "staging");
    const staging = new FileDocumentStagingStore(stagingRoot, new storage.ResourceLockManager({ rootDirectory: path.join(f.userRoot, "locks") }));
    const document = await staging.stage({ threadId: id(3), uploadId: id(7),
      validated: validateUploadedDocument({ fileName: `source.${extension}`, declaredMimeType: mediaType, data: bytes }), data: bytes });
    const prepare = vi.fn((onDirectoryCreated: (directory: string) => Promise<void>) => prepareTurnDocumentWorkspaceInputs({
      documents: [{ document, absolutePath: path.join(stagingRoot, document.relativePath), codexInputs: [] }],
      projectWorkspace: f.options.workspace, stagingRoot, onDirectoryCreated,
    }));
    const first = await f.open();
    const inputs = await first.prepareInputs(prepare);
    await first.validateWorkingCopies();
    const workingCopy = path.join(inputs.directory!, `input-1.${extension}`);
    expect(await readFile(workingCopy)).toEqual(bytes);
    await first.close();
    const restarted = await f.open();
    await restarted.prepareInputs(prepare);
    await restarted.validateWorkingCopies();
    expect(prepare).toHaveBeenCalledOnce();
    await restarted.bindThread("remote-thread");
    await restarted.dispatchOnce(rpc, requestId);
    await writeFile(workingCopy, "changed image bytes", { mode: 0o600 });
    await expect(restarted.validateWorkingCopies()).rejects.toThrow("Admitted image bytes changed");
    expect(await readFile(path.join(stagingRoot, document.relativePath))).toEqual(bytes);
  });

  it.each(["svg", "js", "png.exe"])("keeps unsupported %s working-copy paths outside image admission", async extension => {
    const f = await fixture();
    const first = await f.open();
    await first.prepareInputs(async onDirectoryCreated => {
      const directory = await mkdtemp(path.join(f.options.workspace, ".aibrain-turn-inputs-"));
      await onDirectoryCreated(directory);
      const name = `input-1.${extension}`;
      await writeFile(path.join(directory, name), "untrusted content", { mode: 0o600 });
      return { directory, codexInputs: [{ type: "text", text: JSON.stringify([
        { relativePath: `${path.basename(directory)}/${name}` },
      ]), text_elements: [] }] };
    });
    await expect(first.validateWorkingCopies()).rejects.toThrow("Invalid admitted attachment path");
  });

  it("persists the chosen fallback and rejects a changed model after restart", async () => {
    const f = await fixture();
    let receipt = await f.open();
    await receipt.bindThread("remote-thread");
    await receipt.prepareInputs(f.prepare);
    await receipt.dispatchOnce(rpc, requestId);
    await receipt.bindTurn("rejected");
    await receipt.observeTerminal("rejected", "failed");
    const fallback = { model: "gpt-5.6-sol", effort: "medium" as const };
    await receipt.retryRejectedCapacityTurn({ id: "rejected", status: "failed", error: { codexErrorInfo: "serverOverloaded" },
      items: [{ type: "userMessage", clientId: rpc.clientUserMessageId }] }, rpc.clientUserMessageId, fallback);
    await receipt.close();
    receipt = await f.open();
    expect(receipt.retryModel).toEqual(fallback);
    await receipt.prepareInputs(f.prepare);
    const next = { ...rpc, clientUserMessageId: receipt.retryClientUserMessageId, ...fallback };
    await expect(receipt.dispatchOnce({ ...next, model: "gpt-6-astra" }, `${requestId}:retry`)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
    await receipt.dispatchOnce(next, `${requestId}:retry`);
    expect(receipt.hasPendingModelTurn).toBe(true);
  });
  it("retains the two-retry budget and exact attempt identity across restarts", async () => {
    const f = await fixture();
    let receipt = await f.open();
    let clientId = rpc.clientUserMessageId;
    for (let attempt = 0; attempt <= 2; attempt += 1) {
      await receipt.bindThread("remote-thread");
      await receipt.prepareInputs(f.prepare);
      await receipt.dispatchOnce({ ...rpc, clientUserMessageId: clientId }, `${requestId}:${attempt}`);
      const turnId = `rejected-turn-${attempt}`;
      await receipt.bindTurn(turnId);
      await receipt.observeTerminal(turnId, "failed");
      const rejected = { id: turnId, status: "failed", error: { codexErrorInfo: "serverOverloaded" },
        items: [{ type: "userMessage", clientId }] };
      if (attempt === 2) {
        await expect(receipt.retryRejectedCapacityTurn(rejected, clientId)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
        expect(receipt.terminal).toBe("failed");
        break;
      }
      await expect(receipt.retryRejectedCapacityTurn({ ...rejected, items: [...rejected.items, { type: "commandExecution" }] }, clientId))
        .rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
      await expect(receipt.retryRejectedCapacityTurn({ ...rejected, items: [{ type: "userMessage", clientId: id(99) }] }, id(99)))
        .rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
      await receipt.retryRejectedCapacityTurn(rejected, clientId);
      expect(receipt.capacityRetries).toBe(attempt + 1);
      expect(receipt.needsRecovery).toBe(false);
      expect(receipt.rejectedRuntimeTurnId).toBe(turnId);
      const nextClientId = receipt.retryClientUserMessageId!;
      expect(nextClientId).not.toBe(clientId);
      await receipt.close();
      receipt = await f.open();
      expect(receipt.retryClientUserMessageId).toBe(nextClientId);
      expect(receipt.capacityRetries).toBe(attempt + 1);
      clientId = nextClientId;
    }
  });

  it("upgrades a legacy receipt while preserving its dispatched fence", async () => {
    const f = await fixture();
    const receipt = await f.open();
    await receipt.bindThread("remote-thread");
    await receipt.prepareInputs(f.prepare);
    await receipt.dispatchOnce(rpc, requestId);
    const legacy = JSON.parse(await readFile(receipt.filePath, "utf8"));
    legacy.schemaVersion = 1;
    for (const key of ["capacityRetries", "retryClientUserMessageId", "rejectedRuntimeTurnId", "dispatchedClientUserMessageId"]) delete legacy[key];
    await receipt.close();
    await writeFile(receipt.filePath, JSON.stringify(legacy), { mode: 0o600 });
    const restarted = await f.open();
    expect(restarted.needsRecovery).toBe(true);
    expect(restarted.capacityRetries).toBe(0);
    await expect(restarted.dispatchOnce(rpc, requestId)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
  });
  it("fences a failed write acknowledgement after the intent reached disk", async () => {
    const f = await fixture();
    const first = await f.open();
    await first.bindThread("remote-thread");
    await first.prepareInputs(f.prepare);
    vi.spyOn(storage, "atomicWriteFile").mockImplementationOnce(async (...args) => {
      await atomicWriteFile(...args);
      throw Object.assign(new Error("simulated directory fsync failure"), { code: "EIO" });
    });
    await expect(first.dispatchOnce(rpc, requestId)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
    expect(first.needsRecovery).toBe(true);
    await expect(first.dispatchOnce(rpc, requestId)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
    await first.close();
    const restarted = await f.open();
    expect(restarted.needsRecovery).toBe(true);
    await expect(restarted.dispatchOnce(rpc, requestId)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
  });

  it("resumes prepared inputs after restart, without preparing or converting them again", async () => {
    const f = await fixture();
    const first = await f.open();
    const inputs = await first.prepareInputs(f.prepare);
    await first.bindThread("remote-thread");
    await first.close();
    const restarted = await f.open();
    expect(await restarted.prepareInputs(f.prepare)).toEqual(inputs);
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(restarted.needsRecovery).toBe(false);
    await restarted.dispatchOnce(rpc, requestId);
    const record = JSON.parse(await readFile(restarted.filePath, "utf8"));
    expect(record.turnRequest).toBe(JSON.stringify({ method: "turn/start", id: requestId, params: rpc }));
  });

  it("never dispatches again after a write-ahead intent, even before acceptance or after receipt eviction", async () => {
    const f = await fixture();
    const first = await f.open();
    const inputs = await first.prepareInputs(f.prepare);
    await first.bindThread("remote-thread");
    await first.dispatchOnce(rpc, requestId);
    await writeFile(path.join(inputs.directory!, "input-1.xlsx"), "in-progress edit", { mode: 0o600 });
    await first.close();
    const restarted = await f.open();
    expect(restarted.needsRecovery).toBe(true);
    await expect(restarted.dispatchOnce(rpc, requestId)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
    await expect(restarted.prepareInputs(f.prepare)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
    await restarted.validateWorkingCopies();
    expect(await readFile(path.join(inputs.directory!, "input-1.xlsx"), "utf8")).toBe("in-progress edit");
    await restarted.bindTurn("remote-turn");
    await restarted.observeTerminal("remote-turn", "completed");
    await restarted.close();
    await expect(access(inputs.directory!)).rejects.toMatchObject({ code: "ENOENT" });
    const tombstone = await f.open();
    expect(tombstone.terminal).toBe("completed");
    await expect(tombstone.dispatchOnce(rpc, requestId)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
    const record = JSON.parse(await readFile(tombstone.filePath, "utf8"));
    expect(record).toMatchObject({ turnRequest: null, threadRequest: null, inputs: null, inputDirectory: null });
    expect(f.prepare).toHaveBeenCalledOnce();
  });

  it("rebuilds only unpublished partial preparation after a crash", async () => {
    const f = await fixture();
    const first = await f.open();
    let partial = "";
    await expect(first.prepareInputs(async created => {
      partial = await mkdtemp(path.join(f.options.workspace, ".aibrain-turn-inputs-"));
      await created(partial);
      throw new Error("preparation crash");
    })).rejects.toThrow("preparation crash");
    await first.close();
    const restarted = await f.open();
    const inputs = await restarted.prepareInputs(f.prepare);
    expect(inputs.directory).not.toBe(partial);
    await expect(access(partial)).rejects.toMatchObject({ code: "ENOENT" });
    expect(restarted.needsRecovery).toBe(false);
  });

  it("blocks a second runner while the first lease is alive", async () => {
    const f = await fixture();
    await f.open();
    await expect(f.open()).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
  });

  it("serializes acceptance and terminal projection without resurrecting cleared payloads", async () => {
    const f = await fixture();
    const submission = await f.open();
    await submission.prepareInputs(f.prepare);
    await submission.bindThread("remote-thread");
    await submission.dispatchOnce(rpc, requestId);
    await Promise.all([submission.bindTurn("remote-turn"), submission.observeTerminal("remote-turn", "completed")]);
    await submission.bindTurn("remote-turn");
    expect(JSON.parse(await readFile(submission.filePath, "utf8"))).toMatchObject({ phase: "terminal", turnRequest: null, inputs: null });
  });

  it("retains uncertainty when thread creation acknowledgement is lost", async () => {
    const f = await fixture();
    const first = await f.open();
    await first.startThreadOnce({ cwd: f.options.workspace }, `thread-start:${id(4)}`);
    await first.close();
    const restarted = await f.open();
    expect(restarted.needsRecovery).toBe(true);
    expect(restarted.pendingThreadRequest).toEqual({ method: "thread/start", id: `thread-start:${id(4)}`,
      params: { cwd: f.options.workspace } });
    await expect(restarted.startThreadOnce({}, `thread-start:${id(4)}`)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
    await restarted.bindThread("recovered-original-thread");
    expect(restarted.needsRecovery).toBe(false);
    expect(restarted.pendingThreadRequest).toBeNull();
  });

  it("treats legacy existing admissions as recovery-only even without a new-format receipt", async () => {
    const f = await fixture();
    const submission = await DurableTurnSubmission.open({ ...f.options, recoveryOnly: true });
    leases.push(submission);
    expect(submission.needsRecovery).toBe(true);
    await expect(submission.prepareInputs(f.prepare)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("does not let an early reconnect fence out a not-yet-started first runner", async () => {
    const f = await fixture();
    const observer = await DurableTurnSubmission.open({ ...f.options, recoveryOnly: true });
    leases.push(observer);
    await observer.bindThread("remote-thread");
    await expect(observer.dispatchOnce(rpc, requestId)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
    await observer.close();
    const original = await f.open();
    await original.bindThread("remote-thread");
    await original.prepareInputs(f.prepare);
    await original.dispatchOnce(rpc, requestId);
    expect(original.needsRecovery).toBe(true);
  });

  it.each(["scope", "permissions", "sources"])("rejects a changed %s binding", async (changed) => {
    const f = await fixture();
    const first = await f.open();
    await first.close();
    await expect(f.open({ binding: turnSubmissionBinding([f.options.binding, changed]) })).rejects.toThrow("authorized request");
  });

  it.each(["missing", "symlink", "directory"])("preserves uncertainty for a %s working copy without regenerating it", async (kind) => {
    const f = await fixture();
    const submission = await f.open();
    const inputs = await submission.prepareInputs(f.prepare);
    const file = path.join(inputs.directory!, "input-1.xlsx");
    await submission.bindThread("remote-thread");
    await submission.dispatchOnce(rpc, requestId);
    await rm(file);
    const foreign = path.join(f.userRoot, "foreign-data");
    await writeFile(foreign, "preserve", { mode: 0o600 });
    if (kind === "symlink") await symlink(foreign, file);
    if (kind === "directory") await mkdir(file);
    await expect(submission.validateWorkingCopies()).rejects.toThrow();
    await expect(submission.prepareInputs(f.prepare)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
    expect(await readFile(foreign, "utf8")).toBe("preserve");
    expect(f.prepare).toHaveBeenCalledOnce();
  });

  it("rejects a receipt symlink before reading foreign state", async () => {
    const f = await fixture();
    const first = await f.open();
    const file = first.filePath;
    await first.close();
    await rm(file);
    const foreign = path.join(f.userRoot, "unrelated.json");
    await writeFile(foreign, "unrelated", { mode: 0o600 });
    await symlink(foreign, file);
    await expect(f.open()).rejects.toThrow("Unsafe durable turn file");
    expect(await readFile(foreign, "utf8")).toBe("unrelated");
  });

  it("reloads an uncertain receipt after a real process crash and expired lease", async () => {
    const f = await fixture();
    const source = `const {DurableTurnSubmission}=require('./src/runtime/turn-submission-store.ts');
      (async()=>{ const s=await DurableTurnSubmission.open(JSON.parse(process.argv[1]));
      await s.bindThread('remote-thread'); await s.prepareInputs(async()=>({directory:null,codexInputs:[]}));
      await s.dispatchOnce(${JSON.stringify(rpc)},${JSON.stringify(requestId)});
      process.stdout.write('READY\\n'); setInterval(()=>{},1000); })().catch(e=>{console.error(e);process.exit(1)});`;
    const child = spawn(process.execPath, ["--import", "tsx", "-e", source, JSON.stringify(f.options)],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", data => { stderr += data.toString(); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Child timeout: ${stderr}`)), 10_000);
        child.stdout.once("data", data => { clearTimeout(timeout); data.toString().includes("READY") ? resolve() : reject(new Error("Invalid child readiness")); });
        child.once("exit", () => { clearTimeout(timeout); reject(new Error(`Child exited: ${stderr}`)); });
      });
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      await expect(f.open()).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
      // Advance only the synthetic lease's mtime instead of sleeping 30 s.
      // Recovery still checks that its real owner PID is no longer alive.
      const lockRoot = path.join(f.userRoot, "state", ".locks");
      for (const name of await readdir(lockRoot)) await utimes(path.join(lockRoot, name), new Date(0), new Date(0));
      const restarted = await f.open();
      expect(restarted.needsRecovery).toBe(true);
      await expect(restarted.dispatchOnce(rpc, requestId)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
    } finally { child.kill("SIGKILL"); }
  }, 15_000);
});

it("retries a persisted local queue timeout that proved no dispatch, using the same receipt exactly once",async()=>{
 const f=await fixture();const queued=await f.open();
 expect(queued.modelTurnNotDispatched).toBe(true);
 await queued.close();
 // The scheduled executor reopens an existing failed UI message in recovery
 // mode. Its persisted preparing receipt is authoritative; no fresh ID needed.
 const retry=await DurableTurnSubmission.open({...f.options,recoveryOnly:true});leases.push(retry);
 expect(retry.needsRecovery).toBe(false);expect(retry.modelTurnNotDispatched).toBe(true);
 await retry.prepareInputs(f.prepare);await retry.bindThread("remote-thread");
 await retry.dispatchOnce(rpc,requestId);expect(retry.hasPendingModelTurn).toBe(true);
 await retry.close();
 const duplicate=await DurableTurnSubmission.open({...f.options,recoveryOnly:true});leases.push(duplicate);
 expect(duplicate.needsRecovery).toBe(true);
 await expect(duplicate.dispatchOnce(rpc,requestId)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
});
