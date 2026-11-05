import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import { ConversationShareStore } from "@/workbench/conversation-share-store";
import { conversationJson, conversationMarkdown, safeExportName } from "@/workbench/conversation-export";
import { WorkbenchNotFoundError } from "@/workbench/errors";
import type { WorkbenchProject, WorkbenchThread } from "@/workbench/types";

vi.mock("server-only", () => ({}));

const roots: string[] = [];
const now = "2026-08-28T10:00:00.000Z";
const project = {
  id: "0198b9f0-6631-7000-8000-000000000201", name: "Finance", slug: "finance",
  status: "active", pinned: false, instructions: "", sources: [],
  memory: { enabled: true, notes: "", updatedAt: null },
  sharing: { visibility: "private", members: [] },
  workspace: { id: "0198b9f0-6631-7000-8000-000000000202", label: "Finance", hostType: "managed", status: "ready", isPrimary: true },
  createdAt: now, updatedAt: now,
} satisfies WorkbenchProject;
const thread = {
  id: "0198b9f0-6631-7000-8000-000000000203", projectId: project.id,
  title: "Cierre trimestral", status: "active", pinned: false, createdAt: now, updatedAt: now,
  messages: [{
    id: "0198b9f0-6631-7000-8000-000000000204", role: "user", content: "Resume el cierre",
    createdAt: now, status: "complete", activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [],
  }, {
    id: "0198b9f0-6631-7000-8000-000000000205", role: "assistant", content: "## Resumen\n\nTodo conciliado.",
    createdAt: now, status: "complete", activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [],
  }],
} satisfies WorkbenchThread;

function session(tenantId: string): AuthSession {
  return {
    provider: "local", user: { id: "user-a", name: "Ana", email: "ana@example.test" },
    tenant: { id: tenantId, name: "Example" }, expiresAt: "2026-08-29T10:00:00.000Z",
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("conversation share and export", () => {
  it("stores an immutable authenticated tenant snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-shares-"));
    roots.push(root);
    await mkdir(path.join(root, "data"));
    const store = new ConversationShareStore(path.join(root, "data"));
    const source = structuredClone(thread);
    const share = await store.create(session("example-tenant"), project, source);
    source.messages[1].content = "Changed after sharing";
    await expect(store.read(session("example-tenant"), share.id)).resolves.toMatchObject({
      id: share.id, title: "Cierre trimestral",
      messages: [{ content: "Resume el cierre" }, { content: "## Resumen\n\nTodo conciliado." }],
    });
    await expect(store.read(session("foreign-tenant"), share.id)).rejects.toBeInstanceOf(WorkbenchNotFoundError);
  });

  it("exports the complete conversation in readable and machine formats", () => {
    const markdown = conversationMarkdown(project, thread);
    expect(markdown).toContain("# Cierre trimestral");
    expect(markdown).toContain("## Tú");
    expect(markdown).toContain("Todo conciliado.");
    const json = JSON.parse(conversationJson(project, thread)) as { thread: WorkbenchThread };
    expect(json.thread.messages).toEqual(thread.messages);
    expect(safeExportName("Cierre trimestral / Q3")).toBe("cierre-trimestral-q3");
  });
});
