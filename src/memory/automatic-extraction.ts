import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import { FileMemoryProposalStore, type MemoryProposalContext } from "@/memory/proposal-store";
import type { MemoryKind } from "@/memory/types";
import {
  atomicWriteJson,
  defineVersionedSchema,
  expectArray,
  expectInteger,
  expectIsoDate,
  expectLiteral,
  expectOneOf,
  expectString,
  fsyncDirectory,
  recoverAtomicJsonFile,
  ResourceLockManager,
  type ValidationContext,
} from "@/storage";

const SECRET_OR_UNSAFE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk|ghp|gho|github_pat)_[A-Za-z0-9_-]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*|\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|contrase(?:n|ñ)a)\s*[:=]\s*\S{8,}|```|\b(?:ignore|ignora) (?:all |todas? )?(?:previous|anteriores?) (?:instructions|instrucciones)\b|\brm\s+-rf\b/iu;
const EPHEMERAL = /\b(?:hoy|mañana|esta semana|este mes|esta vez|en este turno|por ahora|de momento|today|tomorrow|this week|this month|just this time|for now|avui|demà|aquesta setmana|aquest mes|aquest cop|de moment)\b/iu;
const PREFERENCE = /\b(?:prefiero|preferimos|mi preferencia es|nuestra preferencia es|me gusta que|i prefer|we prefer|my preference is|our preference is|prefereixo|preferim|la meva preferència és)\b/iu;
const DECISION = /\b(?:he decidido|hemos decidido|decidimos|acordamos|la decisión es|i decided|we decided|the decision is|he decidit|hem decidit|la decisió és)\b/iu;
const STABLE_FACT = /\b(?:mi nombre es|me llamo|mi rol es|trabajo en|soy (?:el|la) |my name is|my role is|i work (?:at|for)|em dic|el meu rol és|treballo a|recordar? que|recuerda que|remember that|recorda que)\b/iu;
const PROJECT_CONTEXT = /\b(?:proyecto|projecte|project|cliente|client|campaña|campanya|campaign|repositorio|repositori|repository)\b/iu;

export type AutomaticMemoryCandidate = {
  kind: MemoryKind;
  content: string;
  scope: "private" | "project";
  semanticKey: string;
};

type AutomaticMemoryJob = {
  schemaVersion: 1;
  jobId: string;
  fingerprint: string;
  installationId: string;
  userId: string;
  projectId: string;
  threadId: string;
  turnId: string;
  candidates: AutomaticMemoryCandidate[];
  observedToolNames: string[];
  status: "pending";
  attempts: number;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTALLATION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function missing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function errorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code.replace(/[^A-Z0-9_:-]/gu, "_").slice(0, 120) || "MEMORY_JOB_FAILED";
  }
  return "MEMORY_JOB_FAILED";
}

function parseCandidate(value: unknown, context: ValidationContext): AutomaticMemoryCandidate {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["content", "kind", "scope", "semanticKey"].sort().join("\0")) {
    context.fail("expected exact automatic memory candidate");
  }
  return {
    kind: expectOneOf(value.kind, ["recollection", "decision"] as const, context.at("kind")),
    content: expectString(value.content, context.at("content"), { minLength: 12, maxLength: 800 }),
    scope: expectOneOf(value.scope, ["private", "project"] as const, context.at("scope")),
    semanticKey: expectString(value.semanticKey, context.at("semanticKey"), { minLength: 3, maxLength: 80, pattern: /^[a-z0-9-]+$/u }),
  };
}

const automaticMemoryJobSchema = defineVersionedSchema<AutomaticMemoryJob>({
  name: "AutomaticMemoryJob",
  schemaVersion: 1,
  keys: ["attempts", "candidates", "createdAt", "fingerprint", "installationId", "jobId", "lastErrorCode", "observedToolNames", "projectId", "status", "threadId", "turnId", "updatedAt", "userId"],
  parse(record, context) {
    return {
      schemaVersion: expectLiteral(record.schemaVersion, 1, context.at("schemaVersion")),
      jobId: expectString(record.jobId, context.at("jobId"), { pattern: SHA256 }),
      fingerprint: expectString(record.fingerprint, context.at("fingerprint"), { pattern: SHA256 }),
      installationId: expectString(record.installationId, context.at("installationId"), { pattern: INSTALLATION_ID }),
      userId: expectString(record.userId, context.at("userId"), { pattern: UUID }),
      projectId: expectString(record.projectId, context.at("projectId"), { pattern: UUID }),
      threadId: expectString(record.threadId, context.at("threadId"), { pattern: OPAQUE_ID }),
      turnId: expectString(record.turnId, context.at("turnId"), { pattern: OPAQUE_ID }),
      candidates: (() => {
        const candidates = expectArray(record.candidates, context.at("candidates"), parseCandidate, { maxLength: 6 });
        if (candidates.length === 0) context.at("candidates").fail("expected at least one item");
        return candidates;
      })(),
      observedToolNames: expectArray(record.observedToolNames, context.at("observedToolNames"), (value, itemContext) => expectString(value, itemContext, { pattern: TOOL_NAME }), { maxLength: 32 }),
      status: expectLiteral(record.status, "pending", context.at("status")),
      attempts: expectInteger(record.attempts, context.at("attempts"), { minimum: 0 }),
      lastErrorCode: record.lastErrorCode === null ? null : expectString(record.lastErrorCode, context.at("lastErrorCode"), { minLength: 1, maxLength: 120 }),
      createdAt: expectIsoDate(record.createdAt, context.at("createdAt")),
      updatedAt: expectIsoDate(record.updatedAt, context.at("updatedAt")),
    };
  },
});

function cleanSentence(value: string) {
  return value.replace(/^\s*(?:[-*•]|\d+[.)])\s*/u, "").replace(/\s+/gu, " ").trim();
}

function slug(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("es")
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80);
}

function semanticKey(sentence: string, kind: MemoryKind, match: RegExpMatchArray) {
  const tail = sentence.slice((match.index ?? 0) + match[0].length).replace(/^\s*(?:que|that|:|-)?\s*/iu, "");
  const tokens = tail.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("es").match(/[a-z0-9]+/gu) ?? [];
  const subject = tokens.slice(0, kind === "decision" ? 4 : 3).join("-");
  return slug(`${kind}-${subject || sentence.slice(0, 48)}`);
}

export function extractAutomaticMemoryCandidates(message: string): AutomaticMemoryCandidate[] {
  if (!message.trim() || message.length > 32_000) return [];
  const sentences = message.split(/(?:\r?\n)+|(?<=[.!?])\s+/u).map(cleanSentence);
  const candidates: AutomaticMemoryCandidate[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences) {
    if (sentence.length < 12 || sentence.length > 800 || SECRET_OR_UNSAFE.test(sentence) || EPHEMERAL.test(sentence)) continue;
    const decision = sentence.match(DECISION);
    const preference = sentence.match(PREFERENCE);
    const fact = sentence.match(STABLE_FACT);
    const match = decision ?? preference ?? fact;
    if (!match) continue;
    const kind: MemoryKind = decision ? "decision" : "recollection";
    const key = semanticKey(sentence, kind, match);
    if (key.length < 3 || seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      kind,
      content: sentence,
      scope: decision || PROJECT_CONTEXT.test(sentence) ? "project" : "private",
      semanticKey: key,
    });
    if (candidates.length === 6) break;
  }
  return candidates;
}

export async function runAutomaticMemoryExtraction(input: {
  config: Readonly<InstallationConfig>;
  context: MemoryProposalContext;
  threadId: string;
  turnId: string;
  message: string;
  observedToolNames?: readonly string[];
  store?: FileMemoryProposalStore;
}) {
  const candidates = extractAutomaticMemoryCandidates(input.message);
  if (candidates.length === 0) return [];
  const store = input.store ?? new FileMemoryProposalStore({ config: input.config });
  const outcomes = [];
  for (const candidate of candidates) {
    outcomes.push(await store.rememberAutomatically(input.context, {
      ...candidate,
      threadId: input.threadId,
      turnId: input.turnId,
      extractionId: `automatic:${candidate.semanticKey}:${input.turnId}`,
      toolNames: [...new Set(input.observedToolNames ?? [])].slice(0, 32),
      sourceExcerpt: candidate.content.slice(0, 4_000),
    }));
  }
  return outcomes;
}

async function automaticJobRoot(config: Readonly<InstallationConfig>, userId: string) {
  if (!UUID.test(userId)) throw new Error("AUTOMATIC_MEMORY_USER_INVALID");
  const usersRoot = path.resolve(config.paths.usersRoot);
  const userRoot = path.join(usersRoot, userId);
  const [usersMetadata, userMetadata] = await Promise.all([lstat(usersRoot), lstat(userRoot)]);
  if (!usersMetadata.isDirectory() || usersMetadata.isSymbolicLink() || !userMetadata.isDirectory() ||
      userMetadata.isSymbolicLink() || (userMetadata.mode & 0o077) !== 0 ||
      !inside(await realpath(usersRoot), await realpath(userRoot))) {
    throw new Error("AUTOMATIC_MEMORY_PATH_UNSAFE");
  }
  const root = path.join(userRoot, "memory", "automatic-jobs");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !inside(await realpath(userRoot), await realpath(root))) {
    throw new Error("AUTOMATIC_MEMORY_PATH_UNSAFE");
  }
  await chmod(root, 0o700);
  return root;
}

function automaticJobIdentity(input: {
  config: Readonly<InstallationConfig>;
  context: MemoryProposalContext;
  threadId: string;
  turnId: string;
  candidates: readonly AutomaticMemoryCandidate[];
  observedToolNames: readonly string[];
}) {
  const stable = {
    installationId: input.context.installationId,
    userId: input.context.userId,
    projectId: input.context.projectId,
    threadId: input.threadId,
    turnId: input.turnId,
    candidates: input.candidates.map((candidate) => ({ ...candidate })),
    observedToolNames: [...new Set(input.observedToolNames)].sort(),
  };
  const fingerprint = createHash("sha256").update(JSON.stringify(stable)).digest("hex");
  const jobId = createHash("sha256").update(JSON.stringify({
    installationId: input.config.installationId,
    userId: input.context.userId,
    projectId: input.context.projectId,
    threadId: input.threadId,
    turnId: input.turnId,
  })).digest("hex");
  return { stable, fingerprint, jobId };
}

export async function enqueueAutomaticMemoryExtraction(input: {
  config: Readonly<InstallationConfig>;
  context: MemoryProposalContext;
  threadId: string;
  turnId: string;
  message: string;
  observedToolNames?: readonly string[];
}) {
  const candidates = extractAutomaticMemoryCandidates(input.message);
  if (candidates.length === 0) return null;
  if (input.context.installationId !== input.config.installationId) throw new Error("AUTOMATIC_MEMORY_TENANT_MISMATCH");
  const root = await automaticJobRoot(input.config, input.context.userId);
  const identity = automaticJobIdentity({
    ...input,
    candidates,
    observedToolNames: input.observedToolNames ?? [],
  });
  const filePath = path.join(root, `${identity.jobId}.json`);
  const locks = new ResourceLockManager({ rootDirectory: path.join(input.config.paths.dataRoot, "locks", "automatic-memory-jobs") });
  await locks.withLock(`automatic-memory-job:${input.context.userId}:${identity.jobId}`, async () => {
    try {
      const existing = (await recoverAtomicJsonFile(filePath, automaticMemoryJobSchema)).value;
      if (existing.fingerprint !== identity.fingerprint) throw new Error("AUTOMATIC_MEMORY_JOB_REPLAY_CONFLICT");
      return;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const now = new Date().toISOString();
    await atomicWriteJson(filePath, {
      schemaVersion: 1,
      jobId: identity.jobId,
      fingerprint: identity.fingerprint,
      ...identity.stable,
      status: "pending",
      attempts: 0,
      lastErrorCode: null,
      createdAt: now,
      updatedAt: now,
    }, automaticMemoryJobSchema, { mode: 0o600 });
  });
  return { jobId: identity.jobId, userId: input.context.userId };
}

async function processAutomaticMemoryJob(input: {
  config: Readonly<InstallationConfig>;
  userId: string;
  jobId: string;
  store?: FileMemoryProposalStore;
  onStage?: (stage: "memory-written") => void | Promise<void>;
}) {
  const root = await automaticJobRoot(input.config, input.userId);
  const filePath = path.join(root, `${input.jobId}.json`);
  const locks = new ResourceLockManager({ rootDirectory: path.join(input.config.paths.dataRoot, "locks", "automatic-memory-jobs") });
  return locks.withLock(`automatic-memory-job:${input.userId}:${input.jobId}`, async () => {
    let job: AutomaticMemoryJob;
    try {
      job = (await recoverAtomicJsonFile(filePath, automaticMemoryJobSchema)).value;
    } catch (error) {
      if (missing(error)) return { status: "missing" as const, jobId: input.jobId };
      throw error;
    }
    if (job.installationId !== input.config.installationId || job.userId !== input.userId || job.jobId !== input.jobId) {
      throw new Error("AUTOMATIC_MEMORY_JOB_SCOPE_MISMATCH");
    }
    try {
      const store = input.store ?? new FileMemoryProposalStore({ config: input.config });
      for (const candidate of job.candidates) {
        await store.rememberAutomatically({
          installationId: job.installationId,
          userId: job.userId,
          projectId: job.projectId,
        }, {
          ...candidate,
          threadId: job.threadId,
          turnId: job.turnId,
          extractionId: `automatic:${candidate.semanticKey}:${job.turnId}`,
          toolNames: job.observedToolNames,
          sourceExcerpt: candidate.content.slice(0, 4_000),
        });
      }
      await input.onStage?.("memory-written");
      await unlink(filePath);
      await fsyncDirectory(root);
      return { status: "completed" as const, jobId: job.jobId };
    } catch (error) {
      const now = new Date().toISOString();
      await atomicWriteJson(filePath, {
        ...job,
        attempts: job.attempts + 1,
        lastErrorCode: errorCode(error),
        updatedAt: now,
      }, automaticMemoryJobSchema, { mode: 0o600 });
      return { status: "pending" as const, jobId: job.jobId, errorCode: errorCode(error) };
    }
  });
}

export async function drainAutomaticMemoryJobs(
  config: Readonly<InstallationConfig>,
  options: {
    userIds: readonly string[];
    limit?: number;
    store?: FileMemoryProposalStore;
    onStage?: (stage: "memory-written") => void | Promise<void>;
  },
) {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000));
  const jobs: Array<{ userId: string; jobId: string }> = [];
  for (const userId of [...new Set(options.userIds)].sort()) {
    const root = await automaticJobRoot(config, userId);
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/^([0-9a-f]{64})\.json$/u.test(entry.name)) continue;
      jobs.push({ userId, jobId: entry.name.slice(0, -5) });
      if (jobs.length >= limit) break;
    }
    if (jobs.length >= limit) break;
  }
  const results = [];
  for (const job of jobs) {
    results.push(await processAutomaticMemoryJob({ config, ...job, store: options.store, onStage: options.onStage }));
  }
  return results;
}

export function scheduleAutomaticMemoryJobProcessing(
  config: Readonly<InstallationConfig>,
  job: { jobId: string; userId: string },
  onError: (error: unknown) => void = () => undefined,
) {
  queueMicrotask(() => {
    void processAutomaticMemoryJob({ config, ...job }).catch(onError);
  });
}
