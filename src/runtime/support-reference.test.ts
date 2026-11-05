import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AuthSession } from "@/auth/types";
import type { DynamicToolCallParams } from "../../contracts/codex/0.162.1/types/v2/DynamicToolCallParams";
import { FileSupportRequestStore } from "@/support/store";
import { publicAssistantText, publicToolOutput } from "@/ui/public-activity";
import { supportReference, supportRequestId } from "./support-reference";
import { handleSupportTool, type SupportToolContext } from "./support-dynamic-tools";
const fixtures = vi.hoisted(() => ({ root: "" }));
vi.mock("server-only", () => ({}));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: async () => ({ installationId: "modtime", paths: { usersRoot: fixtures.root } }) }));
vi.mock("@/support/server-service", () => ({ createSupportRequest: async (session: AuthSession, input: Parameters<FileSupportRequestStore["create"]>[0]) => new FileSupportRequestStore("modtime", session.user.id, fixtures.root).create(input) }));
const USER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const PROJECT = "00000000-0000-4000-8000-000000000003";
const THREAD = "00000000-0000-4000-8000-000000000004";
const PRIVATE = "00000000-0000-4000-8000-000000000005";
function context(userId = USER): SupportToolContext {
  const session: AuthSession = { provider: "local", user: { id: userId, name: "Synthetic", email: "test@example.invalid" }, tenant: { id: "modtime", name: "Test" }, expiresAt: "2099-01-01T00:00:00Z" };
  return { session, installationId: "modtime", userId, runtimeThreadId: "runtime", runtimeTurnId: "turn", projectId: PROJECT, threadId: THREAD, humanMessage: "La importación falla. Repórtalo.", screenshots: [], backgroundExecution: false };
}
async function call(tool: string, args: unknown, ctx = context()) {
  const response = await handleSupportTool({ namespace: "aibrain_support", tool, arguments: args, threadId: "runtime", turnId: ctx.runtimeTurnId, callId: "call" } as DynamicToolCallParams, ctx);
  const item = response.contentItems[0];
  if (item.type !== "inputText") throw new Error("Missing tool text");
  return { success: response.success, text: item.text, value: JSON.parse(item.text) };
}
beforeEach(async () => { fixtures.root = await mkdtemp(path.join(os.tmpdir(), "aibrain-support-reference-")); });
afterEach(async () => { await rm(fixtures.root, { recursive: true, force: true }); });
describe("support case references through the real display boundary", () => {
  it("roundtrips canonical own-case UUIDs and rejects malformed or overflowing aliases", () => {
    for (const id of [USER, "d87df88a-0863-48c8-86dc-867212b2a11f", "ffffffff-ffff-7fff-bfff-ffffffffffff"]) {
      const ref = supportReference(id);
      expect(ref).toMatch(/^SUP-[A-Z2-7]{26}$/);
      expect(supportRequestId(ref)).toBe(id);
      expect(supportRequestId(ref.toLowerCase())).toBe(id);
      expect(supportRequestId(id.toUpperCase())).toBe(id);
    }
    for (const input of ["SUP-" + "Z".repeat(26), "SUP-" + "A".repeat(26), "SUP-../users", "SUP-" + "A".repeat(25), null, { id: USER }]) expect(supportRequestId(input)).toBeNull();
  });
  it("creates, lists, reads and replies to the same durable case using the employee-visible reference", async () => {
    const created = await call("create", { kind: "bug", description: `La importación falla. Referencia interna ${PRIVATE}; archivo /var/lib/aibrain/data/users/${USER}/workspace/private.txt` });
    expect(created.success).toBe(true);
    const ref: string = created.value.id;
    expect(ref).toMatch(/^SUP-[A-Z2-7]{26}$/);
    expect(created.value.reference).toBe(ref);
    expect(publicToolOutput(created.text)).toContain(ref);
    expect(publicAssistantText(`Solicitud guardada: ${ref}. Interno: ${PRIVATE}; /var/lib/aibrain/private/config.json`, "Asistente")).toBe(`Solicitud guardada: ${ref}. Interno: identificador interno; archivo interno`);
    expect(created.text).not.toContain(USER); expect(created.text).not.toContain(PRIVATE); expect(created.text).not.toContain(PROJECT); expect(created.text).not.toContain(THREAD);
    for (const key of ["userId", "installationId", "clientRequestId", "context", "evidence", "lease", "token"]) expect(created.value).not.toHaveProperty(key);
    const list = await call("list", {});
    expect(list.value.requests).toHaveLength(1); expect(list.value.requests[0].id).toBe(ref);
    const read = await call("read", { id: ref }); expect(read.success).toBe(true); expect(read.value.request.id).toBe(ref);
    const reply = await call("reply", { id: ref, body: "Sigue fallando" }, { ...context(), runtimeTurnId: "follow-up" });
    expect(reply.success).toBe(true); expect(reply.value.request.id).toBe(ref); expect(reply.value.request.messages.at(-1).body).toBe("Sigue fallando");
    const stored = await new FileSupportRequestStore("modtime", USER, fixtures.root).list();
    expect(stored).toHaveLength(1); expect(stored[0].id).toBe(supportRequestId(ref)); expect(stored[0].messages).toHaveLength(2);
    expect((await call("read", { id: ref }, context(OTHER))).success).toBe(false);
    expect((await call("reply", { id: ref, body: "Foreign" }, context(OTHER))).success).toBe(false);
    expect((await call("list", {}, context(OTHER))).value.requests).toEqual([]);
    expect((await new FileSupportRequestStore("modtime", USER, fixtures.root).list())[0].messages).toHaveLength(2);
  });
  it("keeps all unrelated IDs and private paths subject to the unchanged scrubber", () => {
    const ref = supportReference(USER);
    const output = publicToolOutput(JSON.stringify({ id: ref, userId: OTHER, threadId: THREAD, path: "/Users/operator/.ssh/private-key", digest: "a".repeat(64) }));
    expect(output).toContain(ref);
    for (const value of [OTHER, THREAD, "/Users/operator", "a".repeat(64)]) expect(output).not.toContain(value);
    expect(output).toContain("identificador interno"); expect(output).toContain("archivo interno");
  });
});
