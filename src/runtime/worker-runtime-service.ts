import {
  AutomationMaintenanceGate,
  installationMaintenanceStatus,
  enterInstallationMaintenance,
  resumeInstallationMaintenance,
} from "@/operations/automation-maintenance";
import type { WorkerRoots } from "@/runtime/workers/types";
import { deriveWorkerRoots } from "@/runtime/workers/provisioner";
import { createHash, randomUUID } from "node:crypto";
import type { ClientRequest } from "../../contracts/codex/0.162.1/types/ClientRequest";
import type { InstallationConfig } from "@/config/installation-schema";
import { FileLocalUserStore } from "@/auth/local-user-store";
import { loadInstallationConfig } from "@/config/installation";
import {
  MaintenanceCoordinator,
  type EnterMaintenanceOptions,
  type MaintenanceActivityLease,
} from "@/operations/maintenance";
import {
  parseAccount,
  parseModels,
  parseRateLimit,
  parseSkills,
  parseUsage,
  type CodexConnection,
  type ResolvedSkill,
} from "@/runtime/codex-app-server";
import { AppServerRpcRouter, AppServerRpcResponseError } from "@/runtime/transport/app-server-rpc-router";
import { validateAppServerRequest } from "@/runtime/transport/wire-protocol";
import type { AppServerEvent, JsonValue } from "@/runtime/transport";
import { LocalGatewayWorkerRuntimeFactory, workerEgressEnvironment } from "@/runtime/workers/local-gateway-runtime";
import { DirectStdioWorkerRuntimeFactory } from "@/runtime/workers/direct-stdio-runtime";
import { sharedAuthProvider } from "@/runtime/workers/shared-auth-broker";
import { userAccessAuthProvider } from "@/runtime/personal-auth-provider";
import { privateCodexToolPermissionsRequired } from "@/runtime/quota-tool-permissions";
import { WorkerRuntimeRegistry } from "@/runtime/workers/registry";
import type { WorkerRuntimeHandle } from "@/runtime/workers/types";
import { operationalLogger } from "@/operations/server-logger";
import { installationOwnerAuthSocket, readInstallationOwnerAccess } from "@/runtime/installation-owner-auth";
import { createWeeklyTokenBudgetRuntime, type WeeklyTokenBudgetRuntime } from "@/usage/weekly-token-budget-runtime";
import { completeNativeConnectionOAuth } from "@/connectors/native-connection-lifecycle";

const CATALOG_FRESH_TTL_MS = 5 * 60_000;
const CATALOG_STALE_TTL_MS = 30 * 60_000;
const DISCONNECTED_ACCOUNT_RECHECK_COOLDOWN_MS = 5_000;
const PENDING_TURN_CANCELLATION_TTL_MS = 5 * 60_000;

/** This independent backend uses the official local protocol. The gateway is
 * an explicit compatibility choice, never a reconnect fallback for a turn. */
export function configuredWorkerTransport(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const value = environment.AIBRAIN_CODEX_TRANSPORT?.trim() || "stdio";
  if (value !== "stdio" && value !== "gateway") throw new Error("Worker transport configuration is invalid.");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Shared with service-state fixtures so identity changes cannot silently
 * construct an unrelated cached runtime in admission/recovery tests. */
export function installationFingerprint(config: Readonly<InstallationConfig>) {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: config.schemaVersion,
    installationId: config.installationId,
    usersRoot: config.paths.usersRoot,
    companyContextRoot: config.paths.companyContextRoot,
    sourceReadRoot: config.paths.sourceReadRoot,
    publishWriteRoot: config.paths.publishWriteRoot,
    usageLimits: config.usageLimits,
    transport: configuredWorkerTransport(),
  })).digest("hex");
}

function randomRequest(
  method: ClientRequest["method"],
  params: unknown,
  purpose: string,
) {
  return {
    method,
    id: `${purpose}:${randomUUID()}`,
    ...(params === undefined ? {} : { params }),
  } as ClientRequest;
}

function isAlreadyInitialized(error: unknown) {
  return error instanceof Error
    && error.message === "Already initialized"
    && "code" in error
    && error.code === -32600;
}

export class WorkerAppServerClient {
  readonly router: AppServerRpcRouter;
  private initialized: Promise<void> | null = null;
  private readonly loadedThreads = new Map<string, boolean>();
  private account: CodexConnection | null = null;
  private accountRefresh: Promise<CodexConnection> | null = null;
  private accountRecheckedAt: number | null = null;
  private cachedConnection: CodexConnection | null = null;
  private cachedConnectionCwd: string | null = null;
  private cachedAt = 0;
  private catalogRefresh: Promise<CodexConnection> | null = null;
  private catalogRefreshCwd: string | null = null;
  private readonly weeklyBudget: WeeklyTokenBudgetRuntime | null;

  constructor(
    readonly handle: WorkerRuntimeHandle,
    private readonly maintenance: MaintenanceCoordinator | null = null,
    installation: Readonly<InstallationConfig> | null = null,
  ) {
    this.weeklyBudget = createWeeklyTokenBudgetRuntime(
      installation,
      handle.userId,
      (threadId, turnId, requestId) => this.router.request({
        method: "turn/interrupt", id: requestId, params: { threadId, turnId },
      }, 5_000),
      () => operationalLogger.warn("usage.weekly_budget_runtime_failed", {
        installationId: handle.installationId, userId: handle.userId,
      }),
    );
    this.router = new AppServerRpcRouter(handle.transport, {
      onNotification: async (notification, event) => {
        if (notification.method === "mcpServer/oauthLogin/completed") completeNativeConnectionOAuth(
          { installationId: handle.installationId, userId: handle.userId }, notification.params,
        );
        await this.weeklyBudget?.observe(notification, event);
      },
      ...(this.weeklyBudget ? {
        onTurnBound: (threadId: string, turnId: string) => this.weeklyBudget!.bindTurn(threadId, turnId),
      } : {}),
      onRequestMetric: (metric) => operationalLogger.info("codex.app_server_request", {
        metricSchemaVersion: 1,
        installationId: handle.installationId,
        userId: handle.userId,
        ...metric,
        observedAt: new Date().toISOString(),
      }),
    });
  }

  async initialize() {
    if (this.router.failed) throw new Error("App Server transport is unavailable.");
    if (!this.initialized) {
      this.initialized = this.initializeOnce().catch((error) => {
        this.initialized = null;
        throw error;
      });
    }
    await this.initialized;
    if (this.router.failed) throw new Error("App Server transport is unavailable.");
  }

  async assertProjectionReady() {
    await this.initialize();
    await this.router.assertProjectionReady();
  }

  private async initializeOnce() {
    await this.router.start();
    let initializedHere = true;
    try {
      await this.router.request(randomRequest("initialize", {
        clientInfo: {
          name: "aibrain_workbench",
          title: "Asistente",
          version: "0.4.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      }, "initialize"), 30_000);
    } catch (error) {
      if (!isAlreadyInitialized(error)) throw error;
      initializedHere = false;
    }
    if (initializedHere) {
      await this.router.notify({ method: "initialized" }, `initialized:${randomUUID()}`);
    }
    if (installationOwnerAuthSocket(this.handle.installationId)) {
      // External access tokens stay in App Server memory. Refresh tokens remain
      // only in the host's canonical managed account, never employee homes.
      const access = await readInstallationOwnerAccess(this.handle.installationId);
      await this.router.request(randomRequest("account/login/start", {
        type: "chatgptAuthTokens", ...access,
      }, "owner-access-login"), 10_000);
    }
    // Readiness must not proactively rotate credentials. Codex owns normal
    // refresh during authenticated work; forcing it here can invalidate a
    // still-usable shared-QA session when its refresh token was already rotated.
    this.account = parseAccount(await this.router.request(randomRequest(
      "account/read",
      { refreshToken: false },
      "account-read",
    ), 10_000));
  }

  /** No initialize, login, catalog, restart or model dispatch is permitted here.
   * A cold/failed client is unknown, even if ordinary admission could repair it. */
  async requestExistingMetadata(method: ClientRequest["method"], params: unknown, purpose: string, timeoutMs = 5_000) {
    if (!["thread/read", "thread/turns/list"].includes(method) || this.account === null || this.router.failed ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(purpose)) throw new Error("Existing metadata client is unavailable.");
    return this.router.request({ method, id: purpose, params } as ClientRequest, timeoutMs);
  }

  async request(
    method: ClientRequest["method"],
    params: unknown,
    purpose: string,
    timeoutMs = 30_000,
    beforeResolve?: (value: JsonValue, event: AppServerEvent) => void | Promise<void>,
    activityLease?: MaintenanceActivityLease,
  ) {
    if (method === "turn/start") this.maintenance?.assertActiveLease(activityLease);
    await this.initialize();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(purpose)) {
      throw new Error("Stable App Server request id is invalid.");
    }
    if (method === "turn/start" || method === "turn/steer") {
      await this.weeklyBudget?.beforeRequest(method, params, purpose);
    }
    // Unsubscribe may reach App Server even if its response is lost. A later
    // turn must resume authoritatively rather than trust a stale loaded cache.
    if (method === "thread/unsubscribe" && isRecord(params) && typeof params.threadId === "string") {
      this.loadedThreads.delete(params.threadId);
    }
    const result = await this.router.request(
      { method, id: purpose, ...(params === undefined ? {} : { params }) } as ClientRequest,
      timeoutMs,
      async (value, event) => {
        if (method === "turn/start" || method === "turn/steer") {
          this.weeklyBudget?.accepted(method, params, value, purpose);
        }
        await beforeResolve?.(value, event);
      },
    );
    if ((method === "thread/start" || method === "thread/resume") &&
        isRecord(result) && isRecord(result.thread) && typeof result.thread.id === "string" &&
        isRecord(params) && isRecord(params.config)) {
      this.loadedThreads.set(result.thread.id, params.config.web_search === "live");
    }
    return result;
  }

  /**
   * Read the original creation receipt through this user's worker boundary.
   * Missing/evicted evidence stays unknown: it never authorizes another send.
   */
  async recoverThreadStart(params: unknown, purpose: string): Promise<JsonValue | null> {
    if (!/^thread-start:[A-Za-z0-9._:-]{1,115}$/.test(purpose)) {
      throw new Error("Stable thread creation request id is invalid.");
    }
    const request = {
      clientRequestId: purpose,
      kind: "rpc-request" as const,
      rpc: { method: "thread/start" as const, id: purpose, params },
    };
    validateAppServerRequest(request);
    await this.initialize();
    const response = await this.handle.transport.recoverResponse?.(request);
    if (!response) return null;
    if (response.id !== purpose) throw new Error("Recovered thread creation identity changed.");
    if ("error" in response) throw new AppServerRpcResponseError("thread/start", response.id, response.error);
    return response.result;
  }

  /**
   * A loaded thread can accept `turn/start` directly. The cache belongs to
   * this client/transport, so replacing or restarting App Server naturally
   * makes every persisted thread require one fresh `thread/resume`.
   */
  canReuseLoadedThread(threadId: string, webSearchEnabled: boolean) {
    return this.loadedThreads.get(threadId) === webSearchEnabled;
  }

  async connection(cwd: string, forceRefresh = false): Promise<CodexConnection> {
    await this.initialize();
    if (!this.account) throw new Error("Codex did not return account state.");
    const cachedForCwd = this.cachedConnection && this.cachedConnectionCwd === cwd
      ? this.cachedConnection
      : null;
    const cacheAge = Date.now() - this.cachedAt;
    if (!forceRefresh && cachedForCwd && cacheAge < CATALOG_FRESH_TTL_MS) {
      return cachedForCwd;
    }
    if (!forceRefresh && cachedForCwd && cacheAge < CATALOG_STALE_TTL_MS) {
      void this.refreshConnection(cwd).catch(() => undefined);
      return cachedForCwd;
    }
    return this.refreshConnection(cwd);
  }

  /**
   * Starts loading the optional catalog without delaying the caller. Runtime
   * status uses this after the worker account has been verified so the first
   * real turn normally finds a warm model and skill catalog.
   */
  prewarmConnection(cwd: string) {
    void this.connection(cwd).catch(() => undefined);
  }

  private refreshConnection(cwd: string): Promise<CodexConnection> {
    if (this.catalogRefresh) {
      if (this.catalogRefreshCwd === cwd) return this.catalogRefresh;
      return this.catalogRefresh.then(() => this.refreshConnection(cwd));
    }
    this.catalogRefreshCwd = cwd;
    this.catalogRefresh = this.loadConnection(cwd).finally(() => {
      this.catalogRefresh = null;
      this.catalogRefreshCwd = null;
    });
    return this.catalogRefresh;
  }

  private async loadConnection(cwd: string): Promise<CodexConnection> {
    if (!this.account) throw new Error("Codex did not return account state.");
    const [modelsResult, skillsResult, capabilitiesResult, rateLimitResult, usageResult] = await Promise.all([
      this.router.request(randomRequest("model/list", { limit: 30, includeHidden: false }, "models"), 10_000).catch(() => null),
      this.router.request(randomRequest("skills/list", { cwds: [cwd], forceReload: false }, "skills"), 10_000).catch(() => null),
      this.router.request(randomRequest("modelProvider/capabilities/read", {}, "capabilities"), 10_000).catch(() => null),
      this.router.request(randomRequest("account/rateLimits/read", undefined, "rate-limits"), 10_000).catch(() => null),
      this.router.request(randomRequest("account/usage/read", undefined, "usage"), 10_000).catch(() => null),
    ]);
    this.cachedConnection = {
      ...this.account,
      processWarm: true,
      models: parseModels(modelsResult),
      skills: parseSkills(skillsResult).map(({ path: _path, ...skill }) => skill),
      webSearch: isRecord(capabilitiesResult) && capabilitiesResult.webSearch === true,
      imageGeneration: isRecord(capabilitiesResult) && capabilitiesResult.imageGeneration === true,
      rateLimit: parseRateLimit(rateLimitResult),
      usage: parseUsage(usageResult),
    };
    this.cachedConnectionCwd = cwd;
    this.cachedAt = Date.now();
    return this.cachedConnection;
  }

  /**
   * Returns the verified account state without waiting for the optional model,
   * skill, usage, and capability catalog. This keeps the readiness endpoint
   * bounded during a cold worker start; those details are loaded on demand by
   * `connection()` when a turn needs them.
   */
  async connectionSummary(): Promise<CodexConnection> {
    await this.initialize();
    if (!this.account) throw new Error("Codex did not return account state.");
    // Codex can transiently report a null account while a freshly provisioned
    // worker is opening an otherwise valid, private ChatGPT session. Do not
    // pin that result for the lifetime of the worker: a legitimate provider
    // reconnect may replace its private auth file later. Coalesce callers and
    // apply a cooldown after each attempt, including failed reads. Readiness
    // never rotates credentials, and a disconnected account stays fail-closed.
    if (!this.account.connected) {
      if (!this.accountRefresh && (this.accountRecheckedAt === null
          || Date.now() - this.accountRecheckedAt >= DISCONNECTED_ACCOUNT_RECHECK_COOLDOWN_MS)) {
        this.accountRecheckedAt = Date.now();
        this.accountRefresh = this.router.request(randomRequest(
          "account/read",
          { refreshToken: false },
          "account-recheck",
        ), 10_000).then((result) => {
          const account = parseAccount(result);
          if (account.connected && !this.account?.connected) {
            // Catalog snapshots include account state. A fresh catalog cached
            // before reconnect must not keep the next turn disconnected.
            this.cachedConnection = null;
            this.cachedConnectionCwd = null;
            this.cachedAt = 0;
          }
          this.account = account;
          return account;
        }).finally(() => {
          this.accountRecheckedAt = Date.now();
          this.accountRefresh = null;
        });
      }
      // A concurrent summary must await the in-flight read instead of leaking the
      // transient disconnected snapshot.
      if (this.accountRefresh) await this.accountRefresh;
    }
    return {
      ...this.account,
      processWarm: true,
    };
  }

  /**
   * Reads only the capability flags that control whether the composer can
   * offer a live tool.  Keeping this separate from `connection()` lets the
   * readiness route report the actual web-search availability without waiting
   * for the optional model, skill, rate-limit, and usage catalogs.
   */
  async capabilities(): Promise<Pick<CodexConnection, "webSearch" | "imageGeneration">> {
    await this.initialize();
    const result = await this.router.request(randomRequest(
      "modelProvider/capabilities/read",
      {},
      "capabilities",
    ), 10_000).catch(() => null);
    return {
      webSearch: isRecord(result) && result.webSearch === true,
      imageGeneration: isRecord(result) && result.imageGeneration === true,
    };
  }

  async resolvedSkills(cwd: string): Promise<ResolvedSkill[]> {
    await this.initialize();
    return parseSkills(await this.router.request(randomRequest(
      "skills/list",
      { cwds: [cwd], forceReload: false },
      "resolved-skills",
    ), 10_000));
  }

  close() {
    this.weeklyBudget?.close();
    return this.router.close();
  }
}

type RuntimeServiceState = {
  fingerprint: string;
  config: Readonly<InstallationConfig>;
  registry: WorkerRuntimeRegistry;
  maintenance: MaintenanceCoordinator;
  clients: Map<string, WorkerAppServerClient>;
  clientAdmissions: Map<string, Promise<{ handle: WorkerRuntimeHandle; client: WorkerAppServerClient }>>;
  // Lazy fields preserve compatibility with a service surviving hot reload.
  admissionGenerations?: Map<string, number>;
  userStops?: Map<string, Promise<boolean>>;
  activeTurnCancellations: Map<string, {
    runtimeThreadId: string;
    cancelAfterRemoteInterrupt(remoteInterruptConfirmed: boolean): void;
  }>;
};

const runtimeGlobal = globalThis as typeof globalThis & {
  __aibrainWorkerRuntimeService?: RuntimeServiceState;
  __aibrainWorkerRuntimeServicePromise?: Promise<RuntimeServiceState>;
  __aibrainPendingWorkerTurnCancellations?: Map<string, number>;
};

function pendingTurnCancellations() {
  const pending = runtimeGlobal.__aibrainPendingWorkerTurnCancellations ??= new Map<string, number>();
  const expiredBefore = Date.now() - PENDING_TURN_CANCELLATION_TTL_MS;
  for (const [key, requestedAt] of pending) {
    if (requestedAt < expiredBefore) pending.delete(key);
  }
  return pending;
}

async function serviceState(): Promise<RuntimeServiceState> {
  const config = await loadInstallationConfig();
  const fingerprint = installationFingerprint(config);
  const existing = runtimeGlobal.__aibrainWorkerRuntimeService;
  if (existing?.fingerprint === fingerprint) return existing;
  const inFlight = runtimeGlobal.__aibrainWorkerRuntimeServicePromise;
  if (inFlight) {
    const initialized = await inFlight;
    return initialized.fingerprint === fingerprint ? initialized : serviceState();
  }
  const initialize = (async () => {
    const replaced = runtimeGlobal.__aibrainWorkerRuntimeService;
    if (replaced) {
      const cleanup = await Promise.allSettled([
        ...[...replaced.clients.values()].map((client) => client.close()),
        replaced.registry.close(),
      ]);
      // Keep the old registry reachable when process cleanup fails. Publishing
      // a replacement would bypass its per-user ownership/restart fence.
      const failure = cleanup.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    }
    const maintenance = new MaintenanceCoordinator();
    const state: RuntimeServiceState = {
      fingerprint,
      config,
      registry: new WorkerRuntimeRegistry({
        config,
        factory: new (configuredWorkerTransport() === "stdio" ? DirectStdioWorkerRuntimeFactory : LocalGatewayWorkerRuntimeFactory)({
          quotaToolPrivacy: privateCodexToolPermissionsRequired(config),
          sharedAuth: sharedAuthProvider(config, process.env.AIBRAIN_CODEX_AUTH_SCOPE === "shared-qa" ? workerEgressEnvironment() : {}),
          authForContext: userAccessAuthProvider,
        }),
        maintenance,
        onLifecycleMetric: (metric) => operationalLogger.info("codex.worker_lifecycle", {
          metricSchemaVersion: 1,
          installationId: config.installationId,
          ...metric,
        }),
      }),
      maintenance,
      clients: new Map(),
      clientAdmissions: new Map(),
      activeTurnCancellations: new Map(),
    };
    runtimeGlobal.__aibrainWorkerRuntimeService = state;
    return state;
  })();
  runtimeGlobal.__aibrainWorkerRuntimeServicePromise = initialize;
  try {
    return await initialize;
  } finally {
    if (runtimeGlobal.__aibrainWorkerRuntimeServicePromise === initialize) {
      delete runtimeGlobal.__aibrainWorkerRuntimeServicePromise;
    }
  }
}

export async function workerAppServerForUser(
  userId: string,
  activityLease?: MaintenanceActivityLease,
  beforeInitialize?: (context: { config: Readonly<InstallationConfig>; roots: WorkerRoots }) => Promise<void>,
) {
  const state = await serviceState();
  const generation = state.admissionGenerations?.get(userId) ?? 0;
  const localUser = await new FileLocalUserStore(state.config.paths.usersRoot).read(userId);
  assertAdmissionGeneration(state, userId, generation);
  if (!localUser?.enabled) {
    throw new Error("Worker user is not provisioned or is disabled.");
  }
  if (activityLease) state.maintenance.assertActiveLease(activityLease);
  // Persist the caller's exact no-dispatch intent before startup/authentication
  // can fail. This runs for every caller, including a shared/warm admission.
  // It must complete under the caller's own turn lease before any worker start.
  await beforeInitialize?.({ config: state.config, roots: deriveWorkerRoots(state.config, userId) });
  assertAdmissionGeneration(state, userId, generation);
  if (activityLease) state.maintenance.assertActiveLease(activityLease);
  // This is sampled before `start()`: it distinguishes an already-running
  // employee process from a cold start without exposing a worker identifier.
  const workerWasWarm = state.registry.get(userId) !== null;
  // Share only startup/recovery, never turn execution. Concurrent callers of
  // a failed initialize must not each stop the successor's healthy worker.
  let admission = state.clientAdmissions.get(userId);
  if (!admission) {
    admission = initializeWorkerClient(state, userId, generation, activityLease);
    state.clientAdmissions.set(userId, admission);
    void admission.finally(() => {
      if (state.clientAdmissions.get(userId) === admission) state.clientAdmissions.delete(userId);
    }).catch(() => undefined);
  }
  const { handle, client } = await admission;
  assertAdmissionGeneration(state, userId, generation);
  if (activityLease) state.maintenance.assertActiveLease(activityLease);
  return { config: state.config, registry: state.registry, handle, client, workerWasWarm };
}

/** A queue observer may borrow an already-ready client, never its startup or
 * recovery path: those can stop/restart a worker with unrelated live work. */
export async function workerExistingMetadataRequest(userId: string, method: ClientRequest["method"], params: unknown,
  purpose: string, timeoutMs = 5_000): Promise<JsonValue> {
  const state = runtimeGlobal.__aibrainWorkerRuntimeService;
  if (!state || !["thread/read", "thread/turns/list"].includes(method)) throw new Error("Existing metadata client is unavailable.");
  const generation = state.admissionGenerations?.get(userId) ?? 0;
  assertAdmissionGeneration(state, userId, generation);
  const client = state.clients.get(userId);
  const handle = state.registry.get(userId);
  if (!client || !handle || client.handle.transport !== handle.transport) throw new Error("Existing metadata client is unavailable.");
  const localUser = await new FileLocalUserStore(state.config.paths.usersRoot).read(userId);
  assertAdmissionGeneration(state, userId, generation);
  if (!localUser?.enabled || runtimeGlobal.__aibrainWorkerRuntimeService !== state ||
      state.clients.get(userId) !== client || state.registry.get(userId)?.transport !== handle.transport) {
    throw new Error("Existing metadata client is unavailable.");
  }
  return client.requestExistingMetadata(method, params, purpose, timeoutMs);
}

function assertAdmissionGeneration(state: RuntimeServiceState, userId: string, generation: number) {
  if (state.userStops?.has(userId) || (state.admissionGenerations?.get(userId) ?? 0) !== generation) {
    throw new Error("Worker admission was cancelled by user runtime stop.");
  }
}

async function initializeWorkerClient(
  state: RuntimeServiceState,
  userId: string,
  generation: number,
  activityLease?: MaintenanceActivityLease,
) {
  let handle: WorkerRuntimeHandle;
  const assertCurrent = () => assertAdmissionGeneration(state, userId, generation);
  assertCurrent();
  try {
    handle = await state.registry.start(userId, activityLease);
  } catch {
    assertCurrent();
    operationalLogger.warn("codex.worker_recovery", {
      metricSchemaVersion: 1,
      installationId: state.config.installationId,
      userId,
      phase: "worker_start",
      outcome: "retrying_once",
      observedAt: new Date().toISOString(),
    });
    // A failed gateway connection has already been stopped by the registry.
    // One clean retry recovers transient process and socket startup races.
    handle = await state.registry.start(userId, activityLease);
  }
  assertCurrent();
  let client = state.clients.get(userId);
  if (!client || client.handle.transport !== handle.transport) {
    if (client) await client.close();
    assertCurrent();
    client = new WorkerAppServerClient(handle, state.maintenance, state.config);
    state.clients.set(userId, client);
  }
  try {
    await client.initialize();
  } catch {
    assertCurrent();
    operationalLogger.warn("codex.worker_recovery", {
      metricSchemaVersion: 1,
      installationId: state.config.installationId,
      userId,
      phase: "app_server_initialize",
      outcome: "restarting_once",
      observedAt: new Date().toISOString(),
    });
    await client.close().catch(() => undefined);
    state.clients.delete(userId);
    await state.registry.stop(userId);
    assertCurrent();
    handle = await state.registry.start(userId, activityLease);
    assertCurrent();
    client = new WorkerAppServerClient(handle, state.maintenance, state.config);
    state.clients.set(userId, client);
    try {
      await client.initialize();
    } catch (retryError) {
      state.clients.delete(userId);
      await client.close().catch(() => undefined);
      await state.registry.stop(userId).catch(() => undefined);
      operationalLogger.error("codex.worker_recovery", {
        metricSchemaVersion: 1,
        installationId: state.config.installationId,
        userId,
        phase: "app_server_initialize",
        outcome: "unavailable",
        observedAt: new Date().toISOString(),
      });
      throw retryError;
    }
  }
  assertCurrent();
  return { handle, client };
}

export async function acquireWorkerTurnActivity() {
  const state = await serviceState();
  return state.maintenance.acquire("turn");
}

function automationMaintenanceGate(state: RuntimeServiceState) {
  return new AutomationMaintenanceGate({
    installationId: state.config.installationId,
    usersRoot: state.config.paths.usersRoot,
  });
}

export async function workerMaintenanceStatus() {
  const state = await serviceState();
  return installationMaintenanceStatus(state.maintenance, automationMaintenanceGate(state));
}

export async function enterWorkerMaintenance(options: EnterMaintenanceOptions) {
  const state = await serviceState();
  return enterInstallationMaintenance(state.maintenance, automationMaintenanceGate(state), options);
}

export async function resumeWorkerMaintenance() {
  const state = await serviceState();
  return resumeInstallationMaintenance(state.maintenance, automationMaintenanceGate(state));
}

export async function workerRuntimeHealth(userId: string) {
  const state = await serviceState();
  return state.registry.health(userId);
}

/** Stops only the selected employee runtime and releases its active stream handlers. */
export async function stopWorkerRuntimeForUser(userId: string) {
  const state = runtimeGlobal.__aibrainWorkerRuntimeService;
  if (!state) return false;
  const stops = state.userStops ??= new Map();
  const existing = stops.get(userId);
  if (existing) return existing;
  const generations = state.admissionGenerations ??= new Map();
  generations.set(userId, (generations.get(userId) ?? 0) + 1);
  const stopping = stopUserRuntime(state, userId).finally(() => {
    if (stops.get(userId) === stopping) stops.delete(userId);
  });
  stops.set(userId, stopping);
  return stopping;
}

async function stopUserRuntime(state: RuntimeServiceState, userId: string) {
  const client = state.clients.get(userId);
  if (client) {
    await client.close().catch(() => undefined);
    state.clients.delete(userId);
  }
  // Invalidated admissions may still own a registry start/initialize. Drain
  // them before the final stop; they may not retry or install a new client.
  await state.clientAdmissions.get(userId)?.catch(() => undefined);
  for (const [key, registration] of state.activeTurnCancellations) {
    if (!key.startsWith(`${userId}:`)) continue;
    registration.cancelAfterRemoteInterrupt(true);
    state.activeTurnCancellations.delete(key);
  }
  for (const key of pendingTurnCancellations().keys()) {
    if (key.startsWith(`${userId}:`)) pendingTurnCancellations().delete(key);
  }
  return state.registry.stop(userId);
}

export function workerTurnIsActive(
  userId: string,
  runtimeThreadId: string,
  localTurnId: string,
) {
  const state = runtimeGlobal.__aibrainWorkerRuntimeService;
  const client = state?.clients.get(userId);
  return client?.router.hasActiveTurn(runtimeThreadId, localTurnId) ?? false;
}

function activeTurnKey(userId: string, localTurnId: string) {
  return `${userId}:${localTurnId}`;
}

export function registerWorkerTurnCancellation(
  userId: string,
  runtimeThreadId: string,
  localTurnId: string,
  cancelAfterRemoteInterrupt: (remoteInterruptConfirmed: boolean) => void,
) {
  const state = runtimeGlobal.__aibrainWorkerRuntimeService;
  if (!state || !state.clients.has(userId) || !runtimeThreadId || !localTurnId) {
    throw new Error("Worker turn cancellation scope is unavailable.");
  }
  const key = activeTurnKey(userId, localTurnId);
  if (state.activeTurnCancellations.has(key)) {
    throw new Error("Worker turn cancellation scope is already registered.");
  }
  const registration = { runtimeThreadId, cancelAfterRemoteInterrupt };
  state.activeTurnCancellations.set(key, registration);
  if (pendingTurnCancellations().delete(key)) {
    cancelAfterRemoteInterrupt(false);
  }
  return () => {
    if (state.activeTurnCancellations.get(key) === registration) {
      state.activeTurnCancellations.delete(key);
    }
  };
}

export function cancelWorkerTurnLocally(
  userId: string,
  runtimeThreadId: string,
  localTurnId: string,
  remoteInterruptConfirmed = true,
) {
  const state = runtimeGlobal.__aibrainWorkerRuntimeService;
  const registration = state?.activeTurnCancellations.get(activeTurnKey(userId, localTurnId));
  if (!registration || registration.runtimeThreadId !== runtimeThreadId) return false;
  registration.cancelAfterRemoteInterrupt(remoteInterruptConfirmed);
  return true;
}

export function requestPendingWorkerTurnCancellation(
  userId: string,
  localTurnId: string,
) {
  const state = runtimeGlobal.__aibrainWorkerRuntimeService;
  if (!localTurnId) return false;
  const key = activeTurnKey(userId, localTurnId);
  const registration = state?.activeTurnCancellations.get(key);
  if (registration) {
    registration.cancelAfterRemoteInterrupt(false);
    return true;
  }
  pendingTurnCancellations().set(key, Date.now());
  return true;
}
