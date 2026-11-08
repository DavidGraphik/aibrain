import "server-only";
import path from "node:path";
import { realpath } from "node:fs/promises";

/** Approval may confirm an already allowed action, never widen its sandbox,
 * credential environment, network, persistent policy or writable roots. */
export async function nativeRequestWithinChatScope(requestType: string, params: Record<string, unknown>, workspace: string, sandbox: "read-only" | "workspace-write") {
  if (sandbox !== "workspace-write" || !["command", "file"].includes(requestType)) return false;
  for (const key of ["additionalPermissions", "networkApprovalContext", "proposedExecpolicyAmendment", "proposedNetworkPolicyAmendments", "grantRoot", "permissions", "sandboxPermissions", "sandbox_permissions", "environmentId"]) {
    if (params[key] !== undefined && params[key] !== null) return false;
  }
  if (typeof params.reason === "string" && params.reason.trim()) return false;
  if (params.kind !== undefined && params.kind !== "command") return false;
  if (params.availableDecisions !== undefined && params.availableDecisions !== null &&
      (!Array.isArray(params.availableDecisions) || !params.availableDecisions.includes("accept"))) return false;
  if (requestType === "file") return true;
  if (typeof params.command !== "string" || !params.command.trim()) return false;
  const cwd = params.cwd ?? workspace;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return false;
  try {
    const root = await realpath(workspace), actual = await realpath(cwd);
    return actual === root || actual.startsWith(`${root}${path.sep}`);
  } catch { return false; }
}
