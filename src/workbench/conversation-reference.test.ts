import { beforeEach, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import { WorkbenchNotFoundError } from "./errors";
import { conversationReferenceUrl, readConversationReference } from "./conversation-reference";
const mock = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/workbench/store", () => ({ getThread: mock.read }));
const id = "11111111-1111-4111-8111-111111111111";
const reference = conversationReferenceUrl(id).split("/").at(-1)!;
const session: AuthSession = { provider: "local", user: { id, name: "QA", email: "qa@example.test" }, tenant: { id: "qa", name: "QA" }, expiresAt: "2099-01-01T00:00:00Z" };
beforeEach(() => { vi.clearAllMocks(); mock.read.mockResolvedValue({ id }); });
it("re-resolves the current authenticated session on every open; reference grants no access", async () => {
  expect(await readConversationReference(session, reference)).toEqual({ id });
  expect(mock.read).toHaveBeenLastCalledWith(session, id);
  mock.read.mockRejectedValue(new WorkbenchNotFoundError());
  await expect(readConversationReference(session, reference)).rejects.toBeInstanceOf(WorkbenchNotFoundError);
  expect(mock.read).toHaveBeenCalledTimes(2);
});
it("rejects malformed, noncanonical, traversal, invalid-UUID and expired/nonlocal inputs before store access", async () => {
  for (const input of ["../../private", id, reference + "=", reference.slice(0,-1) + "R", "A".repeat(22), "https://evil.test", reference + "?owner=other"]) {
    await expect(readConversationReference(session, input)).rejects.toBeInstanceOf(WorkbenchNotFoundError);
  }
  for (const changed of [{ ...session, provider: "demo" as const }, { ...session, expiresAt: "2000-01-01T00:00:00Z" }]) {
    await expect(readConversationReference(changed, reference)).rejects.toBeInstanceOf(WorkbenchNotFoundError);
  }
  expect(mock.read).not.toHaveBeenCalled();
  expect(() => conversationReferenceUrl("../../private")).toThrow(WorkbenchNotFoundError);
});
