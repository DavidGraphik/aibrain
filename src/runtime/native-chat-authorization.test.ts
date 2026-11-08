import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { nativeRequestWithinChatScope } from "./native-chat-authorization";
it("accepts ordinary existing-workspace requests and denies extra grants, network, policies and foreign targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-chat-scope-"));
  try {
    const workspace = path.join(root, "workspace"), outside = path.join(root, "outside");
    await mkdir(workspace); await mkdir(outside); await symlink(outside, path.join(workspace, "escape"));
    const regular = { command: "touch requested.txt", cwd: workspace };
    expect(await nativeRequestWithinChatScope("command", regular, workspace, "workspace-write")).toBe(true);
    expect(await nativeRequestWithinChatScope("file", {}, workspace, "workspace-write")).toBe(true);
    for (const patch of [{ cwd: outside }, { cwd: path.join(workspace, "escape") }, { additionalPermissions: {} }, { networkApprovalContext: {} }, { proposedExecpolicyAmendment: ["python"] }, { proposedNetworkPolicyAmendments: [] }, { environmentId: "foreign" }, { kind: "writeStdin" }, { reason: "Run outside sandbox" }, { availableDecisions: ["acceptForSession"] }])
      expect(await nativeRequestWithinChatScope("command", { ...regular, ...patch }, workspace, "workspace-write")).toBe(false);
    expect(await nativeRequestWithinChatScope("permissions", {}, workspace, "workspace-write")).toBe(false);
    expect(await nativeRequestWithinChatScope("file", { grantRoot: "/" }, workspace, "workspace-write")).toBe(false);
    expect(await nativeRequestWithinChatScope("command", regular, workspace, "read-only")).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
