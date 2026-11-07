import { describe, expect, it } from "vitest";
import { isWorkbenchProject, isWorkbenchThread, workbenchThreadAccess, type WorkbenchProject } from "@/workbench/types";

const project: WorkbenchProject = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Operaciones",
  slug: "operaciones",
  status: "active",
  pinned: false,
  instructions: "",
  sources: [],
  memory: { enabled: true, notes: "", updatedAt: null },
  sharing: { visibility: "private", members: [] },
  workspace: {
    id: "00000000-0000-4000-8000-000000000002",
    label: "Operaciones",
    hostType: "managed",
    status: "ready",
    isPrimary: true,
  },
  createdAt: "2026-08-30T08:00:00.000Z",
  updatedAt: "2026-08-30T08:00:00.000Z",
};

describe("workbench project access projection", () => {
  it("uses conversation capabilities ahead of project edit rights and fails closed without either", () => {
    const viewer = { role: "viewer" as const, canEdit: false, canManage: false };
    expect(workbenchThreadAccess({ access: viewer }, project)).toEqual(viewer);
    expect(workbenchThreadAccess({}, null)).toEqual(viewer);
    expect(workbenchThreadAccess(null, project).canEdit).toBe(true);
    const thread = { id: project.id, projectId: project.id, title: "Saved", status: "active", pinned: false,
      createdAt: project.createdAt, updatedAt: project.updatedAt, messages: [], access: viewer };
    expect(isWorkbenchThread(thread)).toBe(true);
    expect(isWorkbenchThread({ ...thread, access: { ...viewer, canEdit: true } })).toBe(false);
  });
  it("accepts legacy projects and coherent server-issued capability sets", () => {
    expect(isWorkbenchProject(project)).toBe(true);
    expect(isWorkbenchProject({
      ...project,
      access: { role: "viewer", canEdit: false, canManage: false },
    })).toBe(true);
    expect(isWorkbenchProject({
      ...project,
      access: { role: "editor", canEdit: true, canManage: false },
    })).toBe(true);
  });

  it("rejects contradictory or expanded capability projections", () => {
    expect(isWorkbenchProject({
      ...project,
      access: { role: "viewer", canEdit: true, canManage: false },
    })).toBe(false);
    expect(isWorkbenchProject({
      ...project,
      access: { role: "owner", canEdit: true, canManage: true, foreign: true },
    })).toBe(false);
  });
});
