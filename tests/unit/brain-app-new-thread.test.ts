import { describe, expect, it } from "vitest";
import {
  composerDraftKey,
  newThreadDestination,
  parseComposerDrafts,
} from "@/components/brain-app";
import { STANDALONE_PROJECT_SLUG, type WorkbenchProject } from "@/workbench/types";

function project(id: string, slug: string): WorkbenchProject {
  return {
    id,
    name: slug === STANDALONE_PROJECT_SLUG ? "Conversaciones" : "Operaciones Arnall",
    slug,
    status: "active",
    pinned: false,
    instructions: "",
    sources: [],
    memory: { enabled: true, notes: "", updatedAt: null },
    sharing: { visibility: "private", members: [] },
    workspace: { id: `${id}-workspace`, label: "Principal", hostType: "managed", status: "ready", isPrimary: true },
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

describe("new conversation destination", () => {
  const standalone = project("standalone", STANDALONE_PROJECT_SLUG);
  const arnall = project("arnall", "operaciones-arnall");

  it("uses the requested project for its next thread and reserves no-id for Sin proyecto", () => {
    expect(newThreadDestination([standalone, arnall], arnall.id)?.id).toBe(arnall.id);
    expect(newThreadDestination([standalone, arnall])?.id).toBe(standalone.id);
  });

  it("keeps bounded drafts isolated by project and thread", () => {
    expect(composerDraftKey("project-a", "thread-a")).toBe("project-a:thread-a");
    expect(composerDraftKey("project-a", null)).toBe("project-a:new");
    expect(parseComposerDrafts(JSON.stringify({
      "project-a:thread-a": "Draft A",
      "project-a:new": "Draft B",
      unsafe: 42,
    }))).toEqual({
      "project-a:thread-a": "Draft A",
      "project-a:new": "Draft B",
    });
    expect(parseComposerDrafts("not-json")).toEqual({});
  });
});
