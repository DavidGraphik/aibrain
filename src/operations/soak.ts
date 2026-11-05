import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { InstallationConfig } from "@/config/installation-schema";
import type { OperationalLogger } from "@/operations/logging";
import type { AppServerEvent, AppServerRequest } from "@/runtime/transport";
import { LocalGatewayWorkerRuntimeFactory } from "@/runtime/workers/local-gateway-runtime";
import { WorkerRuntimeRegistry } from "@/runtime/workers/registry";
import type { WorkerRuntimeHandle } from "@/runtime/workers/types";

const MEBIBYTE = 1024 * 1024;
const DEFAULT_DURATION_MS = 120_000;
const MIN_SLOPE_WINDOW_MS = 90_000;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_CONCURRENCY = 100;
const MAX_LATENCY_SAMPLES = 4_096;
const SOAK_INSTALLATION_ID = "operations-soak-qa";
const FIXTURE_APP_SERVER = String.raw`
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  try {
    const request = JSON.parse(line);
    if (request && (typeof request.id === "string" || typeof request.id === "number")) {
      process.stdout.write(JSON.stringify({ id: request.id, result: { data: [], nextCursor: null } }) + "\n");
    }
  } catch {
    process.exitCode = 65;
  }
});
process.on("SIGTERM", () => process.exit(0));
`;

export type SoakThresholds = Readonly<{
  maxRssGrowthBytes: number;
  maxHeapGrowthBytes: number;
  maxExternalGrowthBytes: number;
  maxRssSlopeBytesPerMinute: number;
  maxHeapSlopeBytesPerMinute: number;
  maxExternalSlopeBytesPerMinute: number;
  maxActiveHandleLeak: number;
  maxActiveResourceLeak: number;
  maxResourceTypeLeak: number;
  maxSocketLeak: number;
  maxListenerLeak: number;
  maxChildProcessLeak: number;
  maxProcessListenerLeak: number;
  maxHandleListenerLeak: number;
  maxJournalBytesPerEvent: number;
  maxJournalBytesPerWorker: number;
  maxJournalRecordsPerWorker: number;
  maxJournalFilesPerWorker: number;
}>;

export type SoakOptions = Readonly<{
  workRoot: string;
  durationMs?: number;
  maxCycles?: number;
  concurrency?: number;
  restartEveryCycles?: number;
  sampleIntervalMs?: number;
  cycleDelayMs?: number;
  requestTimeoutMs?: number;
  thresholds?: Partial<SoakThresholds>;
  logger?: OperationalLogger;
  now?: () => number;
}>;

export type ResourceCounts = Readonly<{
  activeHandles: number;
  sockets: number;
  listeners: number;
  childProcesses: number;
  processListeners: number;
  handleListeners: number;
  activeResources: number;
  resourcesByType: Readonly<Record<string, number>>;
}>;

export type JournalCounts = Readonly<{
  files: number;
  bytes: number;
  records: number;
}>;

export type SoakResourceSample = Readonly<{
  sampledAt: string;
  elapsedMs: number;
  cpu: Readonly<{
    userMicros: number;
    systemMicros: number;
  }>;
  io: Readonly<{
    fsRead: number;
    fsWrite: number;
  }>;
  memory: Readonly<{
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
  }>;
  resources: ResourceCounts;
  journals: JournalCounts;
}>;

export type LatencySummary = Readonly<{
  count: number;
  sampled: number;
  minMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}>;

export type SoakFailure = Readonly<{
  code: string;
  actual: number;
  limit: number;
  resource?: string;
}>;

export type SoakReport = Readonly<{
  schemaVersion: 1;
  status: "pass" | "fail";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  configuration: Readonly<{
    concurrency: number;
    targetDurationMs: number;
    maxCycles: number | null;
    restartEveryCycles: number;
    sampleIntervalMs: number;
    cycleDelayMs: number;
  }>;
  workload: Readonly<{
    cycles: number;
    requests: number;
    streamedEvents: number;
    replayedEvents: number;
    correlatedEvents: number;
    restarts: number;
    requestsPerSecond: number;
  }>;
  latency: LatencySummary;
  thresholds: SoakThresholds;
  samples: Readonly<{
    beforeStart: SoakResourceSample;
    steadyStart: SoakResourceSample;
    peak: SoakResourceSample;
    beforeClose: SoakResourceSample;
    afterClose: SoakResourceSample;
    count: number;
  }>;
  growth: Readonly<{
    steadyRssBytes: number;
    steadyHeapUsedBytes: number;
    steadyExternalBytes: number;
    rssSlopeBytesPerMinute: number;
    heapSlopeBytesPerMinute: number;
    externalSlopeBytesPerMinute: number;
    leakedActiveHandles: number;
    leakedActiveResources: number;
    leakedResourcesByType: Readonly<Record<string, number>>;
    leakedSockets: number;
    leakedListeners: number;
    leakedChildProcesses: number;
    leakedProcessListeners: number;
    leakedHandleListeners: number;
    journalBytesPerEvent: number;
    journalBytesPerWorker: number;
    journalRecordsPerWorker: number;
    journalFilesPerWorker: number;
  }>;
  failures: readonly SoakFailure[];
}>;

type ActiveHandleProcess = NodeJS.Process & {
  _getActiveHandles?: () => readonly unknown[];
};

class BoundedLatencySamples {
  private readonly samples: number[] = [];
  private count = 0;
  private total = 0;
  private minimum = Number.POSITIVE_INFINITY;
  private maximum = 0;

  add(value: number) {
    if (!Number.isFinite(value) || value < 0) return;
    this.count += 1;
    this.total += value;
    this.minimum = Math.min(this.minimum, value);
    this.maximum = Math.max(this.maximum, value);
    if (this.samples.length < MAX_LATENCY_SAMPLES) this.samples.push(value);
    else this.samples[this.count % MAX_LATENCY_SAMPLES] = value;
  }

  summary(): LatencySummary {
    const sorted = [...this.samples].sort((left, right) => left - right);
    const percentile = (ratio: number) => sorted.length === 0
      ? 0
      : sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
    return Object.freeze({
      count: this.count,
      sampled: sorted.length,
      minMs: this.count === 0 ? 0 : round(this.minimum),
      meanMs: this.count === 0 ? 0 : round(this.total / this.count),
      p50Ms: round(percentile(0.5)),
      p95Ms: round(percentile(0.95)),
      maxMs: round(this.maximum),
    });
  }
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function integerOption(name: string, value: number, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function thresholdOption(name: string, value: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative.`);
  return value;
}

function configuredThresholds(overrides: Partial<SoakThresholds> = {}): SoakThresholds {
  const values: SoakThresholds = {
    maxRssGrowthBytes: overrides.maxRssGrowthBytes ?? 128 * MEBIBYTE,
    maxHeapGrowthBytes: overrides.maxHeapGrowthBytes ?? 64 * MEBIBYTE,
    maxExternalGrowthBytes: overrides.maxExternalGrowthBytes ?? 32 * MEBIBYTE,
    maxRssSlopeBytesPerMinute: overrides.maxRssSlopeBytesPerMinute ?? 32 * MEBIBYTE,
    maxHeapSlopeBytesPerMinute: overrides.maxHeapSlopeBytesPerMinute ?? 16 * MEBIBYTE,
    maxExternalSlopeBytesPerMinute: overrides.maxExternalSlopeBytesPerMinute ?? 8 * MEBIBYTE,
    maxActiveHandleLeak: overrides.maxActiveHandleLeak ?? 0,
    maxActiveResourceLeak: overrides.maxActiveResourceLeak ?? 0,
    maxResourceTypeLeak: overrides.maxResourceTypeLeak ?? 0,
    maxSocketLeak: overrides.maxSocketLeak ?? 0,
    maxListenerLeak: overrides.maxListenerLeak ?? 0,
    maxChildProcessLeak: overrides.maxChildProcessLeak ?? 0,
    maxProcessListenerLeak: overrides.maxProcessListenerLeak ?? 0,
    maxHandleListenerLeak: overrides.maxHandleListenerLeak ?? 0,
    maxJournalBytesPerEvent: overrides.maxJournalBytesPerEvent ?? 16 * 1024,
    maxJournalBytesPerWorker: overrides.maxJournalBytesPerWorker ?? 8 * MEBIBYTE,
    maxJournalRecordsPerWorker: overrides.maxJournalRecordsPerWorker ?? 1_024,
    maxJournalFilesPerWorker: overrides.maxJournalFilesPerWorker ?? 3,
  };
  for (const [name, value] of Object.entries(values)) thresholdOption(name, value);
  return Object.freeze(values);
}

function userId(index: number) {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

async function ensureWorkRoot(workRoot: string) {
  if (!path.isAbsolute(workRoot)) throw new Error("Soak workRoot must be absolute.");
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const metadata = await lstat(workRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Soak workRoot must be a real directory.");
  }
  const runRoot = path.join(workRoot, `run-${randomUUID()}`);
  await mkdir(runRoot, { mode: 0o700 });
  return runRoot;
}

async function createInstallation(runRoot: string): Promise<Readonly<InstallationConfig>> {
  const dataRoot = path.join(runRoot, "data");
  const companyContextRoot = path.join(dataRoot, "company");
  const usersRoot = path.join(dataRoot, "users");
  const backupsRoot = path.join(dataRoot, "backups");
  const sourceReadRoot = path.join(runRoot, "source-ro");
  const publishWriteRoot = path.join(runRoot, "publish-rw");
  await Promise.all([
    mkdir(companyContextRoot, { recursive: true, mode: 0o700 }),
    mkdir(usersRoot, { recursive: true, mode: 0o700 }),
    mkdir(backupsRoot, { recursive: true, mode: 0o700 }),
    mkdir(sourceReadRoot, { recursive: true, mode: 0o500 }),
    mkdir(publishWriteRoot, { recursive: true, mode: 0o700 }),
  ]);
  return Object.freeze({
    schemaVersion: 1,
    installationId: SOAK_INSTALLATION_ID,
    companyName: "Operations Soak QA",
    companySlug: "operations-soak-qa",
    publicUrl: "http://localhost:3000",
    branding: Object.freeze({
      productName: "Operations Soak QA",
      logoPath: "/branding/operations-soak-qa/logo.svg",
      faviconPath: "/branding/operations-soak-qa/favicon.svg",
      accentColor: "#112233",
    }),
    paths: Object.freeze({
      dataRoot,
      companyContextRoot,
      usersRoot,
      sourceReadRoot,
      publishWriteRoot,
      backupsRoot,
    }),
  });
}

function handleType(value: unknown) {
  if (!value || typeof value !== "object") return "unknown";
  return (value as { constructor?: { name?: string } }).constructor?.name ?? "unknown";
}

function collectResourceCounts(): ResourceCounts {
  const handles = (process as ActiveHandleProcess)._getActiveHandles?.() ?? [];
  const handleTypes = handles.map(handleType);
  const resources = typeof process.getActiveResourcesInfo === "function"
    ? process.getActiveResourcesInfo()
    : [];
  const resourcesByType: Record<string, number> = {};
  for (const type of resources) resourcesByType[type] = (resourcesByType[type] ?? 0) + 1;
  const processListeners = process.eventNames()
    .reduce((count, name) => count + process.listenerCount(name), 0);
  const handleListeners = handles.reduce<number>((count, handle) => {
    if (!handle || typeof handle !== "object" || !("eventNames" in handle) || !("listenerCount" in handle)) return count;
    const emitter = handle as {
      eventNames(): Array<string | symbol>;
      listenerCount(eventName: string | symbol): number;
    };
    return count + emitter.eventNames().reduce(
      (listeners, eventName) => listeners + emitter.listenerCount(eventName),
      0,
    );
  }, 0);
  return Object.freeze({
    activeHandles: handles.length,
    sockets: handleTypes.filter((name) => name === "Socket" || name === "TLSSocket").length,
    listeners: handleTypes.filter((name) => name === "Server").length,
    childProcesses: handleTypes.filter((name) => name === "ChildProcess").length,
    processListeners,
    handleListeners,
    activeResources: resources.length,
    resourcesByType: Object.freeze(Object.fromEntries(Object.entries(resourcesByType).sort())),
  });
}

async function countNewlines(filePath: string) {
  let records = 0;
  for await (const chunk of createReadStream(filePath)) {
    for (const byte of chunk as Buffer) if (byte === 0x0a) records += 1;
  }
  return records;
}

async function collectJournalCounts(root: string): Promise<JournalCounts> {
  let files = 0;
  let bytes = 0;
  let records = 0;
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      // Runtime lock directories are intentionally short lived. A directory
      // enumerated by the sampler may disappear before it is traversed.
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      const item = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Soak state contains an unexpected symbolic link.");
      if (entry.isDirectory()) await visit(item);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        let metadata;
        try {
          metadata = await stat(item);
        } catch (error) {
          if (isNodeError(error, "ENOENT")) continue;
          throw error;
        }
        files += 1;
        bytes += metadata.size;
        try {
          records += await countNewlines(item);
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
        }
      }
    }
  };
  await visit(root);
  return Object.freeze({ files, bytes, records });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error
    && (error as NodeJS.ErrnoException).code === code);
}

async function sampleResources(runRoot: string, startedAt: number, now: () => number): Promise<SoakResourceSample> {
  const memory = process.memoryUsage();
  const usage = process.resourceUsage();
  return Object.freeze({
    sampledAt: new Date(now()).toISOString(),
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    cpu: Object.freeze({
      userMicros: usage.userCPUTime,
      systemMicros: usage.systemCPUTime,
    }),
    io: Object.freeze({
      fsRead: usage.fsRead,
      fsWrite: usage.fsWrite,
    }),
    memory: Object.freeze({
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    }),
    resources: collectResourceCounts(),
    journals: await collectJournalCounts(runRoot),
  });
}

function peakSample(samples: readonly SoakResourceSample[]) {
  const resourcesByType: Record<string, number> = {};
  for (const sample of samples) {
    for (const [name, count] of Object.entries(sample.resources.resourcesByType)) {
      resourcesByType[name] = Math.max(resourcesByType[name] ?? 0, count);
    }
  }
  const last = samples.at(-1);
  if (!last) throw new Error("Soak requires at least one resource sample.");
  const maximum = (select: (sample: SoakResourceSample) => number) => Math.max(...samples.map(select));
  return Object.freeze({
    sampledAt: last.sampledAt,
    elapsedMs: maximum((sample) => sample.elapsedMs),
    cpu: Object.freeze({
      userMicros: maximum((sample) => sample.cpu.userMicros),
      systemMicros: maximum((sample) => sample.cpu.systemMicros),
    }),
    io: Object.freeze({
      fsRead: maximum((sample) => sample.io.fsRead),
      fsWrite: maximum((sample) => sample.io.fsWrite),
    }),
    memory: Object.freeze({
      rssBytes: maximum((sample) => sample.memory.rssBytes),
      heapUsedBytes: maximum((sample) => sample.memory.heapUsedBytes),
      heapTotalBytes: maximum((sample) => sample.memory.heapTotalBytes),
      externalBytes: maximum((sample) => sample.memory.externalBytes),
      arrayBuffersBytes: maximum((sample) => sample.memory.arrayBuffersBytes),
    }),
    resources: Object.freeze({
      activeHandles: maximum((sample) => sample.resources.activeHandles),
      sockets: maximum((sample) => sample.resources.sockets),
      listeners: maximum((sample) => sample.resources.listeners),
      childProcesses: maximum((sample) => sample.resources.childProcesses),
      processListeners: maximum((sample) => sample.resources.processListeners),
      handleListeners: maximum((sample) => sample.resources.handleListeners),
      activeResources: maximum((sample) => sample.resources.activeResources),
      resourcesByType: Object.freeze(Object.fromEntries(Object.entries(resourcesByType).sort())),
    }),
    journals: Object.freeze({
      files: maximum((sample) => sample.journals.files),
      bytes: maximum((sample) => sample.journals.bytes),
      records: maximum((sample) => sample.journals.records),
    }),
  });
}

function delay(milliseconds: number) {
  return milliseconds === 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function threadListRequest(clientRequestId: string): AppServerRequest {
  return {
    clientRequestId,
    kind: "rpc-request",
    rpc: {
      method: "thread/list",
      id: clientRequestId,
      params: { cursor: null, limit: 1, sortKey: null },
    },
  };
}

async function nextEvent(handle: WorkerRuntimeHandle, timeoutMs: number) {
  const result = await withTimeout(
    handle.transport.events()[Symbol.asyncIterator]().next(),
    timeoutMs,
    "Timed out waiting for a streamed worker event.",
  );
  if (result.done) throw new Error("Worker event stream ended unexpectedly.");
  return result.value;
}

async function requestAndReceive(
  handle: WorkerRuntimeHandle,
  request: AppServerRequest,
  timeoutMs: number,
  acknowledge: boolean,
) {
  const startedAt = performance.now();
  const pendingEvent = nextEvent(handle, timeoutMs);
  await withTimeout(handle.transport.send(request), timeoutMs, "Timed out sending a worker request.");
  const event = await pendingEvent;
  if (event.message.kind !== "rpc-response" || event.message.rpc.id !== request.clientRequestId) {
    const received = event.message.kind === "rpc-response" ? String(event.message.rpc.id) : event.message.kind;
    throw new Error(`Worker streamed event ${received} while waiting for ${request.clientRequestId}.`);
  }
  if (acknowledge) await handle.transport.acknowledge?.(event);
  return { event, latencyMs: performance.now() - startedAt };
}

async function replayAndAcknowledge(handle: WorkerRuntimeHandle, timeoutMs: number): Promise<AppServerEvent> {
  const event = await nextEvent(handle, timeoutMs);
  await handle.transport.acknowledge?.(event);
  return event;
}

function positiveGrowth(current: number, baseline: number) {
  return Math.max(0, current - baseline);
}

function positiveSlopePerMinute(
  samples: readonly SoakResourceSample[],
  select: (sample: SoakResourceSample) => number,
) {
  if (samples.length < 4) return 0;
  const firstElapsed = samples[0].elapsedMs;
  const elapsed = samples.map((sample) => sample.elapsedMs - firstElapsed);
  // V8 heap sizing and JIT warmup dominate short samples. Absolute growth is
  // still gated for every run; a temporal leak slope is only meaningful once
  // the steady workload has covered at least ninety seconds.
  if ((elapsed.at(-1) ?? 0) < MIN_SLOPE_WINDOW_MS) return 0;
  const values = samples.map(select);
  const meanElapsed = elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length;
  const meanValue = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const centeredElapsed = elapsed[index] - meanElapsed;
    numerator += centeredElapsed * (values[index] - meanValue);
    denominator += centeredElapsed ** 2;
  }
  if (denominator === 0) return 0;
  return round(Math.max(0, numerator / denominator) * 60_000);
}

function resourceTypeGrowth(current: ResourceCounts, baseline: ResourceCounts) {
  const growth: Record<string, number> = {};
  for (const [resource, count] of Object.entries(current.resourcesByType)) {
    const leaked = positiveGrowth(count, baseline.resourcesByType[resource] ?? 0);
    if (leaked > 0) growth[resource] = leaked;
  }
  return Object.freeze(Object.fromEntries(Object.entries(growth).sort()));
}

function addFailure(
  failures: SoakFailure[],
  code: string,
  actual: number,
  limit: number,
  resource?: string,
) {
  if (actual > limit) failures.push(Object.freeze({ code, actual, limit, ...(resource ? { resource } : {}) }));
}

export async function runWorkerReplaySoak(options: SoakOptions): Promise<SoakReport> {
  const now = options.now ?? Date.now;
  const durationMs = integerOption("durationMs", options.durationMs ?? DEFAULT_DURATION_MS, 1, MAX_DURATION_MS);
  const maxCycles = options.maxCycles === undefined
    ? null
    : integerOption("maxCycles", options.maxCycles, 1, Number.MAX_SAFE_INTEGER);
  const concurrency = integerOption("concurrency", options.concurrency ?? 4, 1, MAX_CONCURRENCY);
  const restartEveryCycles = integerOption(
    "restartEveryCycles",
    options.restartEveryCycles ?? 20,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const sampleIntervalMs = integerOption("sampleIntervalMs", options.sampleIntervalMs ?? 1_000, 10, 60_000);
  const cycleDelayMs = integerOption("cycleDelayMs", options.cycleDelayMs ?? 25, 0, 60_000);
  const requestTimeoutMs = integerOption("requestTimeoutMs", options.requestTimeoutMs ?? 10_000, 100, 120_000);
  const thresholds = configuredThresholds(options.thresholds);
  const runRoot = await ensureWorkRoot(options.workRoot);
  const config = await createInstallation(runRoot);
  const startedWallClock = now();
  const startedAt = performance.now();
  const samples: SoakResourceSample[] = [];
  const beforeStart = await sampleResources(runRoot, startedAt, now);
  samples.push(beforeStart);
  const latencies = new BoundedLatencySamples();
  const factory = new LocalGatewayWorkerRuntimeFactory({
    maxRetainedCompletedRequests: 64,
    maxRetainedDeliveredEvents: 64,
    processFactory(context) {
      return spawn(process.execPath, ["-e", FIXTURE_APP_SERVER], {
        cwd: context.workspace,
        env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV ?? "test", ...context.environment },
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
  });
  const registry = new WorkerRuntimeRegistry({
    config,
    factory,
    maxConcurrentStarts: Math.min(concurrency, 8),
    maxPendingStarts: concurrency,
  });
  const ids = Array.from({ length: concurrency }, (_, index) => userId(index));
  const handles = new Map<string, WorkerRuntimeHandle>();
  const lastRequests = new Map<string, AppServerRequest>();
  let cycles = 0;
  let requests = 0;
  let streamedEvents = 0;
  let replayedEvents = 0;
  let correlatedEvents = 0;
  let restarts = 0;
  let steadyStart: SoakResourceSample | null = null;
  let beforeClose: SoakResourceSample | null = null;
  let nextSampleAt = sampleIntervalMs;
  options.logger?.info("soak.started", { concurrency, durationMs, maxCycles });

  try {
    const startedHandles = await Promise.all(ids.map((id) => registry.start(id)));
    for (let index = 0; index < ids.length; index += 1) handles.set(ids[index], startedHandles[index]);
    steadyStart = await sampleResources(runRoot, startedAt, now);
    samples.push(steadyStart);

    while (performance.now() - startedAt < durationMs && (maxCycles === null || cycles < maxCycles)) {
      cycles += 1;
      const shouldRestart = cycles % restartEveryCycles === 0;
      await Promise.all(ids.map(async (id, index) => {
        const handle = handles.get(id);
        if (!handle) throw new Error("Soak worker handle is missing.");
        const request = threadListRequest(`soak-${index}-${cycles}`);
        const result = await requestAndReceive(handle, request, requestTimeoutMs, !shouldRestart);
        latencies.add(result.latencyMs);
        requests += 1;
        streamedEvents += 1;
        correlatedEvents += 1;
        lastRequests.set(id, request);
      }));

      if (shouldRestart) {
        await Promise.all(ids.map(async (id) => {
          await registry.stop(id);
          const restarted = await registry.start(id);
          handles.set(id, restarted);
          const duplicate = lastRequests.get(id);
          if (!duplicate) throw new Error("Soak idempotency request is missing.");
          const replayed = await replayAndAcknowledge(restarted, requestTimeoutMs);
          if (replayed.message.kind !== "rpc-response" || replayed.message.rpc.id !== duplicate.clientRequestId) {
            throw new Error(`Worker replay crossed a cycle or user boundary for ${duplicate.clientRequestId}.`);
          }
          replayedEvents += 1;
          correlatedEvents += 1;
          restarts += 1;

          const result = await requestAndReceive(restarted, duplicate, requestTimeoutMs, true);
          latencies.add(result.latencyMs);
          requests += 1;
          streamedEvents += 1;
          correlatedEvents += 1;
        }));
      }

      const elapsed = performance.now() - startedAt;
      if (elapsed >= nextSampleAt) {
        samples.push(await sampleResources(runRoot, startedAt, now));
        nextSampleAt += sampleIntervalMs;
      }
      await delay(cycleDelayMs);
    }
    beforeClose = await sampleResources(runRoot, startedAt, now);
    samples.push(beforeClose);
  } finally {
    await registry.close();
  }

  await delay(50);
  const afterClose = await sampleResources(runRoot, startedAt, now);
  samples.push(afterClose);
  if (!steadyStart || !beforeClose) throw new Error("Soak did not reach a steady workload state.");

  const duration = Math.max(1, Math.round(performance.now() - startedAt));
  const steadySamples = samples.filter((sample) =>
    sample.elapsedMs >= steadyStart.elapsedMs && sample.elapsedMs <= beforeClose.elapsedMs);
  const leakedResourcesByType = resourceTypeGrowth(afterClose.resources, beforeStart.resources);
  const growth = Object.freeze({
    steadyRssBytes: positiveGrowth(beforeClose.memory.rssBytes, steadyStart.memory.rssBytes),
    steadyHeapUsedBytes: positiveGrowth(beforeClose.memory.heapUsedBytes, steadyStart.memory.heapUsedBytes),
    steadyExternalBytes: positiveGrowth(beforeClose.memory.externalBytes, steadyStart.memory.externalBytes),
    rssSlopeBytesPerMinute: positiveSlopePerMinute(steadySamples, (sample) => sample.memory.rssBytes),
    heapSlopeBytesPerMinute: positiveSlopePerMinute(steadySamples, (sample) => sample.memory.heapUsedBytes),
    externalSlopeBytesPerMinute: positiveSlopePerMinute(steadySamples, (sample) => sample.memory.externalBytes),
    leakedActiveHandles: positiveGrowth(afterClose.resources.activeHandles, beforeStart.resources.activeHandles),
    leakedActiveResources: positiveGrowth(afterClose.resources.activeResources, beforeStart.resources.activeResources),
    leakedResourcesByType,
    leakedSockets: positiveGrowth(afterClose.resources.sockets, beforeStart.resources.sockets),
    leakedListeners: positiveGrowth(afterClose.resources.listeners, beforeStart.resources.listeners),
    leakedChildProcesses: positiveGrowth(afterClose.resources.childProcesses, beforeStart.resources.childProcesses),
    leakedProcessListeners: positiveGrowth(afterClose.resources.processListeners, beforeStart.resources.processListeners),
    leakedHandleListeners: positiveGrowth(afterClose.resources.handleListeners, beforeStart.resources.handleListeners),
    journalBytesPerEvent: streamedEvents === 0 ? 0 : round(afterClose.journals.bytes / streamedEvents),
    journalBytesPerWorker: round(afterClose.journals.bytes / concurrency),
    journalRecordsPerWorker: round(afterClose.journals.records / concurrency),
    journalFilesPerWorker: round(afterClose.journals.files / concurrency),
  });
  const failures: SoakFailure[] = [];
  addFailure(failures, "RSS_GROWTH_EXCEEDED", growth.steadyRssBytes, thresholds.maxRssGrowthBytes);
  addFailure(failures, "HEAP_GROWTH_EXCEEDED", growth.steadyHeapUsedBytes, thresholds.maxHeapGrowthBytes);
  addFailure(failures, "EXTERNAL_GROWTH_EXCEEDED", growth.steadyExternalBytes, thresholds.maxExternalGrowthBytes);
  addFailure(failures, "RSS_SLOPE_EXCEEDED", growth.rssSlopeBytesPerMinute, thresholds.maxRssSlopeBytesPerMinute);
  addFailure(failures, "HEAP_SLOPE_EXCEEDED", growth.heapSlopeBytesPerMinute, thresholds.maxHeapSlopeBytesPerMinute);
  addFailure(failures, "EXTERNAL_SLOPE_EXCEEDED", growth.externalSlopeBytesPerMinute, thresholds.maxExternalSlopeBytesPerMinute);
  addFailure(failures, "ACTIVE_HANDLE_LEAK", growth.leakedActiveHandles, thresholds.maxActiveHandleLeak);
  addFailure(failures, "ACTIVE_RESOURCE_LEAK", growth.leakedActiveResources, thresholds.maxActiveResourceLeak);
  for (const [resource, leaked] of Object.entries(growth.leakedResourcesByType)) {
    addFailure(failures, "RESOURCE_TYPE_LEAK", leaked, thresholds.maxResourceTypeLeak, resource);
  }
  addFailure(failures, "SOCKET_LEAK", growth.leakedSockets, thresholds.maxSocketLeak);
  addFailure(failures, "LISTENER_LEAK", growth.leakedListeners, thresholds.maxListenerLeak);
  addFailure(failures, "CHILD_PROCESS_LEAK", growth.leakedChildProcesses, thresholds.maxChildProcessLeak);
  addFailure(failures, "PROCESS_LISTENER_LEAK", growth.leakedProcessListeners, thresholds.maxProcessListenerLeak);
  addFailure(failures, "HANDLE_LISTENER_LEAK", growth.leakedHandleListeners, thresholds.maxHandleListenerLeak);
  addFailure(failures, "JOURNAL_GROWTH_EXCEEDED", growth.journalBytesPerEvent, thresholds.maxJournalBytesPerEvent);
  addFailure(failures, "JOURNAL_BYTES_EXCEEDED", growth.journalBytesPerWorker, thresholds.maxJournalBytesPerWorker);
  addFailure(failures, "JOURNAL_RECORDS_EXCEEDED", growth.journalRecordsPerWorker, thresholds.maxJournalRecordsPerWorker);
  addFailure(failures, "JOURNAL_FILE_LEAK", growth.journalFilesPerWorker, thresholds.maxJournalFilesPerWorker);

  const report: SoakReport = Object.freeze({
    schemaVersion: 1,
    status: failures.length === 0 ? "pass" : "fail",
    startedAt: new Date(startedWallClock).toISOString(),
    completedAt: new Date(now()).toISOString(),
    durationMs: duration,
    configuration: Object.freeze({
      concurrency,
      targetDurationMs: durationMs,
      maxCycles,
      restartEveryCycles,
      sampleIntervalMs,
      cycleDelayMs,
    }),
    workload: Object.freeze({
      cycles,
      requests,
      streamedEvents,
      replayedEvents,
      correlatedEvents,
      restarts,
      requestsPerSecond: round(requests / (duration / 1_000)),
    }),
    latency: latencies.summary(),
    thresholds,
    samples: Object.freeze({
      beforeStart,
      steadyStart,
      peak: peakSample(samples),
      beforeClose,
      afterClose,
      count: samples.length,
    }),
    growth,
    failures: Object.freeze(failures),
  });
  options.logger?.[report.status === "pass" ? "info" : "error"]("soak.completed", {
    status: report.status,
    durationMs: report.durationMs,
    requests: report.workload.requests,
    failures: report.failures,
  });
  return report;
}
