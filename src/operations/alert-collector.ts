import { statfs } from "node:fs/promises";
import type { BackupVerificationReceipt } from "@/operations/backup";
import type { BackupReplicaReceipt } from "@/operations/backup-replica";
import type { OperationalAlertInput } from "@/operations/alerts";

export type OperationalAlertCollectorOptions = {
  dataRoot: string;
  publishWriteRoot: string;
  readinessUrl: string;
  egressReadinessUrl?: string;
  egressReadinessToken?: string;
  restartCount15m: number;
  preflightFailureCount15m: number;
  readBackupReceipt: () => Promise<BackupVerificationReceipt | null>;
  readReplicaReceipt?: () => Promise<BackupReplicaReceipt | null>;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
  allowComposeServiceReadiness?: boolean;
  readFilesystemCapacity?: (root: string) => Promise<{
    bavail: bigint;
    bsize: bigint;
    blocks: bigint;
  }>;
};

function count(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

export async function collectOperationalAlertInput(
  options: OperationalAlertCollectorOptions,
): Promise<OperationalAlertInput> {
  const readinessUrl = new URL(options.readinessUrl);
  const approvedHostname = readinessUrl.hostname === "127.0.0.1"
    || readinessUrl.hostname === "localhost"
    || (options.allowComposeServiceReadiness === true && readinessUrl.hostname === "app");
  if (readinessUrl.protocol !== "http:"
    || !approvedHostname
    || readinessUrl.username || readinessUrl.password || readinessUrl.hash
    || readinessUrl.pathname !== "/api/health/ready" || readinessUrl.search) {
    throw new Error("readinessUrl must be the exact loopback readiness endpoint.");
  }
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
    throw new Error("timeoutMs is invalid.");
  }
  const restartCount15m = count("restartCount15m", options.restartCount15m);
  const preflightFailureCount15m = count("preflightFailureCount15m", options.preflightFailureCount15m);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const egressReadinessUrl = options.egressReadinessUrl
    ? new URL(options.egressReadinessUrl)
    : null;
  if (egressReadinessUrl && (
    egressReadinessUrl.protocol !== "http:"
    || egressReadinessUrl.username || egressReadinessUrl.password
    || egressReadinessUrl.hash || egressReadinessUrl.search
    || egressReadinessUrl.pathname !== "/__aibrain_egress_health"
    || !(
      egressReadinessUrl.hostname === "127.0.0.1"
      || egressReadinessUrl.hostname === "localhost"
      || (options.allowComposeServiceReadiness === true && egressReadinessUrl.hostname === "egress-gateway")
    )
  )) {
    throw new Error("egressReadinessUrl must be the exact approved egress health endpoint.");
  }
  const egressReadinessToken = options.egressReadinessToken?.trim() || null;
  const composeEgressProbe = egressReadinessUrl?.hostname === "egress-gateway";
  if (composeEgressProbe && (
    !egressReadinessToken
    || Buffer.byteLength(egressReadinessToken, "utf8") < 32
    || Buffer.byteLength(egressReadinessToken, "utf8") > 512
    || /[\u0000-\u0020\u007f]/u.test(egressReadinessToken)
  )) {
    throw new Error("egressReadinessToken is required for the Compose egress health endpoint.");
  }
  const readFilesystemCapacity = options.readFilesystemCapacity
    ?? (async (root: string) => statfs(root, { bigint: true }));
  const [capacity, publishCapacity, backupReceipt, replicaReceipt, readiness, egressGateway] = await Promise.all([
    readFilesystemCapacity(options.dataRoot),
    readFilesystemCapacity(options.publishWriteRoot),
    options.readBackupReceipt(),
    options.readReplicaReceipt?.() ?? Promise.resolve(null),
    fetchImplementation(readinessUrl, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    }).then((response) => response.ok ? "ready" as const : "degraded" as const)
      .catch(() => "degraded" as const),
    egressReadinessUrl
      ? fetchImplementation(egressReadinessUrl, {
          cache: "no-store",
          redirect: "error",
          headers: composeEgressProbe
            ? { Authorization: `Bearer ${egressReadinessToken}` }
            : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        }).then((response) => response.ok ? "ready" as const : "degraded" as const)
        .catch(() => "degraded" as const)
      : Promise.resolve("degraded" as const),
  ]);
  const total = capacity.blocks * capacity.bsize;
  const available = capacity.bavail * capacity.bsize;
  const diskUsedRatio = total === 0n ? null : Number(total - available) / Number(total);
  const publishTotal = publishCapacity.blocks * publishCapacity.bsize;
  const publishAvailable = publishCapacity.bavail * publishCapacity.bsize;
  const publishDiskUsedRatio = publishTotal === 0n
    ? null
    : Number(publishTotal - publishAvailable) / Number(publishTotal);
  return {
    readiness,
    egressGateway,
    diskUsedRatio,
    publishDiskUsedRatio,
    restartCount15m,
    preflightFailureCount15m,
    backupReceipt,
    replicaReceipt,
  };
}
