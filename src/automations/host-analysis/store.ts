import { createHostBudget, admitHostBudget, hostWaitDeadline, type HostBudget } from "./budget";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { readRegularFileWithin } from "@/security/safe-file";
import { atomicWriteJson } from "@/storage/atomic-file";
import { ResourceLockManager } from "@/storage/resource-lock";
import type { StorageSchema } from "@/storage/schema";
import { isAutomationAudience } from "@/automations/contracts";
import type { AutomationAudience, AutomationTask } from "@/automations/contracts";
import { FileAutomationStore } from "@/automations/store";
import { FileLocalUserStore } from "@/auth/local-user-store";
import { automationWorkspaceContext, validateAutomationAudience } from "@/automations/server-service";
import { currentHostPermissions } from "./permissions";
import { provisionedAutomationPrincipal } from "@/automations/principal";
import { getWritableProject } from "@/workbench/store";
import { BackgroundModelAdmissionDeferred, FileModelTurnQueue } from "@/runtime/model-turn-queue";
import type { InstallationConfig } from "@/config/installation-schema";
import { HOST_ANALYSIS_JOBS, isHostJob, UUID, digest, parseHostEnvelope, stableId, type HostAnalysisEnvelope, type HostAnalysisJob } from "./contracts";

export type HostBinding = { schemaVersion: 1; job: HostAnalysisJob; generation: string; taskId: string; installationId: string; userId: string; email: string; projectId: string; audience: AutomationAudience; active: boolean; provisioning?: boolean };
export type HostSubmission = { schemaVersion: 1 | 2; requestId: string; generation: string; taskId: string; userId: string; inputDigest: string; envelope: HostAnalysisEnvelope; cancelled: boolean; budget?: HostBudget; cancellationReason?: string; terminalCommitted?: boolean };
const missing = (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === "ENOENT";
const schema: StorageSchema<{ payload: unknown; mac: string }> = { name: "SignedHostAnalysis", parse(v) {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== "mac,payload" || !("mac" in v) || typeof v.mac !== "string" || !/^[a-f0-9]{64}$/.test(v.mac) || !("payload" in v)) throw Error("HOST_RECORD_INVALID");
  return { payload: v.payload, mac: v.mac };
} };
export class HostAnalysisStore {
  readonly root: string;
  readonly locks: ResourceLockManager;
  private readonly key: string;
  constructor(readonly installation: Readonly<InstallationConfig>, key?: string, readonly now: () => number = Date.now) {
    this.root = path.join(installation.paths.dataRoot, "host-analysis");
    this.locks = new ResourceLockManager({ rootDirectory: path.join(this.root, "locks") });
    this.key = key ?? (process.env.AIBRAIN_AUTH_CHALLENGE_SECRET?.trim() || process.env.AIBRAIN_SESSION_SECRET?.trim() || "");
    if (this.key.length < 32) throw Error("HOST_BINDING_SIGNING_SECRET_REQUIRED");
  }
  tasks(userId: string) { return new FileAutomationStore({ installationId: this.installation.installationId, userId, usersRoot: this.installation.paths.usersRoot, now: this.now }); }
  private mac(name: string, payload: unknown) { return createHmac("sha256", this.key).update("aibrain-host-analysis-v1\0").update(this.installation.installationId).update("\0" + name + "\0").update(JSON.stringify(payload)).digest("hex"); }
  private async read<T>(name: string): Promise<T | null> {
    try {
      const raw = schema.parse(JSON.parse((await readRegularFileWithin(this.root, name, 32 * 1024 * 1024)).toString("utf8")));
      if (!timingSafeEqual(Buffer.from(raw.mac, "hex"), Buffer.from(this.mac(name, raw.payload), "hex"))) throw Error("HOST_RECORD_TAMPERED");
      return raw.payload as T;
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  private write(name: string, payload: unknown) { return atomicWriteJson(path.join(this.root, name), { payload, mac: this.mac(name, payload) }, schema); }
  async binding(job: HostAnalysisJob) {
    if (!isHostJob(job)) throw Error("UNAUTHORIZED_AUTOMATION_JOB");
    const b = await this.read<HostBinding>(`bindings/${job}.json`);
    if (b && (b.schemaVersion !== 1 || typeof b.active !== "boolean" || !UUID.test(b.projectId) || !isAutomationAudience(b.audience) || b.job !== job || b.installationId !== this.installation.installationId || !UUID.test(b.taskId) || !UUID.test(b.userId) || !UUID.test(b.generation))) throw Error("HOST_BINDING_INVALID");
    return b;
  }
  async forTask(taskId: string) {
    for (const job of HOST_ANALYSIS_JOBS) { const b = await this.binding(job); if (b?.taskId === taskId) return b; }
    return null;
  }
  // Called ONLY after genuine UI session, project and audience authorization.
  async authorize(input: Omit<HostBinding, "schemaVersion" | "generation" | "taskId" | "active">, createTask: (binding: HostBinding) => Promise<void>) {
    return this.locks.withLock(`binding:${input.job}`, async () => {
      const current = await this.binding(input.job);
      if (current && current.userId !== input.userId) throw Error("HOST_BINDING_CONFLICT");
      if (current?.active) {
        if (current.userId !== input.userId || current.projectId !== input.projectId || digest(current.audience) !== digest(input.audience)) throw Error("HOST_BINDING_CONFLICT");
        return current;
      }
      const binding: HostBinding = current?.provisioning ? current : { ...input, schemaVersion: 1, generation: randomUUID(), taskId: randomUUID(), active: false, provisioning: true };
      if (binding.projectId !== input.projectId || digest(binding.audience) !== digest(input.audience)) throw Error("HOST_BINDING_CONFLICT");
      await this.write(`bindings/${input.job}.json`, binding);
      await createTask(binding); // external schedule cannot fire without a submission
      await this.write(`bindings/${input.job}.json`, { ...binding, active: true, provisioning: false });
      return { ...binding, active: true, provisioning: false };
    });
  }
  async revoke(job: HostAnalysisJob, userId: string) {
    return this.locks.withLock(`binding:${job}`, async () => {
      const b = await this.binding(job); if (!b || b.userId !== userId) throw Error("HOST_BINDING_DENIED");
      await this.write(`bindings/${job}.json`, { ...b, active: false, provisioning: false });
      await this.tasks(b.userId).update(b.taskId, { state: "paused" });
    });
  }
  async assertActive(binding: HostBinding): Promise<AutomationTask> {
    const current = await this.binding(binding.job);
    const user = await new FileLocalUserStore(this.installation.paths.usersRoot).read(binding.userId);
    if (!current?.active || digest(current) !== digest(binding) || !user?.enabled || user.email !== binding.email) throw Error("HOST_BINDING_REVOKED");
    const task = await this.tasks(binding.userId).get(binding.taskId);
    if (task.state !== "active" || task.deletedAt || task.schedule.kind !== "external" || task.projectId !== binding.projectId || digest(task.audience) !== digest(binding.audience)) throw Error("HOST_BINDING_CHANGED");
    return task;
  }
  async submit(value: unknown) {
    const { deadlineAt, ...envelope } = parseHostEnvelope(value); const b = await this.binding(envelope.job);
    if (!b) throw Error("HOST_BINDING_REQUIRED"); await this.assertActive(b);
    const requestId = stableId(`${b.installationId}:${b.job}:${envelope.occurrence}`), name = `requests/${requestId}.json`;
    // Check capacity before taking the submission lock: never introduce a
    // store->model-queue lock ordering. Existing signed occurrences retain
    // their exact budget and terminal state, even when capacity later fills.
    if (!await this.read<HostSubmission>(name) &&
        !await new FileModelTurnQueue(path.join(this.installation.paths.dataRoot, "runtime", "model-turn-queue")).backgroundCapacityAvailable()) {
      throw new BackgroundModelAdmissionDeferred();
    }
    return this.locks.withLock(`submission:${requestId}`, async () => {
      const old = await this.read<HostSubmission>(name), inputDigest = digest(envelope);
      if (old && (old.inputDigest !== inputDigest || old.generation !== b.generation)) throw Error("HOST_OCCURRENCE_CONFLICT");
      if (!old && deadlineAt === undefined) throw Error("HOST_DEADLINE_REQUIRED");
      const request: HostSubmission = old ?? { schemaVersion: 2, requestId, generation: b.generation, taskId: b.taskId, userId: b.userId, inputDigest, envelope, cancelled: false, budget: createHostBudget(this.now(), deadlineAt) };
      if (request.cancelled) throw Error("HOST_OCCURRENCE_CANCELLED");
      await this.write(name, request);
      await this.tasks(b.userId).runNow(b.taskId, requestId);
      return { requestId, taskId: b.taskId };
    });
  }
  async request(binding: HostBinding, requestId: string) {
    if (!UUID.test(requestId)) throw Error("HOST_REQUEST_INVALID"); await this.assertActive(binding);
    const r = await this.read<HostSubmission>(`requests/${requestId}.json`);
    if (!r || ![1, 2].includes(r.schemaVersion) || r.generation !== binding.generation || r.taskId !== binding.taskId || r.userId !== binding.userId || r.inputDigest !== digest(r.envelope) || r.envelope.job !== binding.job || r.requestId !== requestId || requestId !== stableId(`${binding.installationId}:${binding.job}:${r.envelope.occurrence}`)) throw Error("HOST_REQUEST_DENIED");
    // Expose expiry only after signature, identity and input validation. It
    // remains terminal: cancelled requests never regain execution authority.
    if (r.cancelled) throw Error(r.cancellationReason === "HOST_QUEUE_TIMEOUT" ? "HOST_QUEUE_TIMEOUT" :
      r.cancellationReason === "HOST_TERMINAL_TIMEOUT" ? "HOST_TERMINAL_TIMEOUT" : "HOST_REQUEST_DENIED");
    return { ...r, envelope: parseHostEnvelope(r.envelope) };
  }
  async admit(binding: HostBinding, requestId: string) {
    return this.locks.withLock(`submission:${requestId}`, async () => {
      const r = await this.request(binding, requestId);
      if (r.schemaVersion !== 2) throw Error("HOST_BUDGET_MISSING");
      const budget = admitHostBudget(r.budget, this.now());
      if (budget !== r.budget) await this.write(`requests/${requestId}.json`, { ...r, budget });
      return { ...r, budget };
    });
  }
  async waitDeadline(job: HostAnalysisJob, requestId: string) {
    const b = await this.binding(job); if (!b) throw Error("HOST_BINDING_REQUIRED");
    return hostWaitDeadline((await this.request(b, requestId)).budget);
  }
  async expire(job: HostAnalysisJob, requestId: string) {
    const b = await this.binding(job); if (!b) throw Error("HOST_BINDING_REQUIRED");
    return this.locks.withLock(`submission:${requestId}`, async () => {
      const r = await this.request(b, requestId);
      const terminal = await this.tasks(b.userId).latestRun(`${b.taskId}:manual:${requestId}`);
      if (terminal?.status === "failed" || (terminal?.status === "succeeded" && (r.schemaVersion === 1 || r.terminalCommitted))) return false;
      if (this.now() < hostWaitDeadline(r.budget)) return false; // admission may have won the race
      await this.write(`requests/${requestId}.json`, { ...r, cancelled: true,
        cancellationReason: r.budget?.workUntil === undefined ? "HOST_QUEUE_TIMEOUT" : "HOST_TERMINAL_TIMEOUT" });
      return true;
    });
  }
  async cancel(job: HostAnalysisJob, requestId: string) {
    const b = await this.binding(job); if (!b) throw Error("HOST_BINDING_REQUIRED");
    await this.locks.withLock(`submission:${requestId}`, async () => {
      const r = await this.request(b, requestId);
      const terminal = await this.tasks(b.userId).latestRun(`${b.taskId}:manual:${requestId}`);
      if (terminal?.status === "failed" || (terminal?.status === "succeeded" && (r.schemaVersion === 1 || r.terminalCommitted))) return;
      await this.write(`requests/${requestId}.json`, { ...r, cancelled: true });
    });
  }
  async finalize(binding: HostBinding, requestId: string, persist: () => Promise<void>) {
    await this.locks.withLock(`submission:${requestId}`, async () => {
      const r = await this.request(binding, requestId);
      if (!r.budget?.workUntil) throw Error("HOST_BUDGET_MISSING");
      if (this.now() >= hostWaitDeadline(r.budget)) throw Error("HOST_TERMINAL_TIMEOUT");
      await persist(); // journal + task settlement are observed atomically by waiters/cancellers
      if (this.now() >= hostWaitDeadline(r.budget)) throw Error("HOST_TERMINAL_TIMEOUT");
      // A journal append can succeed before task settlement fails. Seal both
      // only after the whole callback commits; partial persistence cannot deliver.
      await this.write(`requests/${requestId}.json`, { ...r, terminalCommitted: true });
    });
  }
  async result(job: HostAnalysisJob, requestId: string) {
    return this.locks.withLock(`submission:${requestId}`, () => this.readResult(job, requestId));
  }
  private async readResult(job: HostAnalysisJob, requestId: string) {
    const b = await this.binding(job); if (!b) throw Error("HOST_BINDING_REQUIRED"); const request = await this.request(b, requestId);
    const runKey = `${b.taskId}:manual:${requestId}`;
    const run = await this.tasks(b.userId).latestRun(runKey);
    if (run?.status === "failed") throw Error("HOST_ANALYSIS_FAILED");
    if (run?.status !== "succeeded") return null;
    if (request.schemaVersion === 2 && !request.terminalCommitted) return null;
    if (request.budget && (!run.finishedAt || Date.parse(run.finishedAt) > request.budget.terminalUntil)) throw Error("HOST_TERMINAL_TIMEOUT");
    await getWritableProject(await provisionedAutomationPrincipal(this.installation, b.userId), b.projectId);
    validateAutomationAudience(b.audience, await automationWorkspaceContext(this.installation), b.userId);
    const result = await this.read<{ text: string; generation: string; threadId: string; permissionFingerprint: string }>(`results/${requestId}.json`);
    if (!result || result.generation !== b.generation || result.threadId !== run.threadId) throw Error("HOST_RESULT_INVALID");
    if ((await currentHostPermissions(this.installation, b, runKey)).fingerprint !== result.permissionFingerprint) throw Error("HOST_PERMISSIONS_CHANGED");
    await this.request(b, requestId);
    return { result: { payloads: [{ text: result.text }] }, meta: { runtime: "aibrain-codex", principal: b.email, projectId: b.projectId, threadId: result.threadId, originalDocumentsUploaded: request.envelope.documents.length }, external_action_executed: false };
  }
  async saveResult(b: HostBinding, requestId: string, threadId: string, text: string, permissionFingerprint: string) {
    const request = await this.request(b, requestId);
    if (!request.budget?.workUntil || this.now() >= request.budget.workUntil) throw Error("HOST_EXECUTION_TIMEOUT");
    if (!/^[a-f0-9]{64}$/.test(permissionFingerprint) || !text.trim() || Buffer.byteLength(text) > 2 * 1024 * 1024) throw Error("HOST_RESULT_INVALID");
    await this.locks.withLock(`result:${requestId}`, async () => {
      const old = await this.read<{ generation: string; threadId: string; text: string; permissionFingerprint: string }>(`results/${requestId}.json`);
      const value = { generation: b.generation, threadId, text, permissionFingerprint };
      if (old && digest(old) !== digest(value)) throw Error("HOST_RESULT_CONFLICT");
      await this.request(b, requestId);
      if (!old) await this.write(`results/${requestId}.json`, value);
    });
  }
}
