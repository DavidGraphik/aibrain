import { describe, expect, it } from "vitest";
import { evaluateOperationalAlerts } from "@/operations/alerts";
import type { BackupVerificationReceipt } from "@/operations/backup";
import type { BackupReplicaReceipt } from "@/operations/backup-replica";

const now = Date.parse("2026-08-27T12:00:00.000Z");
const receipt: BackupVerificationReceipt = {
  schemaVersion: 1,
  installationId: "company-qa",
  backupId: "20260827T110000Z-11111111-1111-4111-8111-111111111111",
  sourceFingerprint: "a".repeat(64),
  backupCreatedAt: "2026-08-27T11:00:00.000Z",
  verifiedAt: "2026-08-27T11:05:00.000Z",
};
const replicaReceipt: BackupReplicaReceipt = {
  schemaVersion: 1,
  installationId: "company-qa",
  backupId: receipt.backupId,
  sourceFingerprint: receipt.sourceFingerprint,
  repositoryFingerprint: "b".repeat(64),
  remoteSnapshotId: "c".repeat(64),
  replicatedAt: "2026-08-27T11:10:00.000Z",
  verifiedAt: "2026-08-27T11:15:00.000Z",
};

describe("operational alert evaluation", () => {
  it("is healthy only with ready services, safe disk and a fresh verified backup", () => {
    expect(evaluateOperationalAlerts({
      readiness: "ready",
      egressGateway: "ready",
      diskUsedRatio: 0.5,
      publishDiskUsedRatio: 0.5,
      restartCount15m: 0,
      preflightFailureCount15m: 0,
      backupReceipt: receipt,
      replicaReceipt,
    }, { now: () => now })).toMatchObject({ status: "healthy", alerts: [] });
  });

  it("emits stable non-sensitive codes for every operating threshold", () => {
    const result = evaluateOperationalAlerts({
      readiness: "degraded",
      egressGateway: "degraded",
      diskUsedRatio: 0.91,
      publishDiskUsedRatio: 0.81,
      restartCount15m: 3,
      preflightFailureCount15m: 1,
      backupReceipt: null,
      replicaReceipt: null,
    }, { now: () => now });
    expect(result.status).toBe("critical");
    expect(result.alerts.map(({ code }) => code)).toEqual([
      "READINESS_DEGRADED",
      "EGRESS_GATEWAY_DEGRADED",
      "DISK_PRESSURE",
      "PUBLISH_DISK_PRESSURE",
      "RESTART_LOOP",
      "PREFLIGHT_FAILURE",
      "BACKUP_UNVERIFIED",
      "REPLICA_UNVERIFIED",
    ]);
    expect(JSON.stringify(result)).not.toContain("path");
  });

  it("does not let verification of an old snapshot satisfy freshness", () => {
    const result = evaluateOperationalAlerts({
      readiness: "ready",
      egressGateway: "ready",
      diskUsedRatio: 0.2,
      publishDiskUsedRatio: 0.2,
      restartCount15m: 0,
      preflightFailureCount15m: 0,
      backupReceipt: {
        ...receipt,
        backupCreatedAt: "2026-08-20T00:00:00.000Z",
        verifiedAt: "2026-08-27T11:55:00.000Z",
      },
      replicaReceipt,
    }, { now: () => now });
    expect(result.alerts).toEqual([expect.objectContaining({ code: "BACKUP_STALE" })]);
  });

  it("alerts when the latest local backup lacks a matching fresh off-host receipt", () => {
    const staleReplica = {
      ...replicaReceipt,
      replicatedAt: "2026-08-20T00:00:00.000Z",
      verifiedAt: "2026-08-20T00:10:00.000Z",
    };
    expect(evaluateOperationalAlerts({
      readiness: "ready",
      egressGateway: "ready",
      diskUsedRatio: 0.2,
      publishDiskUsedRatio: 0.2,
      restartCount15m: 0,
      preflightFailureCount15m: 0,
      backupReceipt: receipt,
      replicaReceipt: staleReplica,
    }, { now: () => now }).alerts).toEqual([
      expect.objectContaining({ code: "REPLICA_STALE" }),
    ]);
  });
});
