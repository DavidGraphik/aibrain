import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InstallationConfig } from "@/config/installation-schema";
import { checkInstallationReadiness } from "@/operations/readiness";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-readiness-"));
  roots.push(root);
  const dataRoot = path.join(root, "data");
  const sourceReadRoot = path.join(root, "source-ro");
  const publishWriteRoot = path.join(root, "publish-rw");
  const config: InstallationConfig = {
    schemaVersion: 1,
    installationId: "readiness-qa",
    companyName: "Readiness QA",
    companySlug: "readiness-qa",
    publicUrl: "https://readiness.test",
    branding: {
      productName: "Readiness Brain",
      logoPath: "/brand/logo.svg",
      faviconPath: "/brand/favicon.svg",
      accentColor: "#112233",
    },
    paths: {
      dataRoot,
      companyContextRoot: path.join(dataRoot, "company"),
      usersRoot: path.join(dataRoot, "users"),
      sourceReadRoot,
      publishWriteRoot,
      backupsRoot: path.join(dataRoot, "backups"),
    },
  };
  await Promise.all([
    mkdir(config.paths.companyContextRoot, { recursive: true, mode: 0o700 }),
    mkdir(config.paths.usersRoot, { recursive: true, mode: 0o700 }),
    mkdir(config.paths.backupsRoot, { recursive: true, mode: 0o700 }),
    mkdir(sourceReadRoot, { mode: 0o500 }),
    mkdir(publishWriteRoot, { mode: 0o700 }),
  ]);
  return { root, config };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await chmod(path.join(root, "source-ro"), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }));
});

describe("installation readiness", () => {
  it("reports ready only when private stores and document mounts are safe", async () => {
    const { root, config } = await fixture();
    const report = await checkInstallationReadiness(config, {
      now: () => Date.parse("2026-08-27T12:00:00.000Z"),
      minimumFreeBytes: 0,
      minimumFreeRatio: 0,
      dockerSocketPath: path.join(root, "missing-docker.sock"),
    });
    expect(report).not.toHaveProperty("components");
    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "ready",
      checkedAt: "2026-08-27T12:00:00.000Z",
      checks: expect.arrayContaining([
        { name: "source-read", status: "pass", code: "OK" },
        { name: "publish-write", status: "pass", code: "OK" },
        { name: "disk-capacity", status: "pass", code: "OK" },
        { name: "publish-capacity", status: "pass", code: "OK" },
        { name: "docker-socket", status: "pass", code: "OK" },
      ]),
    });
    expect(report.disk?.totalBytes).toBeGreaterThan(0);
  });

  it("degrades when publish capacity is low even while the product-data filesystem is healthy", async () => {
    const { root, config } = await fixture();
    const report = await checkInstallationReadiness(config, {
      minimumFreeBytes: 1_000,
      minimumFreeRatio: 0.1,
      dockerSocketPath: path.join(root, "missing-docker.sock"),
      readFilesystemCapacity: async (capacityRoot) => capacityRoot === config.paths.dataRoot
        ? { bavail: 9_000n, bsize: 1n, blocks: 10_000n }
        : { bavail: 999n, bsize: 1n, blocks: 10_000n },
    });
    expect(report.status).toBe("degraded");
    expect(report.checks).toEqual(expect.arrayContaining([
      { name: "disk-capacity", status: "pass", code: "OK" },
      { name: "publish-capacity", status: "fail", code: "PUBLISH_CAPACITY_LOW" },
    ]));
  });

  it("degrades for writable source, missing publish, low disk or docker socket", async () => {
    const { root, config } = await fixture();
    await chmod(config.paths.sourceReadRoot, 0o700);
    await rm(config.paths.publishWriteRoot, { recursive: true });
    const socketMarker = path.join(root, "docker.sock");
    await writeFile(socketMarker, "not-a-real-socket\n");
    const report = await checkInstallationReadiness(config, {
      minimumFreeBytes: Number.MAX_SAFE_INTEGER,
      minimumFreeRatio: 1,
      dockerSocketPath: socketMarker,
    });
    expect(report.status).toBe("degraded");
    expect(report.checks).toEqual(expect.arrayContaining([
      { name: "source-read", status: "fail", code: "SOURCE_READ_WRITABLE" },
      { name: "publish-write", status: "fail", code: "PUBLISH_WRITE_UNAVAILABLE" },
      { name: "disk-capacity", status: "fail", code: "DISK_CAPACITY_LOW" },
      { name: "docker-socket", status: "fail", code: "DOCKER_SOCKET_PRESENT" },
    ]));
  });

  it("aggregates typed required and optional component probes without global registries", async () => {
    const { root, config } = await fixture();
    const report = await checkInstallationReadiness(config, {
      minimumFreeBytes: 0,
      minimumFreeRatio: 0,
      dockerSocketPath: path.join(root, "missing-docker.sock"),
      componentProbes: [
        {
          name: "worker-runtime",
          required: true,
          async check() {
            return { status: "degraded", code: "WORKERS_DEGRADED", metrics: { active: 1, expected: 2 } };
          },
        },
        {
          name: "browser-runtime",
          required: false,
          async check() {
            throw new Error("browser intentionally unavailable");
          },
        },
      ],
    });

    expect(report.status).toBe("degraded");
    expect(report.components).toEqual([
      {
        name: "worker-runtime",
        required: true,
        status: "degraded",
        code: "WORKERS_DEGRADED",
        metrics: { active: 1, expected: 2 },
      },
      {
        name: "browser-runtime",
        required: false,
        status: "unavailable",
        code: "COMPONENT_CHECK_FAILED",
      },
    ]);
  });

  it("bounds readiness probes with a timeout and abort signal", async () => {
    const { root, config } = await fixture();
    let aborted = false;
    const report = await checkInstallationReadiness(config, {
      minimumFreeBytes: 0,
      minimumFreeRatio: 0,
      dockerSocketPath: path.join(root, "missing-docker.sock"),
      componentTimeoutMs: 10,
      componentProbes: [{
        name: "codex-runtime",
        required: true,
        async check(signal) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            }, { once: true });
          });
          return { status: "ready", code: "OK" };
        },
      }],
    });
    expect(aborted).toBe(true);
    expect(report.status).toBe("degraded");
    expect(report.components).toEqual([{
      name: "codex-runtime",
      required: true,
      status: "unavailable",
      code: "COMPONENT_TIMEOUT",
    }]);
  });
});
