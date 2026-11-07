import type { AppServerTransport, TransportHealth } from "@/runtime/transport";

export const WORKER_PROVISIONING_SCHEMA_VERSION = 1 as const;

export type WorkerRoots = {
  userRoot: string;
  runtimeRoot: string;
  codexHome: string;
  home: string;
  xdgRoot: string;
  xdgCache: string;
  xdgConfig: string;
  xdgData: string;
  xdgState: string;
  workspace: string;
  staging: string;
  stagingTemp: string;
  artifacts: string;
  browserRoot: string;
  browserProfile: string;
  browserDownloads: string;
  auditRoot: string;
  transportAudit: string;
  manifest: string;
};

export type WorkerProvisioningManifest = {
  schemaVersion: typeof WORKER_PROVISIONING_SCHEMA_VERSION;
  installationId: string;
  userId: string;
  workerId: string;
  provisionedAt: string;
  roots: WorkerRoots;
};

export type WorkerMountPlan = {
  runtimeReadOnly: readonly string[];
  runtimeReadWrite: readonly string[];
  browserReadWrite: readonly string[];
};

export type WorkerEnvironment = Readonly<{
  HOME: string;
  CODEX_HOME: string;
  XDG_CACHE_HOME: string;
  XDG_CONFIG_HOME: string;
  XDG_DATA_HOME: string;
  XDG_STATE_HOME: string;
  TMPDIR: string;
}>;

/** Contains only paths a worker/browser service is allowed to receive. */
export type WorkerLaunchContext = Readonly<{
  installationId: string;
  userId: string;
  workerId: string;
  environment: WorkerEnvironment;
  mounts: WorkerMountPlan;
  workspace: string;
  staging: string;
  artifacts: string;
  transportAudit: string;
  browser: Readonly<{
    profile: string;
    downloads: string;
  }>;
}>;

export type WorkerControllerHealth = {
  healthy: boolean;
  state: "starting" | "running" | "degraded" | "stopping" | "stopped" | "failed";
  detail?: string;
};

export interface ManagedWorkerRuntime {
  readonly transport: AppServerTransport;
  start(): Promise<void>;
  health(): Promise<WorkerControllerHealth>;
  /** Completion fences in-progress startup from creating later processes or transports.
   * A registry deadline is not cancellation; stop owns that cancellation.
   * Reject if cleanup cannot be proved so the registry retains ownership.
   */
  stop(): Promise<void>;
}

export interface WorkerRuntimeFactory {
  create(context: WorkerLaunchContext): ManagedWorkerRuntime | Promise<ManagedWorkerRuntime>;
}

export type WorkerRegistryState =
  | "absent"
  | "starting"
  | "running"
  | "degraded"
  | "stopping"
  | "stopped"
  | "failed";

export type WorkerRuntimeHealth = {
  installationId: string;
  userId: string;
  workerId: string | null;
  state: WorkerRegistryState;
  healthy: boolean;
  controller: WorkerControllerHealth | null;
  transport: TransportHealth | null;
  lastError: string | null;
};

export type WorkerRuntimeHandle = Readonly<{
  installationId: string;
  userId: string;
  workerId: string;
  roots: WorkerRoots;
  transport: AppServerTransport;
}>;
