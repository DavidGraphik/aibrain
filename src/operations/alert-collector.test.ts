import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectOperationalAlertInput } from "@/operations/alert-collector";
import type { BackupVerificationReceipt } from "@/operations/backup";

const roots: string[] = [];
const receipt: BackupVerificationReceipt = {
  schemaVersion: 1,
  installationId: "collector-qa",
  backupId: "20260827T120000Z-11111111-1111-4111-8111-111111111111",
  sourceFingerprint: "a".repeat(64),
  backupCreatedAt: "2026-08-27T12:00:00.000Z",
  verifiedAt: "2026-08-27T12:01:00.000Z",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("collectOperationalAlertInput", () => {
  it("collects loopback readiness, real disk capacity and the local backup receipt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-alert-collector-"));
    roots.push(root);
    await mkdir(path.join(root, "data"));
    await mkdir(path.join(root, "publish"));
    const requests: string[] = [];
    const input = await collectOperationalAlertInput({
      dataRoot: path.join(root, "data"),
      publishWriteRoot: path.join(root, "publish"),
      readinessUrl: "http://127.0.0.1:3000/api/health/ready",
      restartCount15m: 2,
      preflightFailureCount15m: 1,
      readBackupReceipt: async () => receipt,
      fetchImplementation: async (request) => {
        requests.push(String(request));
        return new Response("ok", { status: 200 });
      },
    });
    expect(input).toMatchObject({
      readiness: "ready",
      restartCount15m: 2,
      preflightFailureCount15m: 1,
      backupReceipt: receipt,
      diskUsedRatio: expect.any(Number),
      publishDiskUsedRatio: expect.any(Number),
    });
    expect(requests).toEqual(["http://127.0.0.1:3000/api/health/ready"]);
  });

  it("degrades on a failed probe and rejects non-loopback targets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-alert-collector-"));
    roots.push(root);
    await expect(collectOperationalAlertInput({
      dataRoot: root,
      publishWriteRoot: root,
      readinessUrl: "http://localhost:3000/api/health/ready",
      restartCount15m: 0,
      preflightFailureCount15m: 0,
      readBackupReceipt: async () => null,
      fetchImplementation: async () => { throw new Error("offline"); },
    })).resolves.toMatchObject({ readiness: "degraded", backupReceipt: null });

    await expect(collectOperationalAlertInput({
      dataRoot: root,
      publishWriteRoot: root,
      readinessUrl: "https://attacker.invalid/api/health/ready",
      restartCount15m: 0,
      preflightFailureCount15m: 0,
      readBackupReceipt: async () => null,
    })).rejects.toThrow("exact loopback");
  });

  it("allows only the exact app service health endpoint when Compose mode is explicit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-alert-collector-"));
    roots.push(root);
    const requests: Array<{ url: string; authorization: string | null }> = [];
    await expect(collectOperationalAlertInput({
      dataRoot: root,
      publishWriteRoot: root,
      readinessUrl: "http://app:3000/api/health/ready",
      egressReadinessUrl: "http://egress-gateway:8080/__aibrain_egress_health",
      egressReadinessToken: "health-token-00000000000000000000000000000",
      allowComposeServiceReadiness: true,
      restartCount15m: 0,
      preflightFailureCount15m: 0,
      readBackupReceipt: async () => null,
      fetchImplementation: async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return new Response("ok");
      },
    })).resolves.toMatchObject({ readiness: "ready", egressGateway: "ready" });
    expect(requests).toEqual([
      { url: "http://app:3000/api/health/ready", authorization: null },
      {
        url: "http://egress-gateway:8080/__aibrain_egress_health",
        authorization: "Bearer health-token-00000000000000000000000000000",
      },
    ]);
    await expect(collectOperationalAlertInput({
      dataRoot: root,
      publishWriteRoot: root,
      readinessUrl: "http://app:3000/api/health/ready",
      egressReadinessUrl: "http://egress-gateway:8080/__aibrain_egress_health",
      allowComposeServiceReadiness: true,
      restartCount15m: 0,
      preflightFailureCount15m: 0,
      readBackupReceipt: async () => null,
    })).rejects.toThrow("egressReadinessToken");
    await expect(collectOperationalAlertInput({
      dataRoot: root,
      publishWriteRoot: root,
      readinessUrl: "http://egress-gateway:8080/__aibrain_egress_health",
      allowComposeServiceReadiness: true,
      restartCount15m: 0,
      preflightFailureCount15m: 0,
      readBackupReceipt: async () => null,
    })).rejects.toThrow("exact loopback");
  });
});
