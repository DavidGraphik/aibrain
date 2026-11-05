import { BackgroundModelAdmissionDeferred } from "@/runtime/model-turn-queue";
import { WorkerTurnRecoveryPendingError } from "@/runtime/worker-turn-recovery-error";
import { createHash } from "node:crypto";
import type { AuthSession } from "@/auth/types";
import type { InstallationConfig } from "@/config/installation-schema";
import type { ChatMessage, ChatRequest, ChatStreamEvent } from "@/lib/chat-contract";
import { applyChatStreamEvent } from "@/lib/chat-contract";
import { readRuntimeConfig } from "@/runtime/config";
import { FileApprovalStore } from "@/runtime/approval-store";
import { LocalFileMemoryService } from "@/memory";
import { FileMemoryTurnAuditSink } from "@/runtime/memory-turn";
import { resolveServerTurnPermissions } from "@/runtime/permission-turn";
import { runWorkerCodexTurn, type WorkerCodexTurnEvent } from "@/runtime/worker-codex-turn";
import {
  archiveGeneratedAutomationResult,
  beginThreadTurn,
  createThread,
  finishThreadTurn,
  getThread,
  getThreadRuntimeContext,
  updateThread,
} from "@/workbench/store";
import type { AutomationTask } from "@/automations/contracts";
import { FileAutomationAudienceStore } from "@/automations/audience-store";
import { authorizedConnectorMentionIdsForTurn } from "@/connectors/mentions";
import { featurePolicyForIdentity } from "@/settings/server-service";
import { awaitHostTurn, hostFailure } from "@/automations/host-analysis/outcome";
import { hostExecution } from "@/automations/host-analysis/execution";
import { turnDocumentChatAttachments } from "@/documents/turn-attachments";
import { createAutomationEffectAuthorization } from "@/automations/authorized-effects";
import { createAutomationRunState } from "@/automations/run-state";
import { scheduledTurnOptions } from "@/automations/execution-context";
import { automationResultNeedsReview } from "@/automations/result-review";
import { WorkbenchNotFoundError } from "@/workbench/errors";
import { automationTaskThreadId } from "./run-identities";
import { capacityContinuationKey } from "@/automations/capacity-continuation";

function stableUuid(value: string) {
  const bytes = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  bytes[12] = "4";
  bytes[16] = "8";
  const hex = bytes.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function message(id: string, role: ChatMessage["role"], content: string, status: ChatMessage["status"], createdAt: string): ChatMessage {
  return {
    id,
    role,
    content,
    status,
    createdAt,
    activity: [],
    plan: [],
    approvals: [],
    diff: "",
    attachments: [],
    artifacts: [],
    sources: [],
    toolResults: [],
  };
}

export type ScheduledExecutionInput = {
  installation: Readonly<InstallationConfig>;
  session: AuthSession;
  task: AutomationTask;
  runKey: string;
  existingThreadId?: string | null;
  onThreadPrepared?: (threadId: string) => Promise<void>;
  signal?: AbortSignal;
};

/** Executes the prompt as a real persistent AiBrain turn. It never sends an external message by itself. */
export async function executeScheduledTurn(input: ScheduledExecutionInput) {
  if (input.task.installationId !== input.installation.installationId || input.task.userId !== input.session.user.id || input.session.tenant.id !== input.installation.installationId) {
    throw new Error("La automatización no pertenece a este empleado o instalación.");
  }
  const host = input.task.schedule.kind === "external" ? await hostExecution(input) : null;
  try { return await executeTurn(input, host); } finally { host?.dispose(); }
}

async function executeTurn(input: ScheduledExecutionInput, host: Awaited<ReturnType<typeof hostExecution>> | null) {
  // The worker constructs its session from the installation's provisioned
  // employee record; retain this boundary immediately before a durable task
  // can enter the runtime as defence in depth against tenant/user mix-ups.
  if (input.task.installationId !== input.installation.installationId || input.task.userId !== input.session.user.id) {
    throw new Error("La automatización no pertenece a este empleado o instalación.");
  }
  const signal = host?.signal ?? input.signal ?? new AbortController().signal;
  const recurringThreadId = automationTaskThreadId(input.task);
  let preparedThreadId = input.existingThreadId ?? null;
  if (!preparedThreadId && recurringThreadId) {
    try {
      const existing = await getThread(input.session, recurringThreadId);
      if (existing.projectId !== input.task.projectId) throw Error("AUTOMATION_THREAD_SCOPE_CONFLICT");
      // A later scheduled result returns to its designated conversation even
      // after the owner archived it, without creating another sidebar entry.
      if (existing.status === "archived") await updateThread(input.session, existing.id, {status:"active"});
      preparedThreadId = existing.id;
    } catch (error) { if (!(error instanceof WorkbenchNotFoundError)) throw error; }
  }
  if (!preparedThreadId) {
    const thread = await createThread(input.session, input.task.projectId, `Programada · ${input.task.name}`, {
      // Creation and crash recovery converge before the run journal is saved.
      id: recurringThreadId ?? stableUuid(`${input.runKey}:workbench-thread`),
    });
    preparedThreadId = thread.id;
  }
  if (!preparedThreadId) throw new Error("No se ha podido preparar la conversación programada.");
  const threadId = preparedThreadId;
  await input.onThreadPrepared?.(threadId);
  // One durable delivery manifest per occurrence. Recipient membership is
  // intentionally not copied here: every read resolves the task's current
  // user/group selectors so later removals revoke access immediately.
  await new FileAutomationAudienceStore({
    installationId: input.installation.installationId,
    dataRoot: input.installation.paths.dataRoot,
  }).record({
    runKey: input.runKey,
    taskId: input.task.id,
    ownerUserId: input.task.userId,
    projectId: input.task.projectId,
    threadId,
  });
  const runState = host ? undefined : await createAutomationRunState({installation:input.installation,session:input.session,task:input.task,runKey:input.runKey,signal,threadId});
  const prompt = host?.message ?? input.task.prompt;
  const existingMessages = (input.existingThreadId || recurringThreadId) && !host ? (await getThread(input.session, threadId)).messages : [];
  const submissionKey = capacityContinuationKey(input.task, input.runKey, existingMessages, stableUuid);
  const userMessageId = stableUuid(`${submissionKey}:user`);
  const assistantMessageId = stableUuid(`${submissionKey}:assistant`);
  const resultNeedsReview = (result: ChatMessage) => automationResultNeedsReview(result, threadId);
  const materializeQuietReceipt = async (result: ChatMessage, recoverPrepared = false) => {
    if (!runState || result.status !== "complete" || result.content.trim() || resultNeedsReview(result)) return result;
    // The model may correctly finish without text after finish_quiet. Require
    // its durable, lease-validated server authorization, then persist a minimal
    // receipt so the normal nonempty terminal/readback boundary stays intact.
    if (!await runState.quietResult({recoverPrepared})) return result;
    return {...result, content: "Revisión completada sin novedades."};
  };
  const assertPersistedResult = async (result: ChatMessage) => {
    if (result.status !== "complete" || !result.content.trim()) {
      throw new Error(result.content || "La ejecución programada terminó sin un resultado visible.");
    }
    const persisted = await getThread(input.session, threadId);
    const persistedPrompt = persisted.messages.find(({ id }) => id === userMessageId);
    const persistedResult = persisted.messages.find(({ id }) => id === assistantMessageId);
    if (persistedPrompt?.role !== "user" || persistedPrompt.content !== prompt ||
        persistedResult?.role !== "assistant" || persistedResult.status !== "complete" ||
        persistedResult.content !== result.content) {
      throw new Error("La conversación programada no conserva el prompt y el resultado terminal.");
    }
  };
  const stateCloseout = async (content:string,recoverPrepared=false) => {
    if(!runState)return {};
    const resultHash=createHash("sha256").update(content).digest("hex");
    const outcome=await runState.finalize(resultHash,{recoverPrepared});
    return {finalize:async(persist:()=>Promise<void>)=>{
      if(outcome.quiet && (threadId === recurringThreadId || await archiveGeneratedAutomationResult(input.session,input.runKey,{projectId:input.task.projectId,prompt:input.task.prompt,resultHash}))) {
        await new FileAutomationAudienceStore({installationId:input.installation.installationId,dataRoot:input.installation.paths.dataRoot}).markQuiet({runKey:input.runKey,taskId:input.task.id,ownerUserId:input.task.userId,projectId:input.task.projectId,threadId});
      }
      await persist();
    }};
  };
  // A previous process may have archived a quiet result just before its task
  // settlement. Recover its proven terminal message without resuming an archived
  // runtime thread or repeating the model/source read.
  if(!host&&(input.existingThreadId || recurringThreadId)){
    const persisted=await getThread(input.session,threadId);
    const user=persisted.messages.find(item=>item.id===userMessageId);
    const assistant=persisted.messages.find(item=>item.id===assistantMessageId);
    if(persisted.projectId===input.task.projectId&&user?.role==="user"&&user.status==="complete"&&user.content===input.task.prompt&&assistant?.role==="assistant"&&assistant.status==="complete") {
      const recovered = await materializeQuietReceipt(assistant, true);
      if (recovered !== assistant) await finishThreadTurn(input.session, threadId, recovered, null);
      await assertPersistedResult(recovered);
      if (resultNeedsReview(recovered)) await runState?.requireVisible("result-needs-review");
      return {threadId,...await stateCloseout(recovered.content,true)};
    }
  }
  const persistedContext = await getThreadRuntimeContext(input.session, threadId);
  // The durable UI conversation is an archive of results, not unbounded model
  // context. Each occurrence starts a fresh runtime with its bounded private
  // automation state, rather than replaying every preceding report.
  const context = recurringThreadId === threadId
    ? {...persistedContext, runtimeThreadToken:null, branchHistory:null}
    : persistedContext;
  if (context.projectId !== input.task.projectId) throw new Error("El proyecto de la automatización ha cambiado.");
  const runtimeConfig = readRuntimeConfig(input.installation.installationId, context.workspaceKey);
  if (runtimeConfig.mode !== "codex") throw new Error("El runtime real de Codex no está activo.");
  const featurePolicy = await featurePolicyForIdentity(input.installation.installationId, input.session.user.id);
  if ((!host || host.policy.webSearch) && !featurePolicy["web-search"]) {
    throw new Error("La búsqueda web de esta automatización ya no está autorizada para el usuario.");
  }
  const connectorMentions = !host && input.task.executionContext.inheritAuthorizedConnectors
    ? await authorizedConnectorMentionIdsForTurn(input.session)
    : [];

  const startedAt = new Date().toISOString();
  const request: ChatRequest = {
    projectId: input.task.projectId,
    threadId,
    userMessageId,
    assistantMessageId,
    message: prompt,
    preferences: { tone: host ? "direct" : "balanced", language: "es", showActivity: true },
    options: scheduledTurnOptions({
      skillsAuthorized: !host && input.task.executionContext.inheritAuthorizedSkills && featurePolicy.skills,
      connectorMentions,
    }),
  };
  if (host) request.options = { ...request.options, experience: "smart", model: null, effort: null,
    webSearch: host.policy.webSearch, inheritAuthorizedSkills: false, connectorMentions: [] };
  const permissions = await resolveServerTurnPermissions(input.installation, {
    installationId: input.installation.installationId, userId: input.session.user.id,
    projectId: input.task.projectId, turnId: assistantMessageId,
  });
  const documents = host ? await host.documents(threadId, permissions) : [];
  if (host) request.options.documentUploadIds = documents.map(({ document }) => document.uploadId);
  const userMessage = message(userMessageId, "user", prompt, "complete", startedAt);
  userMessage.attachments = turnDocumentChatAttachments(documents);
  let assistantMessage = message(assistantMessageId, "assistant", "", "streaming", new Date(Date.now() + 1).toISOString());
  const begun = await beginThreadTurn(
    input.session,
    threadId,
    userMessage,
    assistantMessage,
    { retryExistingFailure: true },
  );
  assistantMessage = begun.assistantMessage;
  if (begun.outcome === "existing" && assistantMessage.status !== "streaming") {
    if (assistantMessage.status !== "complete") throw new Error(assistantMessage.content || "La ejecución anterior falló.");
    if (host) await host.validate(assistantMessage.content, threadId, true);
    const recovered = await materializeQuietReceipt(assistantMessage, true);
    if (recovered !== assistantMessage) await finishThreadTurn(input.session, threadId, recovered, null);
    assistantMessage = recovered;
    await assertPersistedResult(assistantMessage);
    if (resultNeedsReview(assistantMessage)) await runState?.requireVisible("result-needs-review");
    return { threadId, ...(host ? { deadlineAt: host.terminalDeadlineAt, finalize: host.finalize } : await stateCloseout(assistantMessage.content,true)) };
  }

  const approvals = new FileApprovalStore({
    installationId: input.installation.installationId,
    userId: input.session.user.id,
    usersRoot: input.installation.paths.usersRoot,
  });
  const memory = {
    memoryService: new LocalFileMemoryService({ config: input.installation }),
    auditSink: new FileMemoryTurnAuditSink({
      installationId: input.installation.installationId,
      userId: input.session.user.id,
      usersRoot: input.installation.paths.usersRoot,
    }),
  };
  let runtimeThreadToken: string | null = null;
  let hostEventsClosed = false;
  let runtimeFailure: string | undefined;
  let runtimeStopped = false;
  let hostFailureCode: string | undefined;
  const emit = async (event: WorkerCodexTurnEvent) => {
    if (host && (hostEventsClosed || signal.aborted)) return;
    if (event.type === "error") runtimeFailure = event.message;
    if (event.type === "stopped") runtimeStopped = true;
    if (event.type === "runtimeThread") {
      runtimeThreadToken = event.threadToken;
      return;
    }
    if (event.type === "runtimeTurn" || event.type === "runtimeUsage") return;
    assistantMessage = applyChatStreamEvent(assistantMessage, event as ChatStreamEvent);
  };

  const authorizedAutomationEffects = host ? undefined : await createAutomationEffectAuthorization({ installation: input.installation, session: input.session, task: input.task, runKey: input.runKey, localTurnId: assistantMessageId, permissions, signal });
  try {
    const run = () => runWorkerCodexTurn(
      request,
      input.installation.installationId,
      input.session.user.id,
      null,
      runtimeConfig,
      permissions,
      approvals,
      memory,
      documents,
      signal,
      emit,
      undefined,
      input.installation.branding.productName,
      context,
      undefined,
      undefined,
      undefined,
      input.session,
      true,
      null,
      begun.outcome === "existing",
      host?.policy,
      undefined,
      authorizedAutomationEffects,
      runState,
    );
    if (host) await awaitHostTurn(run, signal);
    else await run();
    if (host) {
      if (assistantMessage.approvals.length) throw Error("AUTOMATION_NON_READ_ONLY_RESULT");
      if (assistantMessage.status !== "complete") throw Error(runtimeFailure ?? (assistantMessage.status === "stopped" ? "HOST_ANALYSIS_STOPPED" : "HOST_MODEL_ERROR"));
      assistantMessage = { ...assistantMessage, content: await host.validate(assistantMessage.content, threadId) };
    }
  } catch (error) {
    // No provider turn or tool dispatched. Preserve the deterministic pending
    // conversation for scheduler admission instead of materializing a failure.
    if(error instanceof BackgroundModelAdmissionDeferred)throw error;
    // A confirmed result can still be waiting for its background-writer handoff.
    // Keep that exact durable turn recoverable instead of replacing it with an
    // error whose text is the already completed answer. Genuine runtime failures,
    // cancellation and host-deadline failures retain their existing boundaries.
    if (!host && error instanceof WorkerTurnRecoveryPendingError && !runtimeFailure && !runtimeStopped && !signal.aborted) throw error;
    if (host) {
      const failure = hostFailure(error, signal);
      hostFailureCode = failure.code;
      assistantMessage = { ...assistantMessage,
        content: assistantMessage.content || `${failure.label} (${failure.code})`,
        toolResults: assistantMessage.toolResults?.map(item => item.status === "running" ? { ...item, status: "stopped" as const } : item),
        activity: [...assistantMessage.activity.map(item => item.status === "running" || item.status === "waiting" ? { ...item, status: "stopped" as const } : item),
          { id: "host-analysis-outcome", kind: "system", status: "failed", label: failure.label, detail: failure.code,
            ...(failure.output || failure.cancellation ? { output: [failure.output, failure.cancellation].filter(Boolean).join("\n") } : {}) }],
      };
    }
    assistantMessage = applyChatStreamEvent(assistantMessage, {
      type: "error",
      message: error instanceof Error ? error.message : "La ejecución programada ha fallado.",
    });
  } finally {
    hostEventsClosed = true;
  }
  // A late done event must not turn a real failed/stopped run into quiet success.
  if (!host && runtimeFailure) assistantMessage = applyChatStreamEvent(assistantMessage, {type:"error",message:runtimeFailure});
  else if (!host && runtimeStopped) assistantMessage = applyChatStreamEvent(assistantMessage, {type:"stopped"});
  if (assistantMessage.status === "streaming") assistantMessage = { ...assistantMessage, status: "error" };
  assistantMessage = await materializeQuietReceipt(assistantMessage, begun.outcome === "existing");
  await finishThreadTurn(input.session, threadId, assistantMessage, runtimeThreadToken);
  if (hostFailureCode) throw Error(hostFailureCode);
  await assertPersistedResult(assistantMessage);
  if(runState && resultNeedsReview(assistantMessage)) await runState.requireVisible("result-needs-review");
  return { threadId, ...(host ? { deadlineAt: host.terminalDeadlineAt, finalize: host.finalize } : await stateCloseout(assistantMessage.content, begun.outcome === "existing")) };
}
