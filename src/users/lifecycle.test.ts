import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileLocalSessionStore } from "@/auth/local-session-store";
import { FileLocalUserStore } from "@/auth/local-user-store";
import { parseInstallationConfig } from "@/config/installation-schema";
import { UnsafeFilePathError } from "@/security/safe-file";
import { UserLifecycleError, UserLifecycleService } from "@/users/lifecycle";
import { UserProvisioner } from "@/users/provisioner";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-user-lifecycle-"));
  roots.push(root);
  const config = parseInstallationConfig({
    schemaVersion: 1,
    installationId: "lifecycle-qa",
    companyName: "Lifecycle QA",
    companySlug: "lifecycle-qa",
    publicUrl: "http://127.0.0.1:3000",
    branding: {
      productName: "Lifecycle Brain",
      logoPath: "/branding/lifecycle/logo.svg",
      faviconPath: "/branding/lifecycle/favicon.svg",
      accentColor: "#315ee7",
    },
    paths: {
      dataRoot: path.join(root, "data"),
      companyContextRoot: path.join(root, "data", "company"),
      usersRoot: path.join(root, "data", "users"),
      sourceReadRoot: path.join(root, "documents", "source-ro"),
      publishWriteRoot: path.join(root, "documents", "publish-rw"),
      backupsRoot: path.join(root, "data", "backups"),
    },
  });
  await new UserProvisioner(config).provision({
    userId: USER_ID,
    email: "employee@example.test",
    displayName: "Employee",
    requireInitialPasswordChange: false,
  });
  const sessions = new FileLocalSessionStore({
    rootDirectory: path.join(config.paths.dataRoot, "sessions"),
  });
  return { root, config, sessions };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("UserLifecycleService", () => {
  it("disables once, revokes every session, stops only that user's runtimes and replays safely", async () => {
    const { config, sessions } = await fixture();
    const firstSession = await sessions.create(config.installationId, USER_ID);
    const secondSession = await sessions.create(config.installationId, USER_ID);
    const stopWorker = vi.fn(async () => true);
    const stopBrowser = vi.fn(async () => true);
    const service = new UserLifecycleService(config, { stopWorker, stopBrowser });
    const command = {
      schemaVersion: 1 as const,
      requestId: "10000000-0000-4000-8000-000000000001",
      action: "disable" as const,
      userId: USER_ID,
    };

    const result = await service.execute(command);
    expect(result).toMatchObject({
      changed: true,
      enabled: false,
      sessionsRevoked: 2,
      workerStopped: true,
      browserStopped: true,
      replayed: false,
    });
    expect(await new FileLocalUserStore(config.paths.usersRoot).read(USER_ID)).toMatchObject({ enabled: false });
    expect(await sessions.read(firstSession.sessionId, config.installationId)).toBeNull();
    expect(await sessions.read(secondSession.sessionId, config.installationId)).toBeNull();
    expect(stopWorker).toHaveBeenCalledOnce();
    expect(stopBrowser).toHaveBeenCalledOnce();

    const replay = await service.execute(command);
    expect(replay).toMatchObject({ ...result, replayed: true });
    expect(stopWorker).toHaveBeenCalledOnce();
    expect(stopBrowser).toHaveBeenCalledOnce();
    const audit = await readFile(
      path.join(config.paths.dataRoot, "operations", "user-lifecycle", "audit.jsonl"),
      "utf8",
    );
    expect(audit.trim().split("\n")).toHaveLength(1);
    expect(audit).not.toContain("employee@example.test");
  });

  it("rejects request-id drift and supports enable plus recover", async () => {
    const { config, sessions } = await fixture();
    const service = new UserLifecycleService(config);
    const requestId = "10000000-0000-4000-8000-000000000002";
    await service.execute({ schemaVersion: 1, requestId, action: "disable", userId: USER_ID });
    await expect(service.execute({ schemaVersion: 1, requestId, action: "enable", userId: USER_ID }))
      .rejects.toMatchObject({ code: "USER_LIFECYCLE_IDEMPOTENCY_CONFLICT", status: 409 });

    const enabled = await service.execute({
      schemaVersion: 1,
      requestId: "10000000-0000-4000-8000-000000000003",
      action: "enable",
      userId: USER_ID,
    });
    expect(enabled).toMatchObject({ changed: true, enabled: true, sessionsRevoked: 0 });
    const activeSession = await sessions.create(config.installationId, USER_ID);

    const recovered = await service.execute({
      schemaVersion: 1,
      requestId: "10000000-0000-4000-8000-000000000004",
      action: "recover",
      userId: USER_ID,
    });
    expect(recovered).toMatchObject({
      enabled: true,
      sessionsRevoked: 1,
      passwordChangeRequired: true,
    });
    expect(await sessions.read(activeSession.sessionId, config.installationId)).toBeNull();
    expect(await new FileLocalUserStore(config.paths.usersRoot).hasInitialPasswordMarker(USER_ID)).toBe(true);
  });

  it("fails closed for absent users and an unsafe marker", async () => {
    const { config } = await fixture();
    const service = new UserLifecycleService(config);
    await expect(service.execute({
      schemaVersion: 1,
      requestId: "10000000-0000-4000-8000-000000000005",
      action: "disable",
      userId: "00000000-0000-4000-8000-000000000099",
    })).rejects.toBeInstanceOf(UserLifecycleError);

    const marker = path.join(config.paths.usersRoot, USER_ID, "password-change-required");
    await unlink(marker).catch(() => undefined);
    await import("node:fs/promises").then(({ symlink }) => symlink("user.json", marker));
    await expect(service.execute({
      schemaVersion: 1,
      requestId: "10000000-0000-4000-8000-000000000006",
      action: "recover",
      userId: USER_ID,
    })).rejects.toBeInstanceOf(UnsafeFilePathError);
  });
});
