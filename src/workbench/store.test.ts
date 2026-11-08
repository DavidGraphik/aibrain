import { describe, expect, it, vi } from "vitest";
import type { WorkbenchProject } from "@/workbench/types";
import { STANDALONE_PROJECT_SLUG } from "@/workbench/types";

vi.mock("server-only", () => ({}));

import { visibleProjectReferences } from "@/workbench/store";

function project(input: Pick<WorkbenchProject, "id" | "name" | "slug" | "status">): WorkbenchProject {
  return {
    ...input,
    pinned: false,
    instructions: "",
    sources: [],
    memory: { enabled: false, notes: "", updatedAt: null },
    sharing: { visibility: "private", members: [] },
    workspace: {
      id: "11111111-1111-4111-8111-111111111111",
      label: "Internal runtime workspace",
      hostType: "managed",
      status: "ready",
      isPrimary: true,
    },
    createdAt: "2026-08-28T09:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
  };
}

describe("visibleProjectReferences", () => {
  it("uses the exact active UI project catalogue and never exposes backing workspaces or hidden snapshots", () => {
    const testing = project({
      id: "00000000-0000-4000-8000-000000000011",
      name: "Testing 1",
      slug: "testing-1",
      status: "active",
    });
    const hiddenConversations = project({
      id: "00000000-0000-4000-8000-000000000012",
      name: "Conversaciones",
      slug: STANDALONE_PROJECT_SLUG,
      status: "active",
    });
    const archived = project({
      id: "00000000-0000-4000-8000-000000000013",
      name: "Previous project",
      slug: "previous-project",
      status: "archived",
    });

    const references = visibleProjectReferences({ projects: [hiddenConversations, archived, testing] });

    expect(references).toEqual([
      { id: testing.id, name: "Testing 1" },
    ]);
    expect(JSON.stringify(references)).not.toContain("Internal runtime workspace");
    expect(JSON.stringify(references)).not.toContain(hiddenConversations.id);
    expect(JSON.stringify(references)).not.toContain(archived.id);
  });
});
