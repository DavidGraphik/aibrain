import type { BackupVerificationReceipt } from "@/operations/backup";
import type { BackupReplicaReceipt } from "@/operations/backup-replica";

export type OperationalAlertSeverity = "warning" | "critical";
export type OperationalAlertCode =
  | "READINESS_DEGRADED"
  | "EGRESS_GATEWAY_DEGRADED"
  | "DISK_PRESSURE"
  | "PUBLISH_DISK_PRESSURE"
  | "RESTART_LOOP"
  | "BACKUP_UNVERIFIED"
  | "BACKUP_STALE"
  | "REPLICA_UNVERIFIED"
  | "REPLICA_STALE"
  | "PREFLIGHT_FAILURE";

export type OperationalAlert = Readonly<{
  code: OperationalAlertCode;
  severity: OperationalAlertSeverity;
  value: number | null;
  threshold: number | null;
}>;

export type OperationalAlertEvaluation = Readonly<{
  schemaVersion: 1;
  status: "healthy" | "warning" | "critical";
  evaluatedAt: string;
  alerts: readonly OperationalAlert[];
}>;

export type OperationalAlertInput = Readonly<{
  readiness: "ready" | "degraded";
  egressGateway: "ready" | "degraded";
  diskUsedRatio: number | null;
  publishDiskUsedRatio: number | null;
  restartCount15m: number;
  preflightFailureCount15m: number;
  backupReceipt: BackupVerificationReceipt | null;
  replicaReceipt: BackupReplicaReceipt | null;
}>;

export type OperationalAlertOptions = Readonly<{
  now?: () => number;
  diskWarningRatio?: number;
  diskCriticalRatio?: number;
  restartCriticalCount?: number;
  maximumBackupAgeMs?: number;
}>;

function ratio(name: string, value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1.`);
  return value;
}

function count(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

export function evaluateOperationalAlerts(
  input: OperationalAlertInput,
  options: OperationalAlertOptions = {},
): OperationalAlertEvaluation {
  const now = options.now ?? Date.now;
  const diskWarningRatio = ratio("diskWarningRatio", options.diskWarningRatio ?? 0.8);
  const diskCriticalRatio = ratio("diskCriticalRatio", options.diskCriticalRatio ?? 0.9);
  if (diskCriticalRatio <= diskWarningRatio) throw new Error("diskCriticalRatio must exceed diskWarningRatio.");
  const restartCriticalCount = count("restartCriticalCount", options.restartCriticalCount ?? 3);
  const maximumBackupAgeMs = options.maximumBackupAgeMs ?? 26 * 60 * 60 * 1_000;
  if (!Number.isSafeInteger(maximumBackupAgeMs) || maximumBackupAgeMs < 60_000) {
    throw new Error("maximumBackupAgeMs must be at least one minute.");
  }
  count("restartCount15m", input.restartCount15m);
  count("preflightFailureCount15m", input.preflightFailureCount15m);
  if (input.diskUsedRatio !== null) ratio("diskUsedRatio", input.diskUsedRatio);
  if (input.publishDiskUsedRatio !== null) ratio("publishDiskUsedRatio", input.publishDiskUsedRatio);

  const alerts: OperationalAlert[] = [];
  if (input.readiness !== "ready") {
    alerts.push({ code: "READINESS_DEGRADED", severity: "critical", value: null, threshold: null });
  }
  if (input.egressGateway !== "ready") {
    alerts.push({ code: "EGRESS_GATEWAY_DEGRADED", severity: "critical", value: null, threshold: null });
  }
  if (input.diskUsedRatio !== null && input.diskUsedRatio >= diskWarningRatio) {
    alerts.push({
      code: "DISK_PRESSURE",
      severity: input.diskUsedRatio >= diskCriticalRatio ? "critical" : "warning",
      value: input.diskUsedRatio,
      threshold: input.diskUsedRatio >= diskCriticalRatio ? diskCriticalRatio : diskWarningRatio,
    });
  }
  if (input.publishDiskUsedRatio !== null && input.publishDiskUsedRatio >= diskWarningRatio) {
    alerts.push({
      code: "PUBLISH_DISK_PRESSURE",
      severity: input.publishDiskUsedRatio >= diskCriticalRatio ? "critical" : "warning",
      value: input.publishDiskUsedRatio,
      threshold: input.publishDiskUsedRatio >= diskCriticalRatio ? diskCriticalRatio : diskWarningRatio,
    });
  }
  if (input.restartCount15m >= restartCriticalCount) {
    alerts.push({ code: "RESTART_LOOP", severity: "critical", value: input.restartCount15m, threshold: restartCriticalCount });
  }
  if (input.preflightFailureCount15m > 0) {
    alerts.push({ code: "PREFLIGHT_FAILURE", severity: "critical", value: input.preflightFailureCount15m, threshold: 1 });
  }
  if (!input.backupReceipt) {
    alerts.push({ code: "BACKUP_UNVERIFIED", severity: "critical", value: null, threshold: maximumBackupAgeMs });
  } else {
    const createdAge = now() - Date.parse(input.backupReceipt.backupCreatedAt);
    const verifiedAge = now() - Date.parse(input.backupReceipt.verifiedAt);
    if (!Number.isFinite(createdAge) || !Number.isFinite(verifiedAge) || createdAge < 0 || verifiedAge < 0 ||
        createdAge > maximumBackupAgeMs || verifiedAge > maximumBackupAgeMs) {
      alerts.push({
        code: "BACKUP_STALE",
        severity: "critical",
        value: Math.max(createdAge, verifiedAge),
        threshold: maximumBackupAgeMs,
      });
    }
  }
  if (
    !input.replicaReceipt
    || !input.backupReceipt
    || input.replicaReceipt.backupId !== input.backupReceipt.backupId
    || input.replicaReceipt.sourceFingerprint !== input.backupReceipt.sourceFingerprint
  ) {
    alerts.push({ code: "REPLICA_UNVERIFIED", severity: "critical", value: null, threshold: maximumBackupAgeMs });
  } else {
    const replicatedAge = now() - Date.parse(input.replicaReceipt.replicatedAt);
    const verifiedAge = now() - Date.parse(input.replicaReceipt.verifiedAt);
    if (
      !Number.isFinite(replicatedAge) || !Number.isFinite(verifiedAge)
      || replicatedAge < 0 || verifiedAge < 0
      || replicatedAge > maximumBackupAgeMs || verifiedAge > maximumBackupAgeMs
    ) {
      alerts.push({
        code: "REPLICA_STALE",
        severity: "critical",
        value: Math.max(replicatedAge, verifiedAge),
        threshold: maximumBackupAgeMs,
      });
    }
  }
  const status = alerts.some(({ severity }) => severity === "critical")
    ? "critical"
    : alerts.length > 0 ? "warning" : "healthy";
  return Object.freeze({
    schemaVersion: 1,
    status,
    evaluatedAt: new Date(now()).toISOString(),
    alerts: Object.freeze(alerts),
  });
}
