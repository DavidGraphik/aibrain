import "server-only";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readRegularFileWithin } from "@/security/safe-file";
import { createLocalSessionContext } from "@/auth/auth-context";
import { assertPrivateOwnerSession, isPrivateOwnerAuthConfigured } from "@/auth/private-owner-identity-provider";
import { assertOwnPersonalModelTest, ModelAuthUnavailableError } from "./server-model-auth";
import { userAccessAuthProvider } from "./personal-auth-provider";
import type { SharedAuthProvider } from "./workers/shared-auth-broker";

export const SUPPORT_MODEL_QA_PATH = "/etc/aibrain/personal-test-support.json";
type Identity = { installationId: string; userId: string };
type Target = { userId: string; sessionIdHash: string; profileSha256: string; permissionsSha256: string };
export type SupportModelQaPolicy = { schemaVersion: 1; installationId: string; sponsorUserId: string; sponsorEmail: string;
  createdAt: number; expiresAt: number; targets: Target[] };
const fail = () => new ModelAuthUnavailableError();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const keys = (v: object) => Object.keys(v).sort().join(",");
export function parseSupportModelQaPolicy(v: unknown, identity: Identity, now = Date.now()): SupportModelQaPolicy {
  if (!object(v) || keys(v) !== "createdAt,expiresAt,installationId,schemaVersion,sponsorEmail,sponsorUserId,targets"
    || v.schemaVersion !== 1 || v.installationId !== identity.installationId || typeof v.sponsorUserId !== "string" || !uuid.test(v.sponsorUserId)
    || typeof v.sponsorEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.sponsorEmail)
    || typeof v.createdAt !== "number" || !Number.isSafeInteger(v.createdAt) || v.createdAt <= 0 || v.createdAt > now
    || typeof v.expiresAt !== "number" || !Number.isSafeInteger(v.expiresAt) || v.expiresAt <= now
    || v.expiresAt <= v.createdAt || v.expiresAt - v.createdAt > 2 * 60 * 60_000
    || !Array.isArray(v.targets) || v.targets.length < 1 || v.targets.length > 16) throw fail();
  const ids = new Set<string>();
  for (const t of v.targets) {
    if (!object(t) || keys(t) !== "permissionsSha256,profileSha256,sessionIdHash,userId"
      || typeof t.userId !== "string" || !uuid.test(t.userId) || t.userId === v.sponsorUserId || ids.has(t.userId)
      || [t.sessionIdHash, t.profileSha256, t.permissionsSha256].some(x => typeof x !== "string" || !hash.test(x))) throw fail();
    ids.add(t.userId);
  }
  if (!uuid.test(identity.userId) || !ids.has(identity.userId)) throw fail();
  return v as unknown as SupportModelQaPolicy;
}

async function readPolicy(identity: Identity) {
  if (!isPrivateOwnerAuthConfigured() || await realpath(SUPPORT_MODEL_QA_PATH) !== SUPPORT_MODEL_QA_PATH) throw fail();
  let h: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const initial = await lstat(SUPPORT_MODEL_QA_PATH);
    if (!initial.isFile() || initial.isSymbolicLink()) throw fail();
    h = await open(SUPPORT_MODEL_QA_PATH, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const a = await h.stat({ bigint: true });
    if (!a.isFile() || a.uid !== 0n || a.gid !== BigInt(process.getegid?.() ?? -1) || a.nlink !== 1n
      || (a.mode & 0o7777n) !== 0o640n || a.size < 2n || a.size > 16384n) throw fail();
    const raw = await h.readFile();
    const b = await h.stat({ bigint: true }), c = await lstat(SUPPORT_MODEL_QA_PATH, { bigint: true });
    const same = (x: typeof a) => ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]
      .every(k => x[k as keyof typeof x] === a[k as keyof typeof a]);
    if (raw.length !== Number(a.size) || !same(b) || !same(c) || await realpath(SUPPORT_MODEL_QA_PATH) !== SUPPORT_MODEL_QA_PATH) throw fail();
    return parseSupportModelQaPolicy(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)), identity);
  } finally { await h?.close(); }
}

/** Original bytes, with length framing, pin both permission sources. */
export function supportModelPermissionsDigest(workspace: Buffer, catalog: Buffer) {
  return createHash("sha256").update(String(workspace.length)).update(":").update(workspace)
    .update(String(catalog.length)).update(":").update(catalog).digest("hex");
}
async function targetDigests(dataRoot: string, userId: string) {
  const [profile, workspace, catalog] = await Promise.all([
    readRegularFileWithin(dataRoot, `users/${userId}/user.json`, 65536),
    readRegularFileWithin(dataRoot, "workspace-admin/state.json", 2 * 1024 * 1024),
    readRegularFileWithin(dataRoot, "catalog/state.json", 2 * 1024 * 1024),
  ]);
  return { profileSha256: createHash("sha256").update(profile).digest("hex"), permissionsSha256: supportModelPermissionsDigest(workspace, catalog) };
}

/** Never returns the target as the model owner. Does not mutate a session,
 * worker context, connector principal, credential file or employee permission. */
export async function supportModelSponsor(identity: Identity): Promise<Identity> {
  try {
    const policy = await readPolicy(identity), target = policy.targets.find(t => t.userId === identity.userId)!;
    const { installation, sessions, users } = await createLocalSessionContext();
    if (installation.installationId !== identity.installationId) throw fail();
    const binding = await sessions.activeSupportBindingByHash(identity.installationId, identity.userId, target.sessionIdHash);
    if (!binding?.support || binding.support.actorUserId !== policy.sponsorUserId || binding.support.actorEmail !== policy.sponsorEmail) throw fail();
    const user = await users.read(identity.userId);
    if (!user?.enabled || await users.hasInitialPasswordMarker(identity.userId)) throw fail();
    const digest = await targetDigests(installation.paths.dataRoot, identity.userId);
    if (digest.profileSha256 !== target.profileSha256 || digest.permissionsSha256 !== target.permissionsSha256) throw fail();
    const sponsor = { installationId: identity.installationId, userId: policy.sponsorUserId };
    await assertPrivateOwnerSession({ ...sponsor, email: policy.sponsorEmail });
    // Re-read the root lease after all async checks: removal/change fails closed.
    const current = await readPolicy(identity);
    if (JSON.stringify(current) !== JSON.stringify(policy)) throw fail();
    return sponsor;
  } catch { throw fail(); }
}

/** Owner socket is selected only in this model lane. Identity outside it stays TARGET. */
export function personalQaAuthProvider(identity: Identity): SharedAuthProvider {
  let pinnedSponsor: string | undefined;
  let boundProvider: SharedAuthProvider | undefined;
  return async (...args) => {
    let sponsor: Identity;
    try { await assertOwnPersonalModelTest(identity); sponsor = identity; }
    catch { sponsor = await supportModelSponsor(identity); }
    if (pinnedSponsor && pinnedSponsor !== sponsor.userId) throw fail();
    const provider = boundProvider ?? userAccessAuthProvider(sponsor);
    if (!provider) throw fail();
    const value = await provider(...args);
    if (sponsor.userId === identity.userId) await assertOwnPersonalModelTest(identity);
    else if ((await supportModelSponsor(identity)).userId !== sponsor.userId) throw fail();
    pinnedSponsor = sponsor.userId;
    boundProvider = provider;
    return value;
  };
}

export async function isSponsoredModelQa(identity: Identity) {
  try { await assertOwnPersonalModelTest(identity); return false; }
  catch { await supportModelSponsor(identity); return true; }
}

/** Only explicit disabling is allowed in the Apps namespace. This also covers
 * parent-object edits (`features`/`apps`), not just dotted leaf writes. */
function assertAppsDisabled(path: string, value: unknown) {
  if (path === "features.apps" || path.startsWith("features.apps.")) {
    if (path !== "features.apps" || value !== false) throw fail();
  } else if (path === "apps") {
    if (!object(value) || Object.values(value).some(v => !object(v) || v.enabled !== false)) throw fail();
  } else if (path.startsWith("apps.")) {
    const segments = path.split(".");
    if (!(segments.length === 3 && segments[2] === "enabled" && value === false)
      && !(segments.length === 2 && object(value) && value.enabled === false)) throw fail();
  } else if (object(value)) {
    for (const [key, child] of Object.entries(value)) assertAppsDisabled(path ? `${path}.${key}` : key, child);
  }
}
function assertConfigEdit(edit: unknown) {
  if (!object(edit) || typeof edit.keyPath !== "string") throw fail();
  // The supported internal MCP paths are plain identifiers. Reject alternate
  // TOML quoting/escapes rather than ambiguously interpret an Apps path.
  if (!/^[A-Za-z0-9_.-]*$/.test(edit.keyPath)) throw fail();
  assertAppsDisabled(edit.keyPath, edit.value);
}

/** Sponsored workers must never discover or invoke the sponsor's personal Apps.
 * Both config write RPCs in the pinned SDK are inspected independently of the
 * ordinary model guard (which currently admits only selected MCP leaf writes). */
export function assertSponsoredModelRpc(method: string, params: unknown) {
  if (method.startsWith("app/")) throw fail();
  if (method === "config/value/write") assertConfigEdit(params);
  if (method === "config/batchWrite") {
    if (!object(params) || !Array.isArray(params.edits)) throw fail();
    for (const edit of params.edits) assertConfigEdit(edit);
  }
  if (object(params) && object(params.config)) assertAppsDisabled("", params.config);
}
export const SPONSORED_MODEL_CONFIG_OVERRIDES = Object.freeze(['features.apps=false', 'apps._default.enabled=false']);
