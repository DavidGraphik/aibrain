import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileLocalSessionStore,
  LOCAL_SESSION_ABSOLUTE_MS,
  LOCAL_SESSION_IDLE_MS,
  LOCAL_SESSION_RENEWAL_MS,
} from "@/auth/local-session-store";
import { FileLocalAuthChallengeStore } from "@/auth/local-auth-challenge-store";
import { FileLocalUserStore } from "@/auth/local-user-store";

const USER_ID = "0198b9f0-6631-7000-8000-000000000001";
const SESSION_ID = "A".repeat(43);
const roots: string[] = [];

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-auth-store-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileLocalSessionStore", () => {
  it("stores only a hash of the opaque 256-bit cookie value", async () => {
    const root = await temporaryRoot();
    const store = new FileLocalSessionStore({
      rootDirectory: root,
      now: () => 1_000,
      createSessionId: () => SESSION_ID,
    });
    const created = await store.create("example-lab-dev", USER_ID);
    const hash = createHash("sha256").update(SESSION_ID).digest("hex");
    const raw = await readFile(path.join(root, "records", `${hash}.json`), "utf8");

    expect(created.sessionId).toBe(SESSION_ID);
    expect(raw).not.toContain(SESSION_ID);
    await expect(readFile(path.join(root, "records", `${SESSION_ID}.json`))).rejects.toThrow();
    expect((await store.read(SESSION_ID, "example-lab-dev"))?.renewed).toBe(false);
    expect(await store.read(SESSION_ID, "other-installation")).toBeNull();
  });

  it("renews idle expiry at most daily and never extends absolute expiry", async () => {
    const root = await temporaryRoot();
    let now = 10_000;
    const store = new FileLocalSessionStore({
      rootDirectory: root,
      now: () => now,
      createSessionId: () => SESSION_ID,
    });
    const created = await store.create("example-lab-dev", USER_ID);
    now += LOCAL_SESSION_RENEWAL_MS - 1;
    expect((await store.read(SESSION_ID, "example-lab-dev"))?.renewed).toBe(false);
    now += 1;
    const renewed = await store.read(SESSION_ID, "example-lab-dev");
    expect(renewed?.renewed).toBe(true);
    expect(renewed?.record.idleExpiresAt).toBe(now + LOCAL_SESSION_IDLE_MS);
    for (let index = 0; index < 4; index += 1) {
      now += 6 * 24 * 60 * 60 * 1000;
      expect((await store.read(SESSION_ID, "example-lab-dev"))?.renewed).toBe(true);
    }
    now = created.record.absoluteExpiresAt - 1;
    const finalRenewal = await store.read(SESSION_ID, "example-lab-dev");
    expect(finalRenewal?.record.idleExpiresAt).toBe(created.record.absoluteExpiresAt);
    now = created.record.absoluteExpiresAt;
    expect(await store.read(SESSION_ID, "example-lab-dev")).toBeNull();
    expect(created.record.absoluteExpiresAt - created.record.issuedAt).toBe(LOCAL_SESSION_ABSOLUTE_MS);
  });

  it("revokes every session belonging to one user without affecting another", async () => {
    const root = await temporaryRoot();
    let sequence = 0;
    const store = new FileLocalSessionStore({
      rootDirectory: root,
      createSessionId: () => `${sequence++ === 0 ? "A" : "B"}`.repeat(43),
    });
    const first = await store.create("example-lab-dev", USER_ID);
    const otherUser = "0198b9f0-6631-7000-8000-000000000002";
    const second = await store.create("example-lab-dev", otherUser);

    expect(await store.revokeUser("example-lab-dev", USER_ID)).toBe(1);
    expect(await store.read(first.sessionId, "example-lab-dev")).toBeNull();
    expect(await store.read(second.sessionId, "example-lab-dev")).not.toBeNull();
  });
});

describe("FileLocalUserStore", () => {
  it("loads strict normalized users and rejects directory/file identity mismatches", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, USER_ID);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "user.json"), JSON.stringify({
      schemaVersion: 1,
      userId: USER_ID,
      email: "employee@example.test",
      displayName: "Synthetic Employee",
      enabled: true,
      workerId: "employee-one",
    }));
    const store = new FileLocalUserStore(root);
    expect(await store.read(USER_ID)).toMatchObject({ email: "employee@example.test", enabled: true });

    await writeFile(path.join(directory, "user.json"), JSON.stringify({
      schemaVersion: 1,
      userId: "0198b9f0-6631-7000-8000-000000000002",
      email: "employee@example.test",
      displayName: "Synthetic Employee",
      enabled: true,
      workerId: "employee-one",
    }));
    await expect(store.read(USER_ID)).rejects.toThrow("does not match its directory");
  });

  it("refuses symlinked user records and password markers", async () => {
    const root = await temporaryRoot();
    const outside = path.join(root, "outside.json");
    const directory = path.join(root, USER_ID);
    await mkdir(directory, { recursive: true });
    await writeFile(outside, "{}");
    await symlink(outside, path.join(directory, "user.json"));
    const store = new FileLocalUserStore(root);
    await expect(store.read(USER_ID)).rejects.toThrow();
  });
});


describe("FileLocalAuthChallengeStore provider token compatibility", () => {
  it("consumes a fresh GoTrue challenge with a 12-character refresh token exactly once", async () => {
    const root = await temporaryRoot();
    const store = new FileLocalAuthChallengeStore({ rootDirectory: root, encryptionKey: new Uint8Array(32).fill(7) });
    const credentials = { accessToken: "synthetic-access-token", refreshToken: "abc123DEF456" };
    const challenge = await store.create({ installationId: "example-lab-dev", userId: USER_ID, ...credentials });
    expect(await store.consume(challenge.challengeId, "other-installation", async () => "wrong tenant")).toBeNull();
    expect(await store.consume(challenge.challengeId, "example-lab-dev", async (record) => {
      expect(record.accessToken).toBe(credentials.accessToken);
      expect(record.refreshToken).toBe(credentials.refreshToken);
      return "password changed";
    })).toBe("password changed");
    expect(await store.consume(challenge.challengeId, "example-lab-dev", async () => "replayed")).toBeNull();
  });

  it("still rejects an empty refresh token", async () => {
    const root = await temporaryRoot();
    const store = new FileLocalAuthChallengeStore({ rootDirectory: root, encryptionKey: new Uint8Array(32).fill(7) });
    const challenge = await store.create({ installationId: "example-lab-dev", userId: USER_ID, accessToken: "synthetic-access-token", refreshToken: "" });
    await expect(store.consume(challenge.challengeId, "example-lab-dev", async () => "accepted")).rejects.toThrow("could not be authenticated");
  });
});
