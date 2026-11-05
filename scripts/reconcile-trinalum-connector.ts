import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadInstallationConfig } from "@/config/installation";
import { FileLocalUserStore } from "@/auth/local-user-store";
import { FileWorkbenchStore } from "@/workbench/filesystem-store";
import { workbenchThreadAccess } from "@/workbench/types";
import { FileApprovalStore } from "@/runtime/approval-store";
import { TrinalumChatActions, type ChatAction } from "@/runtime/trinalum-chat-actions";
import { readThreadTokenContext } from "@/runtime/thread-token";
import { resolveServerTurnPermissions, permissionAllowsGenericToolExecution } from "@/runtime/permission-turn";
import { reconcileTrinalumConnectorDisposition } from "@/runtime/trinalum-connector-reconciliation";
import { readRegularFileWithin } from "@/security/safe-file";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function reconciliationArguments(args: string[]) {
  const [command, ...rest] = args;
  if (!["inspect", "reconcile"].includes(command) || rest.length % 2) throw Error("RECONCILIATION_ARGUMENTS_INVALID");
  const values: Record<string, string> = {};
  const required = ["user-id", "workbench-thread-id", "runtime-thread-id", "action-id", "category"];
  if (command === "reconcile") required.push("expected-upper-sha256", "expected-chat-sha256");
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index].replace(/^--/, "");
    if (rest[index] !== `--${key}` || !required.includes(key) || values[key] || !rest[index + 1] || rest[index + 1].startsWith("--")) throw Error("RECONCILIATION_ARGUMENTS_INVALID");
    values[key] = rest[index + 1];
  }
  if (required.some(key => !values[key]) || !["no-dispatch", "definitive-rejection"].includes(values.category) ||
      !/^[0-9a-f-]{36}$/.test(values["user-id"]) || !/^[0-9a-f-]{36}$/.test(values["workbench-thread-id"]) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(values["runtime-thread-id"]) || !/^web-[a-f0-9]{64}$/.test(values["action-id"]) ||
      command === "reconcile" && [values["expected-upper-sha256"], values["expected-chat-sha256"]].some(value => !/^[a-f0-9]{64}$/.test(value))) throw Error("RECONCILIATION_ARGUMENTS_INVALID");
  return { command, values, category: values.category as "no-dispatch" | "definitive-rejection" };
}

export async function runReconciliationOperator(args: string[]) {
  const { command, values: v, category } = reconciliationArguments(args); // Validate before any data/config read.
  const installation = await loadInstallationConfig();
  if (installation.installationId !== "trinalum-production") throw Error("RECONCILIATION_INSTALLATION_INVALID");
  // Fail before workbench/permission services can create anything as root.
  const owner = await lstat(path.join(installation.paths.usersRoot, v["user-id"]));
  if (typeof process.getuid !== "function" || process.getuid() === 0 || owner.uid !== process.getuid() || owner.isSymbolicLink() || !owner.isDirectory()) throw Error("RECONCILIATION_SERVICE_IDENTITY_REQUIRED");
  const bridgePath = process.env.AIBRAIN_TRINALUM_BRIDGE_CONFIG;
  if (!bridgePath || !path.isAbsolute(bridgePath)) throw Error("RECONCILIATION_CONFIG_UNAVAILABLE");
  const store = FileWorkbenchStore.fromInstallation(installation);
  const approvals = new FileApprovalStore({ installationId: installation.installationId, userId: v["user-id"], usersRoot: installation.paths.usersRoot });
  const actions = new TrinalumChatActions(approvals.userRoot, { installationId: installation.installationId, userId: v["user-id"], threadId: v["runtime-thread-id"] });
  const action = await actions.read(v["action-id"]);
  if (!action || action.operation !== "attio_action") throw Error("RECONCILIATION_ACTION_INVALID");
  const verifyCurrentGrant = async (original: ChatAction) => {
    const user = await new FileLocalUserStore(installation.paths.usersRoot).read(v["user-id"]);
    const thread = await store.getThread(v["user-id"], v["workbench-thread-id"]);
    const project = await store.getProject(v["user-id"], thread.projectId);
    const context = await store.getThreadRuntimeContext(v["user-id"], thread.id);
    if (!user?.enabled || thread.status !== "active" || project.status !== "active" || !workbenchThreadAccess(thread, project).canEdit ||
        !thread.messages.some(message => message.id === original.sourceTurnId && message.role === "assistant") ||
        !thread.messages.some(message => message.id === original.sourceMessageId && message.role === "user") ||
        !context.runtimeThreadToken || readThreadTokenContext(context.runtimeThreadToken, installation.installationId, user.userId)?.threadId !== original.threadId) throw Error("RECONCILIATION_THREAD_GRANT_CHANGED");
    const permissions = await resolveServerTurnPermissions(installation, { installationId: installation.installationId, userId: user.userId, projectId: project.id, turnId: original.sourceTurnId });
    if (!permissionAllowsGenericToolExecution(permissions) || permissions.fingerprint !== original.permissionFingerprint) throw Error("RECONCILIATION_GRANT_CHANGED");
    return { email: user.email, permissionFingerprint: permissions.fingerprint };
  };
  await verifyCurrentGrant(action);
  const inspected = await approvals.inspectConnectorApprovalForReconciliation(action.locator);
  if (!inspected) throw Error("RECONCILIATION_APPROVAL_MISSING");
  const chatBytes = await readRegularFileWithin(approvals.userRoot, path.join("trinalum-chat-actions", hash(action.threadId), `${action.id}.json`), 64 * 1024 * 1024);
  if (command === "inspect") return { version: 1, mode: "inspect", actionId: action.id, status: inspected.record.status,
    upperSha256: inspected.sha256, chatSha256: hash(chatBytes), expiresAt: inspected.record.expiresAt,
    unexpired: Date.parse(inspected.record.expiresAt) > Date.now() && Date.parse(action.expiresAt) > Date.now(),
    nativeProof: "not-acquired", providerDispatches: 0 };
  const result = await reconcileTrinalumConnectorDisposition({ store: approvals, actionId: action.id, runtimeThreadId: action.threadId,
    configPath: bridgePath, proofCategory: category, expectedRecordSha256: v["expected-upper-sha256"], expectedChatActionSha256: v["expected-chat-sha256"],
    operatorArtifactHash: hash(await readFile(process.argv[1])), verifyCurrentGrant });
  return { version: 1, mode: "reconcile", actionId: action.id, outcome: result.outcome, status: result.record.status, providerDispatches: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void runReconciliationOperator(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result)}\n`), error => {
    const code = typeof error?.code === "string" && /^[A-Z_]+$/.test(error.code) ? error.code :
      typeof error?.message === "string" && /^[A-Z_]+$/.test(error.message) ? error.message : "RECONCILIATION_UNAVAILABLE";
    process.stdout.write(`${JSON.stringify({ version: 1, ok: false, code })}\n`); process.exitCode = 2;
  });
}
