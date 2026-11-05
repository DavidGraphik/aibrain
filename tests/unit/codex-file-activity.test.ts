import { describe, expect, it } from "vitest";
import { itemActivity } from "@/runtime/codex-app-server";

describe("Codex file activity", () => {
  it("preserves exact file paths and change kinds for the in-chat viewer", () => {
    expect(itemActivity({
      item: {
        id: "file-change-1",
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "src/components/example.tsx", kind: { type: "update", move_path: null }, diff: "" },
          { path: "public/preview.png", kind: { type: "add" }, diff: "" },
          { path: "src/obsolete.ts", kind: { type: "delete" }, diff: "" },
        ],
      },
    }, true)).toMatchObject({
      kind: "file",
      status: "complete",
      files: [
        { path: "src/components/example.tsx", change: "update" },
        { path: "public/preview.png", change: "add" },
        { path: "src/obsolete.ts", change: "delete" },
      ],
    });
  });

  it("drops host paths and traversal from employee-visible file activity", () => {
    const activity = itemActivity({
      item: {
        id: "file-change-sensitive",
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "/var/lib/aibrain/data/users/user-a/private.txt", kind: { type: "update" } },
          { path: "../other-user/private.txt", kind: { type: "update" } },
          { path: "documents/report.pdf", kind: { type: "add" } },
        ],
      },
    }, true);
    expect(activity?.files).toEqual([{ path: "documents/report.pdf", change: "add" }]);
    expect(activity?.detail).toBe("documents/report.pdf");
  });
});
