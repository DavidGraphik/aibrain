"use client";
import { MAX_FILES_PER_MESSAGE } from "@/lib/chat-attachment-limits";
import { continuingDocumentUploads } from "@/lib/continuing-document-uploads";
import { g03ProductInstallation } from "@/g03-products/contracts";
import { useUiText } from "@/i18n/provider";

import { isServerReferenceList, type ServerReference } from "@/documents/server-reference-contract";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { AuthSession } from "@/auth/types";
import { ChatWorkspace } from "@/components/chat-workspace";
import { WorkbenchContent } from "@/components/workbench-content";
import { withOutreachPaneContext, type OutreachPaneContext } from "@/ui/outreach-context";
import { MAX_COMPOSER_TEXT_CHARS as MAX_COMPOSER_DRAFT_CHARS } from "@/lib/chat-input-limits";
import { LiveAnswerStore } from '@/ui/live-answer-store';
import { CommandPalette } from "@/components/command-palette";
import { CustomizationPanel } from "@/components/customization-panel";
import { DetailsPanel } from "@/components/details-panel";
import { DocumentPreviewPanel } from "@/components/document-preview-panel";
import { ProjectPanel } from "@/components/project-panel";
import { TaskCenterPanel } from "@/components/task-center-panel";
import { isEditableShortcutTarget, isTaskCenterShortcut } from "@/components/use-task-center-shortcut";
import {
  Sidebar,
  type ProjectMenuAction,
  type ThreadMenuAction,
} from "@/components/sidebar";
import { ConfirmDialog, TextDialog } from "@/components/workbench-dialogs";
import {
  cornerTokens,
  preferencesFromManifest,
  type BrainManifest,
  type BrainPreferences,
  type BrainWindowId,
} from "@/config/brain";
import {
  applyChatStreamEvent,
  approvalResolutionForItem,
  type ApprovalDecision,
  type ApprovalItem,
  type ChatMessage,
  type ChatAttachment,
  type ChatInputAttachment,
  type DocumentArtifact,
  type ToolResult,
} from "@/lib/chat-contract";
import {
  loadManagedAppCapability,
  managedAppActionKey,
  resolveManagedAppAction,
  type ManagedAppActionDescriptor,
  type ManagedAppActionOutcome,
  type ManagedAppActionTarget,
} from "@/ui/codex-managed-app-ui";
import {
  consumeRecoverableChatStream,
  type ChatStreamRecoveryState,
} from "@/ui/recoverable-chat-stream";
import { PendingTurnStop, readTurnTerminalAfterStop, stopControlAccepted } from "@/ui/pending-turn-stop";
import { createChatReattachRequest } from "@/ui/chat-reattach-request";
import { useStoredResponse } from "@/ui/use-stored-response";
import { useRuntimeStatus } from "@/ui/use-runtime-status";
import {
  ClientTurnPerformance,
  type ClientTurnPerformanceReadback,
} from "@/ui/client-turn-performance";
import { createChatEventFrameDispatcher } from "@/ui/frame-event-dispatcher";
import {
  stageDocument,
  type StagedComposerDocument,
} from "@/ui/document-ui-adapter";
import {
  decideDocumentPublication,
  freezeDocumentPublication,
  recoverDocumentPublications,
  type DocumentPublicationDraft,
} from "@/ui/publication-ui-adapter";
import {
  type RuntimeStatus,
} from "@/lib/runtime-status";
import {
  type ComposerExperience,
} from "@/lib/composer-experience";
import {
  branchThreadRequest,
  createProjectRequest,
  createThreadRequest,
  getThreadRequest,
  getProjectRequest,
  updateProjectRequest,
  updateThreadRequest,
} from "@/lib/workbench-api-client";
import {
  isWorkbenchSnapshot,
  STANDALONE_PROJECT_SLUG,
  workbenchProjectAccess,
  workbenchThreadAccess,
  type BranchThreadInput,
  type UpdateProjectInput,
  type UpdateThreadInput,
  type WorkbenchProject,
  type WorkbenchSnapshot,
  type WorkbenchThread,
} from "@/workbench/types";
import type { PublicInstallationBranding } from "@/config/installation-branding";
import { isConnectorMention, type ConnectorMention } from "@/connectors/mentions-contract";
import { isSettingsSnapshot, type SettingsSnapshot } from "@/settings/contracts";
import {
  getThreadActivity,
  isThreadReadMarker,
  latestThreadReadMarker,
  type ThreadActivity,
  type ThreadReadMarker,
} from "@/workbench/thread-activity";
import { useTaskCenter } from "@/components/use-task-center";

export { createTaskCenterResponseGate } from "./use-task-center";

type SideWindowId = Exclude<BrainWindowId, "chat" | "runtime">;
type WorkbenchNotice = Readonly<{
  message: string;
  kind: "status" | "success" | "warning" | "error";
}>;

function workbenchNotice(message: string, kind: WorkbenchNotice["kind"] = "status"): WorkbenchNotice {
  return { message, kind };
}

type BrainStyle = CSSProperties & {
  "--brain-accent": string;
  "--brain-accent-strong": string;
  "--brain-accent-on-soft": string;
  "--brain-accent-soft": string;
  "--notification-accent": string;
  "--brain-contrast": string;
  "--brain-radius": string;
};

type TextDialogState =
  | { kind: "create-project" }
  | { kind: "rename-project"; project: WorkbenchProject }
  | { kind: "rename-thread"; thread: WorkbenchThread };

type ConfirmDialogState =
  | { kind: "archive-project"; project: WorkbenchProject }
  | { kind: "archive-thread"; thread: WorkbenchThread }
  | { kind: "remove-thread"; thread: WorkbenchThread }
  | { kind: "undo-result"; message: ChatMessage };

type StreamRecoveryNotice = {
  admissionUnconfirmed?: boolean;
  threadId: string;
  assistantMessageId: string;
  attempt: number | null;
};

type QueuedChatTurn = {
  id: string;
  projectId: string;
  threadId: string;
  runtimeContent: string;
  displayContent: string;
};

type StoredSelection = {
  activeProjectId: string | null;
  threadByProject: Record<string, string>;
};

export type ManagedAppActionRegistry = Readonly<Record<string, ManagedAppActionDescriptor>>;

export function managedAppApprovalKey(locator: Pick<ManagedAppActionTarget, "threadId" | "turnId" | "itemId" | "approvalId"> | ApprovalItem) {
  return managedAppActionKey({
    threadId: locator.threadId,
    turnId: locator.turnId,
    itemId: locator.itemId,
    approvalId: "approvalId" in locator ? locator.approvalId : locator.id,
  });
}

export function rememberManagedAppAction(
  registry: ManagedAppActionRegistry,
  descriptor: ManagedAppActionDescriptor,
): ManagedAppActionRegistry {
  return { ...registry, [managedAppApprovalKey(descriptor.locator)]: descriptor };
}

export function managedAppActionForApproval(
  registry: ManagedAppActionRegistry,
  approval: ApprovalItem,
) {
  return registry[managedAppApprovalKey(approval)] ?? null;
}

export function forgetManagedAppAction(
  registry: ManagedAppActionRegistry,
  approval: ApprovalItem,
): ManagedAppActionRegistry {
  const key = managedAppApprovalKey(approval);
  if (!registry[key]) return registry;
  const { [key]: _removed, ...retained } = registry;
  return retained;
}

function managedAppOutcomeResult(approvalId: string, outcome: ManagedAppActionOutcome): ToolResult {
  const completed = outcome === "executed" || outcome === "replayed";
  return {
    id: `managed-app:${approvalId}`,
    kind: "app",
    title: "Acción conectada",
    status: completed ? "complete" : outcome === "denied" ? "stopped" : "failed",
    summary: outcome,
    output: null,
    sourceIds: [],
    createdAt: new Date().toISOString(),
  };
}

const MAX_CLIENT_TURN_READBACKS = 24;
const MAX_QUEUED_MESSAGES_PER_THREAD = 8;

function retainClientTurnReadback(
  current: Record<string, ClientTurnPerformanceReadback>,
  messageId: string,
  readback: ClientTurnPerformanceReadback,
) {
  const next = { ...current, [messageId]: readback };
  const ids = Object.keys(next);
  while (ids.length > MAX_CLIENT_TURN_READBACKS) {
    const oldest = ids.shift();
    if (oldest) delete next[oldest];
  }
  return next;
}

function createMessage(
  id: string,
  role: ChatMessage["role"],
  content: string,
  status: ChatMessage["status"],
  createdAt: string,
): ChatMessage {
  return {
    id,
    role,
    content,
    createdAt,
    status,
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

function titleFromMessage(message: string) {
  const clean = message.replace(/\s+/g, " ").trim();
  return clean.length > 52 ? `${clean.slice(0, 49)}…` : clean;
}

function publicationTarget(fileName: string) {
  const safeName = fileName.replace(/[\\/\u0000-\u001f\u007f]/g, "-").trim() || "documento";
  return `knowledge/${safeName}`;
}

function byPriority<Item extends { pinned: boolean; updatedAt: string }>(a: Item, b: Item) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return b.updatedAt.localeCompare(a.updatedAt);
}

function firstActiveThread(threads: WorkbenchThread[], projectId: string) {
  return threads
    .filter((thread) => thread.projectId === projectId && thread.status === "active")
    .sort(byPriority)[0] ?? null;
}

function updateThreadMessage(
  threads: WorkbenchThread[],
  threadId: string,
  messageId: string,
  updater: (message: ChatMessage) => ChatMessage,
) {
  const now = new Date().toISOString();
  let changed = false;
  const updated = threads.map(thread => {
    if (thread.id !== threadId) return thread;
    let messageChanged = false;
    const messages = thread.messages.map(message => {
      if (message.id !== messageId) return message;
      const next = updater(message);
      if (next !== message) messageChanged = true;
      return next;
    });
    if (!messageChanged) return thread;
    changed = true;
    return { ...thread, updatedAt: now, messages };
  });
  return changed ? updated : threads;
}

function loadPreferences(key: string, defaults: BrainPreferences): BrainPreferences {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!stored || typeof stored !== "object") return defaults;

    return {
      ...defaults,
      ...("assistantName" in stored && typeof stored.assistantName === "string"
        ? { assistantName: stored.assistantName }
        : {}),
      ...("tone" in stored && (stored.tone === "direct" || stored.tone === "balanced" || stored.tone === "detailed")
        ? { tone: stored.tone }
        : {}),
      ...("accent" in stored && (stored.accent === "graphite" || stored.accent === "blue" || stored.accent === "violet")
        ? { accent: stored.accent }
        : {}),
      ...("density" in stored && (stored.density === "comfortable" || stored.density === "compact")
        ? { density: stored.density }
        : {}),
      ...("corners" in stored && (stored.corners === "soft" || stored.corners === "rounded" || stored.corners === "precise")
        ? { corners: stored.corners }
        : {}),
      ...("showInspector" in stored && typeof stored.showInspector === "boolean"
        ? { showInspector: stored.showInspector }
        : {}),
      ...("showActivityPanel" in stored && typeof stored.showActivityPanel === "boolean"
        ? { showActivityPanel: stored.showActivityPanel }
        : {}),
      ...("conversationMemory" in stored && typeof stored.conversationMemory === "boolean"
        ? { conversationMemory: stored.conversationMemory }
        : {}),
    };
  } catch {
    return defaults;
  }
}

function loadPreviewSnapshot(key: string, fallback: WorkbenchSnapshot) {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (isWorkbenchSnapshot(stored) && stored.persistence === "browser-preview") {
      return {
        ...stored,
        threads: stored.threads.map((thread) => ({
          ...thread,
          messages: thread.messages.map((message) => message.status === "streaming"
            ? { ...message, status: "stopped" as const }
            : message),
        })),
      };
    }
  } catch {
    // A damaged preview cache is replaced by the server-provided seed.
  }
  return fallback;
}

function loadSelection(key: string): StoredSelection {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!stored || typeof stored !== "object") throw new Error("invalid");
    const activeProjectId = "activeProjectId" in stored &&
      (stored.activeProjectId === null || typeof stored.activeProjectId === "string")
      ? stored.activeProjectId
      : null;
    const threadByProject: Record<string, string> = {};
    if ("threadByProject" in stored && stored.threadByProject &&
      typeof stored.threadByProject === "object" && !Array.isArray(stored.threadByProject)) {
      for (const [projectId, threadId] of Object.entries(stored.threadByProject)) {
        if (typeof threadId === "string") threadByProject[projectId] = threadId;
      }
    }
    return { activeProjectId, threadByProject };
  } catch {
    return { activeProjectId: null, threadByProject: {} };
  }
}

function loadThreadReadMarkers(key: string, threads: WorkbenchThread[]) {
  let stored: Record<string, ThreadReadMarker> = {};
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      stored = Object.fromEntries(Object.entries(value).filter(
        (entry): entry is [string, ThreadReadMarker] => isThreadReadMarker(entry[1]),
      ));
    }
  } catch {
    // A damaged marker cache is replaced with the visible snapshot below.
  }

  for (const thread of threads) {
    if (stored[thread.id]) continue;
    const marker = latestThreadReadMarker(thread);
    if (marker) stored[thread.id] = marker;
  }
  return stored;
}

function localProject(projects: WorkbenchProject[], name: string): WorkbenchProject {
  const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "projecte";
  const used = new Set(projects.map((project) => project.slug));
  let slug = normalized.slice(0, 55);
  let suffix = 2;
  while (used.has(slug)) {
    slug = `${normalized.slice(0, 50)}-${suffix}`;
    suffix += 1;
  }
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: name.trim(),
    slug,
    status: "active",
    pinned: false,
    instructions: "",
    sources: [],
    memory: { enabled: true, notes: "", updatedAt: null },
    sharing: { visibility: "private", members: [] },
    workspace: {
      id: crypto.randomUUID(),
      label: "Workspace principal",
      hostType: "managed",
      status: "ready",
      isPrimary: true,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function localThread(projectId: string, title: string): WorkbenchThread {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    projectId,
    title,
    status: "active",
    pinned: false,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

export function newThreadDestination(
  projects: readonly WorkbenchProject[],
  projectId?: string,
) {
  if (projectId) {
    return projects.find((project) => project.id === projectId && project.status === "active") ?? null;
  }
  return projects.find((project) =>
    project.slug === STANDALONE_PROJECT_SLUG && project.status === "active") ?? null;
}

const MAX_COMPOSER_DRAFTS = 50;

export function composerDraftKey(projectId: string | null, threadId: string | null) {
  return projectId ? `${projectId}:${threadId ?? "new"}` : "none:new";
}

export function parseComposerDrafts(value: string | null) {
  if (!value) return {} as Record<string, string>;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .filter(([key, draft]) => key.length <= 80 && typeof draft === "string" && draft.length <= MAX_COMPOSER_DRAFT_CHARS)
      .slice(-MAX_COMPOSER_DRAFTS)) as Record<string, string>;
  } catch {
    return {};
  }
}

function localBranchThread(parent: WorkbenchThread, input: BranchThreadInput) {
  const targetIndex = parent.messages.findIndex((message) => message.id === input.messageId);
  const target = parent.messages[targetIndex];
  if (!target) throw new Error("No se ha encontrado el mensaje.");
  let prefixEnd = targetIndex;
  let draftMessage: string | null = null;
  if (input.kind === "edit") {
    if (target.role !== "user" || !input.editedContent?.trim()) throw new Error("Este mensaje no se puede editar.");
    prefixEnd = targetIndex - 1;
    draftMessage = input.editedContent.trim();
  } else if (input.kind === "retry") {
    const userIndex = parent.messages.findLastIndex((message, index) => index < targetIndex && message.role === "user");
    if (target.role !== "assistant" || userIndex < 0) throw new Error("Esta respuesta no se puede regenerar.");
    prefixEnd = userIndex - 1;
    draftMessage = parent.messages[userIndex].content;
  } else if (target.role !== "assistant") throw new Error("La rama debe partir de una respuesta.");
  const suffix = input.kind === "edit" ? "editada" : input.kind === "retry" ? "regenerada" : "rama";
  return {
    thread: {
      ...localThread(parent.projectId, `${parent.title.replace(/ · (?:editada|regenerada|rama)$/u, "")} · ${suffix}`.slice(0, 120)),
      messages: structuredClone(parent.messages.slice(0, prefixEnd + 1)),
      lineage: { parentThreadId: parent.id, branchedFromMessageId: target.id, kind: input.kind },
    },
    draftMessage,
  };
}

export function BrainApp({
  branding,
  manifest,
  session,
  initialWorkbench,
  insijetsWorkspaceAccess = false,
  insijetsSourcingAccess = false,
  insijetsOutreachAccess = false,
}: {
  branding: Readonly<PublicInstallationBranding>;
  manifest: BrainManifest;
  session: AuthSession;
  initialWorkbench: WorkbenchSnapshot;
  insijetsWorkspaceAccess?: boolean;
  insijetsSourcingAccess?: boolean;
  insijetsOutreachAccess?: boolean;
}) {
  const t = useUiText();
  const defaultPreferences = useMemo(() => preferencesFromManifest(manifest), [manifest]);
  const preferencesKey = `aibrain.${session.tenant.id}.preferences.v3`;
  const previewKey = `aibrain.${session.tenant.id}.${session.user.id}.workbench.preview.v1`;
  // G03 v1 also persisted inferred defaults; do not treat those as an explicit choice.
  const selectionKey = `aibrain.${session.tenant.id}.${session.user.id}.selection.${g03ProductInstallation(session.tenant.id) ? "v2" : "v1"}`;
  const composerDraftsKey = `aibrain.${session.tenant.id}.${session.user.id}.composer-drafts.v1`;
  const threadReadKey = `aibrain.${session.tenant.id}.${session.user.id}.thread-read.v1`;
  const taskCenterKey = `aibrain.${session.tenant.id}.${session.user.id}.task-center.v1`;
  const [projects, setProjects] = useState(initialWorkbench.projects);
  const [threads, setThreads] = useState(initialWorkbench.threads);
  const [liveAnswers] = useState(() => new LiveAnswerStore());
  useEffect(() => {
    liveAnswers.retain(new Set(threads.flatMap(thread => thread.messages
      .filter(message => message.status === 'streaming')
      .map(message => liveAnswers.key(thread.id, message.id)))));
  }, [threads, liveAnswers]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<BrainPreferences>(() => preferencesFromManifest(manifest));
  const [prompt, setPrompt] = useState("");
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const serverDraftsKey = `${composerDraftsKey}.server`;
  const [serverDrafts, setServerDrafts] = useState<Record<string, ServerReference[]>>({});
  const selectedServerReferences = useMemo(() => serverDrafts[composerDraftKey(activeProjectId, activeThreadId)] ?? [], [serverDrafts, activeProjectId, activeThreadId]);
  const updateServerReferences = (items: ServerReference[]) => setServerDrafts(current => ({ ...current, [composerDraftKey(activeProjectId, activeThreadId)]: items }));
  const [pendingRuntimeContext, setPendingRuntimeContext] = useState<string | null>(null);
  const [composerExperience, setComposerExperience] = useState<ComposerExperience>("smart");
  const [imageGeneration, setImageGeneration] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [connectorMentions, setConnectorMentions] = useState<ConnectorMention[]>([]);
  const [connectorCatalogStatus, setConnectorCatalogStatus] = useState<"loading" | "ready" | "error">("loading");
  const [connectorCatalogAttempt, setConnectorCatalogAttempt] = useState(0);
  const connectorDraftsKey = `${composerDraftsKey}.connectors`;
  const [connectorDrafts, setConnectorDrafts] = useState<Record<string, string[]>>({});
  const selectedConnectorMentionIds = useMemo(() => connectorDrafts[composerDraftKey(activeProjectId, activeThreadId)] ?? [], [connectorDrafts, activeProjectId, activeThreadId]);
  const setSelectedConnectorMentionIds = (ids: string[]) => setConnectorDrafts(current => ({ ...current, [composerDraftKey(activeProjectId, activeThreadId)]: ids }));
  const [attachments, setAttachments] = useState<ChatInputAttachment[]>([]);
  const [documents, setDocuments] = useState<StagedComposerDocument[]>([]);
  const [publications, setPublications] = useState<DocumentPublicationDraft[]>([]);
  const [documentUploading, setDocumentUploading] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [runningThreadIds, setRunningThreadIds] = useState<Set<string>>(() => new Set());
  const [stoppingThreadIds, setStoppingThreadIds] = useState<Set<string>>(() => new Set());
  const [startingDraftKeys, setStartingDraftKeys] = useState<Set<string>>(() => new Set());
  const [threadReadMarkers, setThreadReadMarkers] = useState<Record<string, ThreadReadMarker>>({});
  const [actionBusy, setActionBusy] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const [activeSideWindow, setActiveSideWindow] = useState<SideWindowId | null>(null);
  const [previewDocument, setPreviewDocument] = useState<DocumentArtifact | null>(null);
  const [customizationOpen, setCustomizationOpen] = useState(false);
  const [customizationInitialTab, setCustomizationInitialTab] = useState<"appearance" | "connectors" | "memory" | "archived">("appearance");
  const [projectOpen, setProjectOpen] = useState(false);
  const [taskCenterOpen, setTaskCenterOpen] = useState(false);
  const [taskCenterRequested, setTaskCenterRequested] = useState(false);
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const [newAutomationRequested, setNewAutomationRequested] = useState(false);
  const [productView, setProductView] = useState<"production" | "apps" | "reception" | null>(null);
  const [insijetsPanel, setInsiJetsPanel] = useState<"cms" | "pricing" | "directory" | null>(null);
  const [outreachOpen, setOutreachOpen] = useState(false);
  const [outreachCompactView, setOutreachCompactView] = useState<'chat'|'outreach'>('outreach');
  const [outreachPaneContext, setOutreachPaneContext] = useState<OutreachPaneContext>({section:'overview'});
  const [insijetsCMSDirty, setInsiJetsCMSDirty] = useState(false);
  const canLeaveInsiJetsCMS = useCallback(() => !insijetsCMSDirty || window.confirm("Discard unsaved website content changes?"), [insijetsCMSDirty]);
  const [automationsBlockingSurfaceOpen, setAutomationsBlockingSurfaceOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsSnapshot, setSettingsSnapshot] = useState<SettingsSnapshot | null>(null);
  const [networkOnline, setNetworkOnline] = useState(true);
  const initializedSelectionKey = useRef<string | null>(null);
  const initializedWorkbenchSnapshot = useRef<WorkbenchSnapshot | null>(null);
  const [runtimeRetry, setRuntimeRetry] = useState(0);
  const runtimeStatus = useRuntimeStatus({ hydrated, online: networkOnline, projectId: activeProjectId, retry: runtimeRetry });
  const [mobileSidebarRestoreFocus, setMobileSidebarRestoreFocus] = useState(false);
  const [compactOverlayLayout, setCompactOverlayLayout] = useState(false);
  const [textDialog, setTextDialog] = useState<TextDialogState | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [notice, setNotice] = useState<WorkbenchNotice | null>(null);
  const [streamRecoveryNotice, setStreamRecoveryNotice] = useState<StreamRecoveryNotice | null>(null);
  const [storedResponseRetry, setStoredResponseRetry] = useState(0);
  const streamRetryRef = useRef(new Map<string, () => void>());
  const [pendingBranchSend, setPendingBranchSend] = useState<{ threadId: string; content: string } | null>(null);
  const [queuedTurns, setQueuedTurns] = useState<QueuedChatTurn[]>([]);
  const [dispatchingQueuedTurnId, setDispatchingQueuedTurnId] = useState<string | null>(null);
  const [managedAppAvailable, setManagedAppAvailable] = useState(false);
  const [managedAppActions, setManagedAppActions] = useState<ManagedAppActionRegistry>({});
  const [clientTurnReadbacks, setClientTurnReadbacks] = useState<Record<string, ClientTurnPerformanceReadback>>({});
  const threadByProjectRef = useRef<Record<string, string>>({});
  const turnControllersRef = useRef(new Map<string, {
    assistantMessageId: string;
    controller: AbortController;
    stop: PendingTurnStop;
  }>());
  // Each reservation owns its cleanup. A cancelled creation may resolve after
  // a replacement send has reserved the same draft key.
  const turnReservationsRef = useRef(new Map<string, { cancelled: boolean }>());
  const promptRef = useRef("");
  const composerDraftsRef = useRef<Record<string, string>>({});
  const selectionGenerationRef = useRef(0);
  const pendingSelectionRef = useRef<number | null>(null);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const activeSelectionRef = useRef<{ projectId: string | null; threadId: string | null }>({
    projectId: null,
    threadId: null,
  });
  const sidebarReturnFocusRef = useRef<HTMLElement | null>(null);
  const mobileSidebarOpenerRef = useRef<HTMLElement | null>(null);
  const mobileSidebarHandoffRef = useRef<"customization" | "project" | "text" | "confirm" | "command" | null>(null);

  const {
    payload: taskCenterPayload, items: taskCenterItems, summary: taskSummary,
    busy: taskCenterBusy, mutate: mutateTaskCenter, restorePreview: restoreTaskCenterPreview,
  } = useTaskCenter({
    hydrated, persistence: initialWorkbench.persistence, projects, threads,
    cacheKey: taskCenterKey, productName: branding.productName, selection: activeSelectionRef,
    open: taskCenterOpen, requestOpen: setTaskCenterRequested, onNotice: setNotice,
  });

  const beginSidebarOverlay = useCallback((surface: NonNullable<typeof mobileSidebarHandoffRef.current>, returnFocus?: HTMLElement | null) => {
    sidebarReturnFocusRef.current = returnFocus ?? null;
    mobileSidebarHandoffRef.current = mobileSidebarOpen ? surface : null;
    if (mobileSidebarOpen) setMobileSidebarOpen(false);
  }, [mobileSidebarOpen]);

  const finishSidebarOverlay = useCallback((surface: NonNullable<typeof mobileSidebarHandoffRef.current>) => {
    const shouldRestoreMobile = mobileSidebarHandoffRef.current === surface &&
      !window.matchMedia("(min-width: 768px)").matches;
    mobileSidebarHandoffRef.current = null;
    if (shouldRestoreMobile) {
      setMobileSidebarRestoreFocus(true);
      setMobileSidebarOpen(true);
    } else {
      sidebarReturnFocusRef.current = null;
    }
  }, []);

  const closeCustomization = useCallback(() => {
    finishSidebarOverlay("customization");
    setCustomizationOpen(false);
  }, [finishSidebarOverlay]);
  const closeProjectPanel = useCallback(() => {
    finishSidebarOverlay("project");
    setProjectOpen(false);
  }, [finishSidebarOverlay]);
  const closeTextDialog = useCallback(() => {
    finishSidebarOverlay("text");
    setTextDialog(null);
  }, [finishSidebarOverlay]);
  const closeConfirmDialog = useCallback(() => {
    finishSidebarOverlay("confirm");
    setConfirmDialog(null);
  }, [finishSidebarOverlay]);
  const closeCommandPalette = useCallback(() => {
    finishSidebarOverlay("command");
    setCommandPaletteOpen(false);
  }, [finishSidebarOverlay]);
  const dismissMobileSidebar = useCallback(() => {
    mobileSidebarHandoffRef.current = null;
    sidebarReturnFocusRef.current = null;
    mobileSidebarOpenerRef.current = null;
    setMobileSidebarOpen(false);
    setMobileSidebarRestoreFocus(false);
  }, []);

  useEffect(() => {
    // A server-component refresh may supply a new snapshot object while a turn
    // is attached. Initialize once per identity/mount; only a fresh page resets
    // navigation to the landing page. A fresh server snapshot still revokes
    // removed projects, while an authorized live conversation stays attached.
    if (initializedSelectionKey.current === selectionKey) {
      if (initialWorkbench.persistence === "filesystem" && initializedWorkbenchSnapshot.current !== initialWorkbench) {
        initializedWorkbenchSnapshot.current = initialWorkbench;
        const visibleIds = new Set(initialWorkbench.projects.map(project => project.id));
        const refreshedProjects = new Map(initialWorkbench.projects.map(project => [project.id, project]));
        const refreshedThreads = new Map(initialWorkbench.threads.map(thread => [thread.id, thread]));
        const activeIds = new Set(initialWorkbench.projects.filter(project => project.status === "active").map(project => project.id));
        setProjects(initialWorkbench.projects);
        setThreads(current => current.filter(thread => visibleIds.has(thread.projectId)).map((thread): WorkbenchThread => {
          const project = refreshedProjects.get(thread.projectId);
          const access = workbenchThreadAccess(refreshedThreads.get(thread.id) ?? thread, project);
          const projectAccess = workbenchProjectAccess(project);
          // Refresh only authority; keep the attached turn and its streamed messages.
          return { ...thread, access: {
            role: access.role === "viewer" || projectAccess.role === "viewer" ? "viewer" : access.role === "owner" && projectAccess.role === "owner" ? "owner" : "editor",
            canEdit: access.canEdit && projectAccess.canEdit,
            canManage: access.canManage && projectAccess.canManage,
          } };
        }));
        const selectedId = activeSelectionRef.current.projectId;
        if (selectedId && !activeIds.has(selectedId)) {
          const standalone = newThreadDestination(initialWorkbench.projects);
          delete threadByProjectRef.current[selectedId];
          selectionGenerationRef.current += 1;
          pendingSelectionRef.current = null;
          setSelectionLoading(false);
          promptRef.current = "";
          activeSelectionRef.current = { projectId: standalone?.id ?? null, threadId: null };
          setActiveProjectId(standalone?.id ?? null); setActiveThreadId(null);
          setSelectedMessageId(null); setPendingRuntimeContext(null);
          setPrompt(""); setAttachments([]); setDocuments([]);
          documentUploadEpochRef.current += 1;
          for (const controller of documentUploadControllersRef.current.values()) controller.abort();
          documentUploadControllersRef.current.clear(); setDocumentUploading(false);
        }
      }
      return;
    }
    selectionGenerationRef.current += 1;
    pendingSelectionRef.current = null;
    setSelectionLoading(false);
    initializedSelectionKey.current = selectionKey;
    initializedWorkbenchSnapshot.current = initialWorkbench;
    const snapshot = initialWorkbench.persistence === "browser-preview"
      ? loadPreviewSnapshot(previewKey, initialWorkbench)
      : initialWorkbench;
    const savedSelection = loadSelection(selectionKey);
    const preferredProject = snapshot.projects.find((project) =>
      project.id === savedSelection.activeProjectId && project.status === "active");
    const project = preferredProject ?? newThreadDestination(snapshot.projects);

    setProjects(snapshot.projects);
    setThreads(snapshot.threads);
    // A project is opened only after this employee explicitly selected it.
    setActiveProjectId(project?.id ?? null);
    setActiveThreadId(null);
    try {
      const saved = JSON.parse(localStorage.getItem(serverDraftsKey) ?? "{}");
      if (saved && typeof saved === "object" && !Array.isArray(saved)) setServerDrafts(Object.fromEntries(Object.entries(saved).filter(([, v]) => isServerReferenceList(v)).slice(-100)) as Record<string, ServerReference[]>);
    } catch { /* A corrupt draft never grants source access. */ }
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(connectorDraftsKey) ?? "{}");
      if (saved && typeof saved === "object" && !Array.isArray(saved)) setConnectorDrafts(Object.fromEntries(Object.entries(saved).filter(([key, ids]) => key.length < 300 && Array.isArray(ids) && ids.length <= 20 && ids.every(id => typeof id === "string" && /^[a-z][a-z0-9.:_-]{0,150}$/.test(id))).slice(-100)));
    } catch { /* A malformed browser draft grants no authority. */ }
    const storedDrafts = parseComposerDrafts(localStorage.getItem(composerDraftsKey));
    const restoredPrompt = storedDrafts[composerDraftKey(project?.id ?? null, null)] || "";
    activeSelectionRef.current = { projectId: project?.id ?? null, threadId: null };
    composerDraftsRef.current = storedDrafts;
    promptRef.current = restoredPrompt;
    setComposerDrafts(storedDrafts);
    setPrompt(restoredPrompt);
    setPreferences(loadPreferences(preferencesKey, defaultPreferences));
    setThreadReadMarkers(loadThreadReadMarkers(threadReadKey, snapshot.threads));
    if (initialWorkbench.persistence === "browser-preview") {
      restoreTaskCenterPreview();
    }
    threadByProjectRef.current = savedSelection.threadByProject;
    setHydrated(true);
  }, [connectorDraftsKey, serverDraftsKey, composerDraftsKey, defaultPreferences, initialWorkbench, preferencesKey, previewKey, selectionKey, restoreTaskCenterPreview, threadReadKey]);

  useEffect(() => {
    if (!hydrated) return;
    const bounded = Object.fromEntries(Object.entries(composerDrafts)
      .filter(([, draft]) => draft.length > 0)
      .slice(-MAX_COMPOSER_DRAFTS));
    localStorage.setItem(composerDraftsKey, JSON.stringify(bounded));
  }, [composerDrafts, composerDraftsKey, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    let active = true;
    void loadManagedAppCapability(fetch).then((available) => {
      if (active) setManagedAppAvailable(available);
    }).catch(() => {
      if (active) setManagedAppAvailable(false);
    });
    return () => { active = false; };
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated || initialWorkbench.persistence === "browser-preview") return;
    const controller = new AbortController();
    setConnectorCatalogStatus("loading");
    void fetch("/api/connectors/mentions", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]), cache: "no-store" })
      .then((response) => { if (!response.ok) throw new Error("CONNECTOR_CATALOG_UNAVAILABLE"); return response.json(); })
      .then((value: unknown) => {
        const mentions = value && typeof value === "object" && "mentions" in value ? (value as { mentions?: unknown }).mentions : null;
        if (!Array.isArray(mentions) || !mentions.every(isConnectorMention)) throw new Error("CONNECTOR_CATALOG_INVALID");
        if (!controller.signal.aborted) { setConnectorMentions(mentions); setConnectorCatalogStatus("ready"); }
      })
      .catch(() => { if (!controller.signal.aborted) { setConnectorMentions([]); setConnectorCatalogStatus("error"); } });
    return () => controller.abort();
  }, [hydrated, initialWorkbench.persistence, connectorCatalogAttempt, customizationOpen]);



  useEffect(() => {
    if (!hydrated || initialWorkbench.persistence !== "browser-preview") return;
    const snapshot: WorkbenchSnapshot = {
      persistence: "browser-preview",
      projects,
      threads,
    };
    localStorage.setItem(previewKey, JSON.stringify(snapshot));
  }, [hydrated, initialWorkbench.persistence, previewKey, projects, threads]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(preferencesKey, JSON.stringify(preferences));
    if (!preferences.conversationMemory) {
      localStorage.removeItem(selectionKey);
      return;
    }
    if (activeProjectId && activeThreadId) {
      threadByProjectRef.current[activeProjectId] = activeThreadId;
    }
    localStorage.setItem(selectionKey, JSON.stringify({
      activeProjectId,
      threadByProject: threadByProjectRef.current,
    } satisfies StoredSelection));
  }, [activeProjectId, activeThreadId, hydrated, preferences, preferencesKey, selectionKey]);

  useEffect(() => {
    activeSelectionRef.current = { projectId: activeProjectId, threadId: activeThreadId };
  }, [activeProjectId, activeThreadId]);

  useEffect(() => {
    if (!hydrated || !activeThreadId || initialWorkbench.persistence !== "filesystem" ||
        !["g03-production", "g03-qa"].includes(session.tenant.id)) return;
    const controller = new AbortController();
    recoverDocumentPublications(activeThreadId, controller.signal).then((recovered) => {
      if (controller.signal.aborted) return;
      setPublications((current) => {
        const known = new Set(current.map((draft) => draft.operation?.operationId));
        return [...current, ...recovered.filter((draft) => !known.has(draft.operation!.operationId))];
      });
    }).catch(() => {
      if (!controller.signal.aborted) setNotice(workbenchNotice(t("No se ha podido comprobar si hay guardados pendientes. No repitas un guardado anterior hasta recuperar su estado."), "error"));
    });
    return () => controller.abort();
  }, [activeThreadId, hydrated, initialWorkbench.persistence, session.tenant.id, t]);

  useEffect(() => {
    if (!notice || notice.kind === "error") return;
    const timeout = window.setTimeout(() => setNotice(null), notice.kind === "warning" ? 8_000 : 4_200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    const updateNetwork = () => {
      const online = navigator.onLine;
      setNetworkOnline(online);
      if (online) setRuntimeRetry((current) => current + 1);
    };
    setNetworkOnline(navigator.onLine);
    window.addEventListener("online", updateNetwork);
    window.addEventListener("offline", updateNetwork);
    return () => {
      window.removeEventListener("online", updateNetwork);
      window.removeEventListener("offline", updateNetwork);
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const params = new URLSearchParams(window.location.search);
    const starter = params.get("starter")?.trim();
    const requestedSettings = params.get("settings");
    if (params.get('workspace') === 'outreach' && insijetsOutreachAccess) {
      setOutreachOpen(true);
      setOutreachCompactView('outreach');
    }
    if (requestedSettings === "connectors" || requestedSettings === "memory" || requestedSettings === "archived") {
      setCustomizationInitialTab(requestedSettings);
      setCustomizationOpen(true);
    }
    if (starter) {
      const value = starter.slice(0, 400);
      promptRef.current = value;
      setPrompt(value);
    }
    if (starter) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [hydrated, insijetsOutreachAccess]);
  useEffect(() => {
    if (hydrated) localStorage.setItem(connectorDraftsKey, JSON.stringify(connectorDrafts));
  }, [hydrated, connectorDrafts, connectorDraftsKey]);
  useEffect(() => {
    if (hydrated) localStorage.setItem(serverDraftsKey, JSON.stringify(serverDrafts));
  }, [hydrated, serverDrafts, serverDraftsKey]);
  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projects],
  );
  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [activeThreadId, threads],
  );
  const applyStoredResponse = useCallback((threadId: string, message: ChatMessage) => {
    setThreads(current => updateThreadMessage(current, threadId, message.id, previous =>
      applyChatStreamEvent(previous, { type: "snapshot", message })));
    if (message.status !== "streaming") {
      const run = turnControllersRef.current.get(threadId);
      if (run?.assistantMessageId === message.id) run.stop.observeTerminal();
      streamRetryRef.current.get(threadId)?.();
      setStreamRecoveryNotice(current => current?.threadId === threadId ? null : current);
    }
  }, []);
  const reconcileTurnAfterStopFailure = useCallback(async (threadId: string, assistantMessageId: string, projectId: string) => {
    const terminal = await readTurnTerminalAfterStop({ threadId, assistantMessageId, projectId });
    if (!terminal) return false;
    applyStoredResponse(threadId, terminal);
    return true;
  }, [applyStoredResponse]);
  const storedResponsePhase = useStoredResponse({
    thread: activeThread, enabled: initialWorkbench.persistence === "filesystem", online: networkOnline,
    readOnly: !workbenchThreadAccess(activeThread, activeProject).canEdit,
    attached: Boolean(activeThread && runningThreadIds.has(activeThread.id) &&
      !(streamRecoveryNotice?.threadId === activeThread.id && streamRecoveryNotice.attempt === null)),
    retry: storedResponseRetry, onSnapshot: applyStoredResponse,
  });
  const updateComposerPrompt = useCallback((value: string) => {
    if (pendingSelectionRef.current !== null) return;
    const bounded = value.slice(0, MAX_COMPOSER_DRAFT_CHARS);
    const key = composerDraftKey(
      activeSelectionRef.current.projectId,
      activeSelectionRef.current.threadId,
    );
    setComposerDrafts((current) => {
      if (!bounded) {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        composerDraftsRef.current = next;
        return next;
      }
      if (current[key] === bounded) return current;
      const next = { ...current, [key]: bounded };
      composerDraftsRef.current = next;
      return next;
    });
    promptRef.current = bounded;
    setPrompt(bounded);
  }, []);
  const switchComposerSelection = useCallback((next: { projectId: string | null; threadId: string | null }) => {
    const currentKey = composerDraftKey(
      activeSelectionRef.current.projectId,
      activeSelectionRef.current.threadId,
    );
    const nextKey = composerDraftKey(next.projectId, next.threadId);
    const currentPrompt = promptRef.current;
    const drafts = composerDraftsRef.current;
    const withCurrent = currentPrompt
      ? { ...drafts, [currentKey]: currentPrompt.slice(0, MAX_COMPOSER_DRAFT_CHARS) }
      : drafts;
    if (withCurrent !== drafts) {
      composerDraftsRef.current = withCurrent;
      setComposerDrafts(withCurrent);
    }
    selectionGenerationRef.current += 1;
    pendingSelectionRef.current = null;
    setSelectionLoading(false);
    activeSelectionRef.current = next;
    const nextPrompt = withCurrent[nextKey] ?? "";
    promptRef.current = nextPrompt;
    setPrompt(nextPrompt);
  }, []);
  const adoptCurrentComposerThread = useCallback((projectId: string, threadId: string) => {
    const previousKey = composerDraftKey(
      activeSelectionRef.current.projectId,
      activeSelectionRef.current.threadId,
    );
    const nextKey = composerDraftKey(projectId, threadId);
    const nextDrafts = { ...composerDraftsRef.current };
    if (promptRef.current) nextDrafts[nextKey] = promptRef.current;
    delete nextDrafts[previousKey];
    composerDraftsRef.current = nextDrafts;
    setComposerDrafts(nextDrafts);
    selectionGenerationRef.current += 1;
    pendingSelectionRef.current = null;
    setSelectionLoading(false);
    activeSelectionRef.current = { projectId, threadId };
  }, []);
  const threadActivityById = useMemo(() => Object.fromEntries(threads.map((thread) => [
    thread.id,
    getThreadActivity(
      thread,
      threadReadMarkers[thread.id] ?? null,
      runningThreadIds.has(thread.id),
    ),
  ])) as Record<string, ThreadActivity>, [runningThreadIds, threadReadMarkers, threads]);
  const sending = activeThread
    ? runningThreadIds.has(activeThread.id) || activeThread.messages.some((message) =>
        message.role === "assistant" && message.status === "streaming")
    : startingDraftKeys.has(composerDraftKey(activeProjectId, null));
  const activeQueuedMessages = useMemo(() => queuedTurns
    .filter((item) => item.projectId === activeProjectId && item.threadId === activeThreadId)
    .map((item) => ({ id: item.id, text: item.displayContent })), [activeProjectId, activeThreadId, queuedTurns]);
  const selectedMessage = useMemo(
    () => activeThread?.messages.find((message) => message.id === selectedMessageId) ??
      activeThread?.messages.findLast((message) => message.role === "assistant") ?? null,
    [activeThread, selectedMessageId],
  );

  useEffect(() => {
    if (!previewDocument) return;
    const remainsInConversation = activeThread?.messages.some((message) =>
      message.artifacts.some((artifact) => artifact.id === previewDocument.id)) ?? false;
    if (!remainsInConversation) setPreviewDocument(null);
  }, [activeThread, previewDocument]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(threadReadKey, JSON.stringify(threadReadMarkers));
  }, [hydrated, threadReadKey, threadReadMarkers]);

  useEffect(() => {
    if (!activeThread) return;
    const marker = latestThreadReadMarker(activeThread);
    if (!marker) return;
    setThreadReadMarkers((current) => {
      const previous = current[activeThread.id];
      if (previous?.messageId === marker.messageId && previous.phase === marker.phase) return current;
      return { ...current, [activeThread.id]: marker };
    });
  }, [activeThread]);

  useEffect(() => () => {
    for (const run of turnControllersRef.current.values()) { run.stop.dispose(); run.controller.abort(); }
    turnControllersRef.current.clear();
    for (const reservation of turnReservationsRef.current.values()) reservation.cancelled = true;
    turnReservationsRef.current.clear();
  }, []);


  useEffect(() => {
    if (!hydrated) return;
    const controller = new AbortController();
    void fetch("/api/settings", { signal: controller.signal, cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((value: unknown) => {
        if (isSettingsSnapshot(value)) setSettingsSnapshot(value);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [hydrated]);

  const effectiveRuntimeStatus = useMemo<RuntimeStatus>(() => {
    const enabled = (id: string) => settingsSnapshot?.apps.find((app) => app.id === id)?.effectiveEnabled ?? true;
    return {
      ...runtimeStatus,
      capabilities: {
        ...runtimeStatus.capabilities,
        webSearch: runtimeStatus.mode === "demo" || runtimeStatus.ready,
        imageGeneration: runtimeStatus.capabilities.imageGeneration && enabled("image-generation"),
      },
      skills: enabled("skills") ? runtimeStatus.skills : [],
    };
  }, [runtimeStatus, settingsSnapshot]);

  const appPolicy = useMemo(() => ({
    imageGeneration: settingsSnapshot?.apps.find((app) => app.id === "image-generation")?.effectiveEnabled ?? true,
    skills: settingsSnapshot?.apps.find((app) => app.id === "skills")?.effectiveEnabled ?? true,
  }), [settingsSnapshot]);

  useEffect(() => {
    if (!appPolicy.imageGeneration || (runtimeStatus.mode === "codex" && runtimeStatus.codex !== "checking" && !runtimeStatus.capabilities.imageGeneration)) setImageGeneration(false);
    if (!appPolicy.skills || (runtimeStatus.mode === "codex" && runtimeStatus.codex !== "checking" && selectedSkill && !runtimeStatus.skills.some((skill) => skill.id === selectedSkill))) setSelectedSkill(null);
  }, [appPolicy, runtimeStatus, selectedSkill]);

  const style = useMemo<BrainStyle>(() => {
    return {
      "--brain-accent": "var(--text)",
      "--brain-accent-strong": "var(--text)",
      "--brain-accent-on-soft": "var(--text-secondary)",
      "--brain-accent-soft": "var(--surface-muted)",
      "--notification-accent": "var(--text)",
      "--brain-contrast": "var(--surface)",
      "--brain-radius": cornerTokens[preferences.corners],
    };
  }, [preferences.corners]);

  const documentUploadControllersRef = useRef(new Map<string, AbortController>());
  const documentUploadEpochRef = useRef(0);
  const cancelDocumentUploads = useCallback(() => {
    documentUploadEpochRef.current += 1;
    for (const controller of documentUploadControllersRef.current.values()) controller.abort();
    documentUploadControllersRef.current.clear();
    setDocumentUploading(false);
  }, []);

  const selectProject = useCallback(async (projectId: string) => {
    const generation = ++selectionGenerationRef.current;
    pendingSelectionRef.current = generation;
    setSelectionLoading(true);
    try {
      const project = projects.find((candidate) => candidate.id === projectId && candidate.status === "active");
      if (!project) return false;
      cancelDocumentUploads();
      if (activeProjectId && activeThreadId) threadByProjectRef.current[activeProjectId] = activeThreadId;
      const rememberedId = threadByProjectRef.current[projectId];
      const remembered = threads.find((thread) =>
        thread.id === rememberedId && thread.projectId === projectId && thread.status === "active");
      let thread = remembered ?? firstActiveThread(threads, projectId);
      if (thread?.historyLoaded === false) {
        try {
          const loaded = await getThreadRequest(thread.id);
          if (generation !== selectionGenerationRef.current) return false;
          if (loaded.projectId !== projectId || loaded.status !== "active") throw new Error("Unavailable conversation");
          thread = loaded;
          setThreads(current => current.map(item => item.id === loaded.id ? loaded : item));
        } catch {
          if (generation === selectionGenerationRef.current) setNotice(workbenchNotice(t("No se ha podido abrir esta conversación. Comprueba que sigues teniendo acceso."), "error"));
          return false;
        }
      }
      switchComposerSelection({ projectId, threadId: thread?.id ?? null });
      setActiveProjectId(projectId);
      setActiveThreadId(thread?.id ?? null);
      setPendingRuntimeContext(null);
      setAttachments([]);
      setDocuments([]);
      setSelectedMessageId(null);
      setActiveSideWindow(null);
      setMobileSidebarOpen(false);
      return true;
    } finally {
      if (pendingSelectionRef.current === generation) {
        pendingSelectionRef.current = null;
        setSelectionLoading(false);
      }
    }
  }, [activeProjectId, activeThreadId, cancelDocumentUploads, projects, switchComposerSelection, threads, t]);

  const selectThread = useCallback(async (threadId: string) => {
    const generation = ++selectionGenerationRef.current;
    pendingSelectionRef.current = generation;
    setSelectionLoading(true);
    try {
      let thread = threads.find((candidate) => candidate.id === threadId && candidate.status === "active");
      if (!thread || thread.historyLoaded === false) {
        try {
          // Background work and search results can refer to conversations absent
          // from the initial sidebar snapshot. Revalidate access before opening.
          thread = await getThreadRequest(threadId);
          if (generation !== selectionGenerationRef.current) return;
          const project = thread.access?.role === "viewer"
            ? await getProjectRequest(thread.projectId).catch(() => null)
            : await getProjectRequest(thread.projectId);
          if (generation !== selectionGenerationRef.current) return;
          if (thread.id !== threadId || (project && project.id !== thread.projectId) ||
              thread.status !== "active" || (project && project.status !== "active")) {
            throw new Error(t("Esta conversación ya no está disponible."));
          }
          const loadedThread = thread;
          setThreads((current) => current.some((item) => item.id === loadedThread.id)
            ? current.map(item => item.id === loadedThread.id ? loadedThread : item) : [loadedThread, ...current]);
          if (project) setProjects((current) => current.some((item) => item.id === project.id)
            ? current : [project, ...current]);
        } catch {
          if (generation === selectionGenerationRef.current) {
            setNotice(workbenchNotice(t("No se ha podido abrir esta conversación. Comprueba que sigues teniendo acceso."), "error"));
          }
          return;
        }
      }
      cancelDocumentUploads();
      switchComposerSelection({ projectId: thread.projectId, threadId: thread.id });
      setActiveProjectId(thread.projectId);
      setActiveThreadId(thread.id);
      setPendingRuntimeContext(null);
      setAttachments([]);
      setDocuments([]);
      threadByProjectRef.current[thread.projectId] = thread.id;
      setSelectedMessageId(null);
      setMobileSidebarOpen(false);
    } finally {
      if (pendingSelectionRef.current === generation) {
        pendingSelectionRef.current = null;
        setSelectionLoading(false);
      }
    }
  }, [cancelDocumentUploads, switchComposerSelection, threads, t]);

  const welcomeSelectionRef = useRef(selectThread);
  useEffect(() => { welcomeSelectionRef.current = selectThread; }, [selectThread]);
  const welcomeRequestRef = useRef<Promise<{ threadId?: string; created?: boolean }> | null>(null);
  useEffect(() => {
    if (!hydrated || !g03ProductInstallation(branding.installationId) || initialWorkbench.persistence !== "filesystem") return;
    // Do not interrupt an existing conversation, a typed draft or a deep link.
    const generation = selectionGenerationRef.current;
    const canOpen = !window.location.search && !activeSelectionRef.current.threadId && !promptRef.current.trim();
    let active = true;
    welcomeRequestRef.current ??= fetch("/api/g03/welcome", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ openChat: true }),
    }).then(async response => response.ok ? response.json() : {}).catch(() => ({}));
    void welcomeRequestRef.current.then(result => {
      if (active && canOpen && result.created && result.threadId &&
          selectionGenerationRef.current === generation && !activeSelectionRef.current.threadId && !promptRef.current.trim()) {
        void welcomeSelectionRef.current(result.threadId);
      }
    });
    return () => { active = false; };
  }, [branding.installationId, hydrated, initialWorkbench.persistence]);

  const startNewThread = useCallback((projectId?: string) => {
    const destination = newThreadDestination(projects, projectId);
    if (!destination) {
      setNotice(workbenchNotice(t("No se ha podido preparar el espacio de conversaciones."), "error"));
      return;
    }
    cancelDocumentUploads();
    delete threadByProjectRef.current[destination.id];
    switchComposerSelection({ projectId: destination.id, threadId: null });
    setActiveProjectId(destination.id);
    setActiveThreadId(null);
    setSelectedMessageId(null);
    setPendingRuntimeContext(null);
    setAttachments([]);
    setDocuments([]);
    setActiveSideWindow(null);
    setMobileSidebarOpen(false);
  }, [cancelDocumentUploads, projects, switchComposerSelection, t]);

  useEffect(() => {
    if (!g03ProductInstallation(branding.installationId)) return;
    const appId = new URLSearchParams(window.location.search).get("g03App");
    if (appId === null) return;
    startNewThread();
    setPrompt(appId ? `Modifica la miniaplicació ${appId}. Llegeix-la i demana'm els canvis abans de desar una nova versió.` : "Crea una miniaplicació interna. Demana'm què necessito i els camps de dades.");
    window.history.replaceState(null, "", window.location.pathname);
  }, [branding.installationId, startNewThread]);

  const changeDocuments = useCallback((next: StagedComposerDocument[]) => {
    if (pendingSelectionRef.current !== null) return;
    for (const [id, controller] of documentUploadControllersRef.current) {
      if (!next.some((document) => document.uploadId === id)) controller.abort();
    }
    setDocuments(next);
  }, []);

  const addDocuments = useCallback(async (files: File[]) => {
    if (pendingSelectionRef.current !== null || !activeProject || documentUploading || sending) return;
    if (initialWorkbench.persistence !== "filesystem") {
      setNotice(workbenchNotice(t("Los documentos reales requieren el runtime privado de la instalación."), "warning"));
      return;
    }
    const available = Math.max(0, MAX_FILES_PER_MESSAGE - attachments.length - documents.filter((document) => document.status !== "error").length);
    const selected = files.slice(0, available);
    if (files.length > available) setNotice(workbenchNotice(t("Puedes adjuntar un máximo de {p0} archivos por mensaje.", { p0: MAX_FILES_PER_MESSAGE }), "warning"));
    if (!selected.length) return;

    let thread = activeThread && activeThread.status === "active" && activeThread.projectId === activeProject.id
      ? activeThread
      : null;
    const uploadEpoch = documentUploadEpochRef.current;
    setDocumentUploading(true);
    try {
      if (!thread) {
        thread = await createThreadRequest(activeProject.id, t("Conversación con documentos"));
        setThreads((current) => [thread as WorkbenchThread, ...current]);
        if (documentUploadEpochRef.current !== uploadEpoch) return;
        adoptCurrentComposerThread(activeProject.id, thread.id);
        setActiveThreadId(thread.id);
        threadByProjectRef.current[activeProject.id] = thread.id;
      }
      for (const file of selected) {
        if (documentUploadEpochRef.current !== uploadEpoch) break;
        const uploadId = crypto.randomUUID();
        const placeholder: StagedComposerDocument = {
          id: uploadId,
          uploadId,
          threadId: thread.id,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          kind: /\.(ogg|opus)$/i.test(file.name) ? "audio" : "text",
          previewFiles: [],
          pages: null,
          status: "uploading",
          error: null,
        };
        setDocuments((current) => [...current, placeholder]);
        try {
          const controller = new AbortController();
          documentUploadControllersRef.current.set(uploadId, controller);
          const result = await stageDocument(thread.id, file, uploadId, controller.signal);
          setDocuments((current) => current.map((document) => document.uploadId === uploadId ? {
            ...document,
            name: result.document.storedLegacyExcel?.originalFileName ?? result.document.fileName,
            mimeType: result.document.mediaType,
            size: result.document.size,
            kind: result.document.kind,
            previewFiles: result.preview.files,
            pages: result.preview.pages,
            status: "ready",
            passive: Boolean(result.document.legacyExcel),
            processingUnavailable: Boolean(result.document.storedLegacyExcel),
            previewUnavailable: result.preview.status === "unavailable",
          } : document));
          if (result.document.storedLegacyExcel) setNotice(workbenchNotice(t("Original XLS guardado. Su procesamiento no está disponible; todavía no se han podido leer sus datos."), "warning"));
          else if (result.document.legacyExcel) setNotice(workbenchNotice(t("XLS preparado como copia pasiva. Datos guardados y resultados de fórmulas sin verificar; no se ejecutan macros ni se actualizan enlaces. El original se conserva intacto."), "warning"));
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : t("No se ha podido preparar el documento.");
          setDocuments((current) => current.map((document) => document.uploadId === uploadId
            ? { ...document, status: "error", error: message }
            : document));
          if (documentUploadEpochRef.current === uploadEpoch && !documentUploadControllersRef.current.get(uploadId)?.signal.aborted) setNotice(workbenchNotice(message, "error"));
        } finally {
          documentUploadControllersRef.current.delete(uploadId);
        }
      }
    } catch (reason) {
      if (documentUploadEpochRef.current === uploadEpoch) setNotice(workbenchNotice(reason instanceof Error ? reason.message : t("No se ha podido abrir una conversación para el documento."), "error"));
    } finally {
      if (documentUploadEpochRef.current === uploadEpoch) setDocumentUploading(false);
    }
  }, [activeProject, activeThread, adoptCurrentComposerThread, attachments.length, documentUploading, documents, initialWorkbench.persistence, sending, t]);

  const requestDocumentPublication = useCallback((attachment: ChatAttachment, turnId: string) => {
    if (!activeThread) return;
    setPublications((current) => current.some((candidate) => candidate.threadId === activeThread.id &&
      candidate.uploadId === attachment.id && ["ready", "freezing", "awaiting_confirmation", "uncertain", "deciding"].includes(candidate.phase))
      ? current : [
      ...current,
      { id: crypto.randomUUID(), threadId: activeThread.id, turnId, uploadId: attachment.id,
        fileName: attachment.name, size: attachment.size, targetRelativePath: ["g03-production", "g03-qa"].includes(session.tenant.id)
          ? `server-g03/M/G03/PRODUCCIO/${encodeURIComponent(attachment.name.replace(/[\\/]/g, "-"))}` : publicationTarget(attachment.name),
        phase: "ready", operation: null, confirmationToken: null, permissionFingerprint: null, error: null },
    ]);
  }, [activeThread, session.tenant.id]);

  const freezePublication = useCallback(async (draftId: string, targetRelativePath: string) => {
    const draft = publications.find((candidate) => candidate.id === draftId);
    if (!draft || draft.phase === "freezing" || draft.phase === "deciding") return;
    setPublications((current) => current.map((candidate) => candidate.id === draftId
      ? { ...candidate, targetRelativePath, phase: "freezing", error: null }
      : candidate));
    try {
      const receipt = await freezeDocumentPublication(draft, targetRelativePath);
      setPublications((current) => current.map((candidate) => candidate.id === draftId ? {
        ...candidate,
        targetRelativePath: receipt.operation.targetRelativePath,
        phase: "awaiting_confirmation",
        operation: receipt.operation,
        confirmationToken: receipt.confirmationToken,
        permissionFingerprint: receipt.permissionFingerprint,
        error: null,
      } : candidate));
    } catch (error) {
      setPublications((current) => current.map((candidate) => candidate.id === draftId ? {
        ...candidate,
        targetRelativePath,
        phase: "error",
        error: error instanceof Error ? error.message : t("No se ha podido preparar la publicación."),
      } : candidate));
    }
  }, [publications, t]);

  const decidePublication = useCallback(async (draftId: string, action: "confirm" | "decline") => {
    const draft = publications.find((candidate) => candidate.id === draftId);
    if (!draft || !["awaiting_confirmation", "uncertain"].includes(draft.phase)) return;
    setPublications((current) => current.map((candidate) => candidate.id === draftId
      ? { ...candidate, phase: "deciding", error: null }
      : candidate));
    try {
      const receipt = await decideDocumentPublication(draft, action);
      const phase = receipt.operation.status === "publishing"
        ? (draft.targetRelativePath.startsWith("server-g03/") ? "uncertain" : "deciding")
        : receipt.operation.status;
      setPublications((current) => current.map((candidate) => candidate.id === draftId ? {
        ...candidate,
        phase,
        operation: receipt.operation,
        confirmationToken: phase === "uncertain" ? candidate.confirmationToken : null,
        permissionFingerprint: receipt.permissionFingerprint,
        error: null,
      } : candidate));
    } catch (error) {
      setPublications((current) => current.map((candidate) => candidate.id === draftId ? {
        ...candidate,
        phase: action === "confirm" && draft.targetRelativePath.startsWith("server-g03/") ? "uncertain" : "awaiting_confirmation",
        error: error instanceof Error ? error.message : t("No se ha podido aplicar la decisión."),
      } : candidate));
    }
  }, [publications, t]);

  const handleStream = useCallback(async (
    request: (signal: AbortSignal) => Promise<Response>,
    threadId: string,
    assistantMessageId: string,
    signal: AbortSignal,
    performance: ClientTurnPerformance,
    startedAt: number,
    pendingStop: PendingTurnStop,
  ) => {
    let accumulated = '';
    const liveKey = liveAnswers.key(threadId, assistantMessageId);
    const dispatcher = createChatEventFrameDispatcher((event) => {
      if (event.type === 'delta') {
        accumulated += event.value;
        liveAnswers.write(liveKey, accumulated);
        return;
      }
      if (event.type === 'content') accumulated = event.value;
      if (event.type === 'snapshot') accumulated = event.message.content;
      liveAnswers.write(liveKey, accumulated);
      const contentAtEvent = accumulated;
      setThreads((current) => updateThreadMessage(
        current,
        threadId,
        assistantMessageId,
        (message) => applyChatStreamEvent({ ...message, content: contentAtEvent }, event),
      ));
    }, undefined, { onEventApplied: (event) => performance.eventApplied(event) });
    try {
      await consumeRecoverableChatStream({
        request,
        signal,
        startedAt,
        pendingStop,
        onEvent: dispatcher.dispatch,
        onMeasurement: (measurement) => performance.transportMeasured(measurement),
        waitForRetry: (retrySignal) => new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            window.removeEventListener("online", online);
            retrySignal.removeEventListener("abort", abort);
            if (streamRetryRef.current.get(threadId) === resume) streamRetryRef.current.delete(threadId);
          };
          const resume = () => { cleanup(); resolve(); };
          const online = () => { if (!pendingStop.retriesPaused) resume(); };
          const abort = () => { cleanup(); reject(retrySignal.reason ?? new DOMException("Aborted", "AbortError")); };
          streamRetryRef.current.set(threadId, resume);
          window.addEventListener("online", online);
          retrySignal.addEventListener("abort", abort, { once: true });
          if (retrySignal.aborted) abort();
        }),
        onAccepted: () => {
          pendingStop.confirmAdmission();
          dispatcher.dispatch({
            type: "activity",
            item: {
              id: "client-request-status",
              kind: "system",
              label: t("Solicitud aceptada"),
              status: "complete",
            },
          });
          performance.feedbackApplied("accepted");
        },
        onRecoveryState: (state: ChatStreamRecoveryState) => {
          if (state.state === "paused") {
            setStreamRecoveryNotice({ threadId, assistantMessageId, attempt: null, admissionUnconfirmed: state.admissionUnconfirmed });
            return;
          }
          if (state.state === "recovering") {
            performance.reconnectStarted();
            setStreamRecoveryNotice(current => current?.threadId === threadId && current.attempt === null
              ? { threadId, assistantMessageId, attempt: state.attempt } : current);
            return;
          }
          if (state.state === "stalled") {
            setStreamRecoveryNotice({ threadId, assistantMessageId, attempt: state.attempt });
            return;
          }
          setStreamRecoveryNotice((current) => current?.threadId === threadId &&
            current.assistantMessageId === assistantMessageId ? null : current);
        },
      });
    } finally {
      dispatcher.close();
      const finalContent = accumulated;
      setThreads(current => updateThreadMessage(current, threadId, assistantMessageId, message =>
        message.status === 'streaming' ? { ...message, content: finalContent } : message));
      setStreamRecoveryNotice((current) => current?.threadId === threadId &&
        current.assistantMessageId === assistantMessageId ? null : current);
    }
  }, [t, liveAnswers]);

  const sendMessage = useCallback(async (messageOverride?: string, displayMessageOverride?: string) => {
    if (pendingSelectionRef.current !== null) return false;
    const visibleContent = (displayMessageOverride ?? messageOverride ?? prompt).trim();
    const runtimeContent = (messageOverride ?? (pendingRuntimeContext
      ? `${prompt.trim()}\n\n${pendingRuntimeContext}`
      : prompt)).trim();
    const hasAttachment = attachments.length > 0 || documents.some((document) => document.status === "ready");
    if ((!visibleContent && !hasAttachment) || (!runtimeContent && !hasAttachment) || sending || documentUploading || documents.some((document) => document.status !== "ready") || !activeProject || activeProject.status !== "active") return;

    const initialThreadId = activeThread?.id ?? null;
    const selectionAtStart = {
      projectId: activeProject.id,
      threadId: initialThreadId,
    };
    const selectionGenerationAtStart = selectionGenerationRef.current;
    const selectionDraftKey = composerDraftKey(selectionAtStart.projectId, selectionAtStart.threadId);
    let reservationKey = initialThreadId ?? `project:${activeProject.id}:new`;
    if (turnReservationsRef.current.has(reservationKey)) return;
    const reservation = { cancelled: false };
    turnReservationsRef.current.set(reservationKey, reservation);
    const sendIntentAt = performance.now();
    if (!initialThreadId) {
      setStartingDraftKeys((current) => new Set(current).add(selectionDraftKey));
    }
    let thread = activeThread && activeThread.status === "active" &&
      activeThread.projectId === activeProject.id ? activeThread : null;
    let assistantMessage: ChatMessage | null = null;
    let controller: AbortController | null = null;
    let clientTurnPerformance: ClientTurnPerformance | null = null;
    let ownsVisibleComposer = true;
    let succeeded = false;
    try {
      if (!thread) {
        const title = titleFromMessage(visibleContent || attachments[0]?.name || documents.find((document) => document.status === "ready")?.name || t("Archivos adjuntos"));
        thread = initialWorkbench.persistence === "browser-preview"
          ? localThread(activeProject.id, title)
          : await createThreadRequest(activeProject.id, title);
        setThreads((current) => [thread as WorkbenchThread, ...current]);
        // No chat POST exists yet, so local cancellation is definitive for this
        // send. Preserve the empty server-created thread without adopting it or
        // consuming its draft/files. The rest of the handoff is synchronous up
        // to registering PendingTurnStop, which owns every submitted turn.
        if (reservation.cancelled) return false;
        // The created thread now owns this reservation; another new draft in
        // the same project has a separate Stop target and may send in parallel.
        turnReservationsRef.current.delete(reservationKey);
        reservationKey = thread.id;
        turnReservationsRef.current.set(reservationKey, reservation);
        if (!initialThreadId) setStartingDraftKeys(current => {
          const next = new Set(current); next.delete(selectionDraftKey); return next;
        });
        ownsVisibleComposer = selectionGenerationRef.current === selectionGenerationAtStart &&
          activeSelectionRef.current.projectId === selectionAtStart.projectId &&
          activeSelectionRef.current.threadId === selectionAtStart.threadId;
        if (ownsVisibleComposer) {
          adoptCurrentComposerThread(activeProject.id, thread.id);
          setActiveThreadId(thread.id);
          threadByProjectRef.current[activeProject.id] = thread.id;
        }
      }

      const startedAt = new Date();
      const userMessage = createMessage(
        crypto.randomUUID(),
        "user",
        visibleContent,
        "complete",
        startedAt.toISOString(),
      );
      if (selectedConnectorMentionIds.length) userMessage.connectorMentions = selectedConnectorMentionIds;
      if (selectedServerReferences.length) userMessage.serverReferences = selectedServerReferences;
      const readyDocuments = documents.filter((document) => document.status === "ready");
      const documentUploadIds = readyDocuments.length
        ? readyDocuments.map(document => document.uploadId)
        : attachments.length || initialWorkbench.persistence === "browser-preview" || workbenchProjectAccess(activeProject).role !== "owner"
          ? [] : continuingDocumentUploads(thread.messages, thread.lineage ? thread.createdAt : undefined);
      userMessage.attachments = [
        ...attachments.map(({ dataUrl: _dataUrl, ...attachment }) => attachment),
        ...readyDocuments.map(({ uploadId: _uploadId, threadId: _threadId, kind: _kind, previewFiles: _previewFiles, pages: _pages, status: _status, error: _error, passive: _passive, processingUnavailable: _processingUnavailable, previewUnavailable: _previewUnavailable, ...attachment }) => attachment),
      ];
      assistantMessage = createMessage(
        crypto.randomUUID(),
        "assistant",
        "",
        "streaming",
        new Date(startedAt.getTime() + 1).toISOString(),
      );
      assistantMessage.activity = [{
        id: "client-request-status",
        kind: "system",
        label: t("Enviando solicitud"),
        status: "running",
      }];
      const threadId = thread.id;
      const assistantId = assistantMessage.id;
      clientTurnPerformance = new ClientTurnPerformance(
        (readback) => setClientTurnReadbacks((current) => retainClientTurnReadback(current, assistantId, readback)),
        undefined,
        sendIntentAt,
      );
      setRunningThreadIds((current) => {
        const next = new Set(current);
        next.add(threadId);
        return next;
      });
      setThreads((current) => current.map((candidate) => candidate.id === threadId
        ? {
            ...candidate,
            updatedAt: startedAt.toISOString(),
            messages: [...candidate.messages, userMessage, assistantMessage as ChatMessage],
          }
        : candidate));
      clientTurnPerformance.feedbackApplied("local");
      setComposerDrafts((current) => {
        const next = { ...current };
        // Consume only the exact draft that started this turn. If the user
        // left, came back and typed a newer draft while thread creation was
        // pending, that newer value belongs to the visible composer.
        if (next[selectionDraftKey] === prompt) delete next[selectionDraftKey];
        const threadDraftKey = composerDraftKey(activeProject.id, threadId);
        if (next[threadDraftKey] === prompt) delete next[threadDraftKey];
        composerDraftsRef.current = next;
        return next;
      });
      setServerDrafts(current => {
        if (current[selectionDraftKey] !== selectedServerReferences) return current;
        const next = { ...current }; delete next[selectionDraftKey]; return next;
      });
      if (ownsVisibleComposer) {
        setSelectedMessageId(assistantId);
        promptRef.current = "";
        setPrompt("");
        setPendingRuntimeContext(null);
        setAttachments([]);
        setDocuments([]);
        setConnectorDrafts(current => {
          const next = { ...current };
          if (next[selectionDraftKey] === selectedConnectorMentionIds) delete next[selectionDraftKey];
          return next;
        });
        setImageGeneration(false);
      }

      controller = new AbortController();
      const stopRequestId = crypto.randomUUID();
      const pendingStop = new PendingTurnStop({
        sendControl: async ({ admissionConfirmed }) => {
          try {
            const response = await fetch("/api/runtime/turns/control", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "stop", threadId, assistantMessageId: assistantId, clientRequestId: stopRequestId }),
              signal: AbortSignal.timeout(10_000),
            });
            const payload: unknown = await response.json().catch(() => null);
            const acceptedControl = response.ok && stopControlAccepted(payload);
            // A bound Stop can reach the authorized thread before /api/chat
            // creates its projection. Admission retries the same control identity;
            // only that pre-admission absence is provisional, never a stopped turn.
            const awaitingProjection = !admissionConfirmed && response.status === 404 &&
              payload && typeof payload === "object" && "code" in payload &&
              payload.code === "TURN_PROJECTION_NOT_FOUND";
            if (!acceptedControl && !awaitingProjection) {
              if (pendingStop.terminalObserved || await reconcileTurnAfterStopFailure(threadId, assistantId, activeProject.id) || pendingStop.terminalObserved) return false;
              if (turnControllersRef.current.get(threadId)?.stop === pendingStop) {
                const text = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
                  ? payload.error : t("No s’ha pogut confirmar l’aturada amb el runtime.");
                setNotice(workbenchNotice(text, "error"));
              }
            }
            return acceptedControl;
          } catch {
            if (pendingStop.terminalObserved || await reconcileTurnAfterStopFailure(threadId, assistantId, activeProject.id) || pendingStop.terminalObserved) return false;
            if (turnControllersRef.current.get(threadId)?.stop === pendingStop) setNotice(workbenchNotice(t("S’ha perdut la connexió mentre s’aturava el torn."), "error"));
            return false;
          }
        },
        onPause: () => setStreamRecoveryNotice({ threadId, assistantMessageId: assistantId, attempt: null, admissionUnconfirmed: true }),
        onBusy: busy => {
          if (turnControllersRef.current.get(threadId)?.stop !== pendingStop) return;
          setStoppingThreadIds(current => { const next = new Set(current); if (busy) next.add(threadId); else next.delete(threadId); return next; });
        },
      });
      turnControllersRef.current.set(threadId, { assistantMessageId: assistantId, controller, stop: pendingStop });
      const streamRequestedAt = performance.now();
      // This serialized request is deliberately reused verbatim for every
      // reattach, preserving the server's idempotency key and turn identity.
      const chatRequest = JSON.stringify({
        projectId: activeProject.id,
        threadId,
        userMessageId: userMessage.id,
        assistantMessageId: assistantId,
        message: runtimeContent,
        ...(visibleContent !== runtimeContent ? { displayMessage: visibleContent } : {}),
        preferences: {
          tone: preferences.tone,
          language: manifest.identity.language,
          showActivity: preferences.showActivityPanel,
        },
        options: {
          mode: "agent",
          experience: composerExperience,
          model: null,
          effort: null,
          webSearch: true,
          imageGeneration,
          skill: selectedSkill,
          ...(selectedConnectorMentionIds.length ? { connectorMentions: selectedConnectorMentionIds } : {}),
          attachments,
          ...(selectedServerReferences.length ? { serverReferences: selectedServerReferences } : {}),
          ...(documentUploadIds.length ? { documentUploadIds } : {}),
        },
      });
      await handleStream(createChatReattachRequest(chatRequest), threadId, assistantId, controller.signal, clientTurnPerformance, streamRequestedAt, pendingStop);
      succeeded = true;
    } catch (error) {
      if (reservation.cancelled) return false;
      if (thread && assistantMessage) {
        const stopped = controller?.signal.aborted === true;
        clientTurnPerformance?.terminalStateApplied(stopped ? "stopped" : "error");
        const failedThreadId = thread.id;
        const failedMessageId = assistantMessage.id;
        setThreads((current) => updateThreadMessage(
          current,
          failedThreadId,
          failedMessageId,
          (message) => ({
            ...message,
            status: stopped ? "stopped" : "error",
            ...(!stopped && !message.content
              ? { content: error instanceof Error ? t(error.message) : t("Error desconocido") }
              : {}),
          }),
        ));
      } else {
        setNotice(workbenchNotice(error instanceof Error ? error.message : t("No se ha podido crear la conversación."), "error"));
      }
    } finally {
      if (thread) {
        const threadId = thread.id;
        if (controller && turnControllersRef.current.get(threadId)?.controller === controller) {
          turnControllersRef.current.get(threadId)?.stop.dispose();
          turnControllersRef.current.delete(threadId);
          setStoppingThreadIds(current => { const next = new Set(current); next.delete(threadId); return next; });
        }
        setRunningThreadIds((current) => {
          if (!current.has(threadId)) return current;
          const next = new Set(current);
          next.delete(threadId);
          return next;
        });
      }
      if (turnReservationsRef.current.get(reservationKey) === reservation) {
        turnReservationsRef.current.delete(reservationKey);
        if (!initialThreadId && reservationKey === `project:${activeProject.id}:new`) {
          setStartingDraftKeys((current) => {
            if (!current.has(selectionDraftKey)) return current;
            const next = new Set(current);
            next.delete(selectionDraftKey);
            return next;
          });
        }
      }
    }
    return succeeded;
  }, [activeProject, activeThread, adoptCurrentComposerThread, attachments, composerExperience, documentUploading, documents, handleStream, imageGeneration, initialWorkbench.persistence, manifest.identity.language, pendingRuntimeContext, preferences, prompt, reconcileTurnAfterStopFailure, selectedConnectorMentionIds, selectedServerReferences, selectedSkill, sending, t]);

  const submitComposerMessage = useCallback((messageOverride?: string, displayMessageOverride?: string) => {
    if (pendingSelectionRef.current !== null || documentUploading || documents.some((document) => document.status !== "ready")) return;
    if (!sending) {
      void sendMessage(messageOverride, displayMessageOverride);
      return;
    }

    if (selectedServerReferences.length) { setNotice(workbenchNotice(t("Espera a que termine la respuesta para enviar las referencias Server."), "warning")); return; }
    const displayContent = (displayMessageOverride ?? messageOverride ?? promptRef.current).trim();
    const promptContent = (messageOverride ?? promptRef.current).trim();
    const runtimeContent = (messageOverride ?? (pendingRuntimeContext
      ? `${promptContent}\n\n${pendingRuntimeContext}`
      : promptContent)).trim();
    if (!displayContent || !runtimeContent || !activeProject || !activeThread || activeThread.status !== "active") return;
    if (queuedTurns.filter((item) => item.threadId === activeThread.id).length >= MAX_QUEUED_MESSAGES_PER_THREAD) {
      setNotice(workbenchNotice(t("La cola admite hasta {p0} mensajes por conversación.", { p0: MAX_QUEUED_MESSAGES_PER_THREAD }), "warning"));
      return;
    }

    setQueuedTurns((current) => [...current, {
      id: crypto.randomUUID(),
      projectId: activeProject.id,
      threadId: activeThread.id,
      runtimeContent,
      displayContent,
    }]);
    updateComposerPrompt("");
    setPendingRuntimeContext(null);
  }, [activeProject, activeThread, documentUploading, documents, pendingRuntimeContext, queuedTurns, selectedServerReferences, sendMessage, sending, updateComposerPrompt, t]);

  const submitOutreachMessage = useCallback((messageOverride?: string, displayMessageOverride?: string) => {
    if (!outreachOpen || !insijetsOutreachAccess) {
      submitComposerMessage(messageOverride, displayMessageOverride);
      return;
    }
    const visible = (displayMessageOverride ?? messageOverride ?? promptRef.current).trim();
    const content = messageOverride ?? (pendingRuntimeContext
      ? `${promptRef.current.trim()}\n\n${pendingRuntimeContext}` : promptRef.current);
    submitComposerMessage(withOutreachPaneContext(content, outreachPaneContext), visible);
  }, [insijetsOutreachAccess, outreachOpen, outreachPaneContext, pendingRuntimeContext, submitComposerMessage]);

  useEffect(() => {
    if (selectionLoading || pendingSelectionRef.current !== null || sending || actionBusy || documentUploading || dispatchingQueuedTurnId || !activeProject || !activeThread) return;
    const next = queuedTurns.find((item) =>
      item.projectId === activeProject.id && item.threadId === activeThread.id);
    if (!next) return;

    setDispatchingQueuedTurnId(next.id);
    setQueuedTurns((current) => current.filter((item) => item.id !== next.id));
    void sendMessage(next.runtimeContent, next.displayContent)
      .then((completed) => {
        if (!completed) setNotice(workbenchNotice(t("No se ha podido enviar el siguiente mensaje de la cola."), "error"));
      })
      .finally(() => setDispatchingQueuedTurnId(null));
  }, [actionBusy, activeProject, activeThread, dispatchingQueuedTurnId, documentUploading, queuedTurns, selectionLoading, sendMessage, sending, t]);

  useEffect(() => {
    const activeThreadIds = new Set(threads
      .filter((thread) => thread.status === "active")
      .map((thread) => thread.id));
    setQueuedTurns((current) => {
      const retained = current.filter((item) => activeThreadIds.has(item.threadId));
      return retained.length === current.length ? current : retained;
    });
  }, [threads]);

  const branchConversation = useCallback(async (
    message: ChatMessage,
    input: BranchThreadInput,
    autoSend: boolean,
  ) => {
    if (!activeThread || sending || actionBusy) return;
    setActionBusy(true);
    try {
      const result = initialWorkbench.persistence === "browser-preview"
        ? localBranchThread(activeThread, input)
        : await branchThreadRequest(activeThread.id, input);
      setThreads((current) => [result.thread, ...current]);
      switchComposerSelection({ projectId: result.thread.projectId, threadId: result.thread.id });
      setActiveProjectId(result.thread.projectId);
      setActiveThreadId(result.thread.id);
      threadByProjectRef.current[result.thread.projectId] = result.thread.id;
      setSelectedMessageId(null);
      if (result.draftMessage) {
        setComposerDrafts((current) => {
          const next = {
            ...current,
            [composerDraftKey(result.thread.projectId, result.thread.id)]: result.draftMessage as string,
          };
          composerDraftsRef.current = next;
          return next;
        });
        promptRef.current = result.draftMessage;
        setPrompt(result.draftMessage);
      }
      setPendingRuntimeContext(null);
      setAttachments([]);
      setDocuments([]);
      setActiveSideWindow(null);
      if (autoSend && result.draftMessage) {
        setPendingBranchSend({ threadId: result.thread.id, content: result.draftMessage });
      } else {
        setNotice(workbenchNotice(t("Rama creada. La conversación original se conserva intacta."), "success"));
      }
    } catch (error) {
      setNotice(workbenchNotice(error instanceof Error ? error.message : t("No se ha podido crear la rama."), "error"));
    } finally {
      setActionBusy(false);
    }
  }, [actionBusy, activeThread, initialWorkbench.persistence, sending, switchComposerSelection, t]);

  useEffect(() => {
    if (selectionLoading || pendingSelectionRef.current !== null || !pendingBranchSend || pendingBranchSend.threadId !== activeThreadId || sending || actionBusy) return;
    const pending = pendingBranchSend;
    setPendingBranchSend(null);
    void sendMessage(pending.content);
  }, [actionBusy, activeThreadId, pendingBranchSend, selectionLoading, sendMessage, sending]);

  const stopActiveTurn = useCallback(async () => {
    if (!activeThread && activeProjectId) {
      const reservationKey = `project:${activeProjectId}:new`;
      const pendingDraft = turnReservationsRef.current.get(reservationKey);
      if (pendingDraft) {
        pendingDraft.cancelled = true;
        turnReservationsRef.current.delete(reservationKey);
        const draftKey = composerDraftKey(activeProjectId, null);
        setStartingDraftKeys(current => {
          const next = new Set(current); next.delete(draftKey); return next;
        });
        return;
      }
    }
    const activeRun = activeThread ? turnControllersRef.current.get(activeThread.id) : null;
    const controller = activeRun?.controller;
    const activeAssistant = activeThread
      ? [...activeThread.messages].reverse().find((message) =>
          message.role === "assistant" && message.status === "streaming" &&
          (!activeRun || message.id === activeRun.assistantMessageId))
      : null;
    if (initialWorkbench.persistence === "filesystem" && activeThread && activeRun) {
      if (!stoppingThreadIds.has(activeThread.id)) await activeRun.stop.requestStop();
      return;
    }
    if (initialWorkbench.persistence !== "filesystem" || !activeThread || !activeAssistant) {
      controller?.abort();
      return;
    }
    if (stoppingThreadIds.has(activeThread.id)) return;
    setStoppingThreadIds((current) => new Set(current).add(activeThread.id));
    try {
      const response = await fetch("/api/runtime/turns/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "stop",
          threadId: activeThread.id,
          assistantMessageId: activeAssistant.id,
          clientRequestId: crypto.randomUUID(),
        }),
      });
      if (!response.ok) {
        if (await reconcileTurnAfterStopFailure(activeThread.id, activeAssistant.id, activeThread.projectId)) return;
        const payload: unknown = await response.json().catch(() => null);
        const message = payload && typeof payload === "object" && "error" in payload &&
          typeof payload.error === "string"
          ? payload.error
          : t("No s’ha pogut confirmar l’aturada amb el runtime.");
        setNotice(workbenchNotice(message, "error"));
      }
    } catch {
      if (!await reconcileTurnAfterStopFailure(activeThread.id, activeAssistant.id, activeThread.projectId)) {
        setNotice(workbenchNotice(t("S’ha perdut la connexió mentre s’aturava el torn."), "error"));
      }
    } finally {
      // Keep the stream attached until the runtime confirms stopped/error.
      // Aborting here converted even rejected or pending stops into a false
      // local success, which changed back to an error after refresh.
      setStoppingThreadIds((current) => {
        const next = new Set(current);
        next.delete(activeThread.id);
        return next;
      });
    }
  }, [activeProjectId, activeThread, initialWorkbench.persistence, reconcileTurnAfterStopFailure, stoppingThreadIds, t]);

  const resolveApproval = useCallback(async (
    messageId: string,
    selectedApproval: ApprovalItem,
    decision: ApprovalDecision,
  ) => {
    if (!activeThreadId) return;
    const managedAppAction = managedAppActionForApproval(managedAppActions, selectedApproval);
    if (managedAppAction) {
      if (managedAppAction.locator.threadId !== activeThreadId || managedAppAction.locator.turnId !== messageId) {
        setNotice(workbenchNotice(t("La acción conectada ya no corresponde a esta conversación."), "warning"));
        return;
      }
      const result = await resolveManagedAppAction(fetch, managedAppAction, {
        threadId: activeThreadId,
        turnId: messageId,
      }, decision);
      if (result.state === "recoverable") {
        setNotice(workbenchNotice(result.stage === "current-thread"
          ? t("Vuelve a la conversación original para resolver esta acción conectada.")
          : t("La acción conectada sigue pendiente. Puedes volver a intentarlo."), "warning"));
        return;
      }
      setManagedAppActions((current) => forgetManagedAppAction(current, selectedApproval));
      setThreads((current) => updateThreadMessage(current, activeThreadId, messageId, (message) => ({
        ...message,
        approvals: message.approvals.map((approval) => approval.id === selectedApproval.id ? result.approval : approval),
        toolResults: [
          ...(message.toolResults ?? []).filter((item) => item.id !== `managed-app:${selectedApproval.id}`),
          managedAppOutcomeResult(selectedApproval.id, result.outcome),
        ],
      })));
      return;
    }
    const response = await fetch("/api/runtime/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(approvalResolutionForItem(selectedApproval, decision)),
    });
    if (!response.ok) {
      setNotice(workbenchNotice(t("Esta aprobación ya no está pendiente."), "warning"));
      return;
    }
    const resolved: unknown = await response.json().catch(() => null);
    const themeResult = resolved && typeof resolved === "object" && "themeResult" in resolved
      ? resolved.themeResult as { status?: unknown } : null;
    const verifiedTitle = themeResult?.status === "applied" ? "Shopify draft saved and verified"
      : themeResult?.status === "rolled_back" ? "Shopify draft restored and verified" : null;
    if (verifiedTitle) setNotice(workbenchNotice(t(verifiedTitle), "success"));
    const status = decision === "accept"
      ? "accepted"
      : decision === "acceptForSession" ? "accepted_session" : "declined";
    setThreads((current) => updateThreadMessage(
      current,
      activeThreadId,
      messageId,
      (message) => ({
        ...message,
        approvals: message.approvals.map((approval) =>
          approval.id === selectedApproval.id ? { ...approval, status, ...(verifiedTitle ? { title: verifiedTitle } : {}) } : approval),
      }),
    ));
  }, [activeThreadId, managedAppActions, t]);

  const prepareManagedAppAction = useCallback((descriptor: ManagedAppActionDescriptor) => {
    if (!activeThreadId || descriptor.locator.threadId !== activeThreadId ||
        descriptor.locator.turnId !== descriptor.approval.turnId) return;
    setThreads((current) => updateThreadMessage(current, activeThreadId, descriptor.locator.turnId, (message) => ({
      ...message,
      approvals: [
        ...message.approvals.filter((approval) => approval.id !== descriptor.approval.id),
        descriptor.approval,
      ],
    })));
    setManagedAppActions((current) => rememberManagedAppAction(current, descriptor));
  }, [activeThreadId]);

  const persistProjectPatch = useCallback(async (
    project: WorkbenchProject,
    patch: UpdateProjectInput,
  ) => {
    setActionBusy(true);
    try {
      const updated: WorkbenchProject = initialWorkbench.persistence === "browser-preview"
        ? {
            ...project,
            ...patch,
            ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
            updatedAt: new Date().toISOString(),
          }
        : await updateProjectRequest(project.id, patch);
      const nextProjects = projects.map((candidate) => candidate.id === project.id ? updated : candidate);
      setProjects(nextProjects);
      if (updated.status === "archived" && activeProjectId === updated.id) {
        const next = newThreadDestination(nextProjects);
        switchComposerSelection({ projectId: next?.id ?? null, threadId: null });
        setActiveProjectId(next?.id ?? null);
        setActiveThreadId(null);
        setSelectedMessageId(null);
      }
      return updated;
    } catch (error) {
      setNotice(workbenchNotice(error instanceof Error ? error.message : t("No se ha podido actualizar el proyecto."), "error"));
      return null;
    } finally {
      setActionBusy(false);
    }
  }, [activeProjectId, initialWorkbench.persistence, projects, switchComposerSelection, t]);

  const persistThreadPatch = useCallback(async (
    thread: WorkbenchThread,
    patch: UpdateThreadInput,
  ) => {
    setActionBusy(true);
    try {
      const updated: WorkbenchThread = initialWorkbench.persistence === "browser-preview"
        ? {
            ...thread,
            ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
            ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            updatedAt: new Date().toISOString(),
          }
        : await updateThreadRequest(thread.id, patch);
      const replaced = threads.map((candidate) => candidate.id === thread.id ? updated : candidate);
      const nextThreads = patch.pinned === true
        ? [updated, ...replaced.filter((candidate) => candidate.id !== updated.id)]
        : replaced;
      setThreads(nextThreads);
      if (updated.status === "archived" && activeThreadId === updated.id) {
        const next = firstActiveThread(nextThreads, updated.projectId);
        switchComposerSelection({ projectId: updated.projectId, threadId: next?.id ?? null });
        setActiveThreadId(next?.id ?? null);
        setSelectedMessageId(null);
      }
      return updated;
    } catch (error) {
      setNotice(workbenchNotice(error instanceof Error ? error.message : t("No se ha podido actualizar la conversación."), "error"));
      return null;
    } finally {
      setActionBusy(false);
    }
  }, [activeThreadId, initialWorkbench.persistence, switchComposerSelection, threads, t]);

  const submitTextDialog = useCallback(async (value: string) => {
    if (!textDialog) return;
    if (textDialog.kind === "create-project") {
      setActionBusy(true);
      try {
        const project = initialWorkbench.persistence === "browser-preview"
          ? localProject(projects, value)
          : await createProjectRequest(value);
        setProjects((current) => [project, ...current]);
        switchComposerSelection({ projectId: project.id, threadId: null });
        setActiveProjectId(project.id);
        setActiveThreadId(null);
        setSelectedMessageId(null);
        closeTextDialog();
      } catch (error) {
        setNotice(workbenchNotice(error instanceof Error ? error.message : t("No se ha podido crear el proyecto."), "error"));
      } finally {
        setActionBusy(false);
      }
      return;
    }
    if (textDialog.kind === "rename-project") {
      if (await persistProjectPatch(textDialog.project, { name: value })) closeTextDialog();
      return;
    }
    if (await persistThreadPatch(textDialog.thread, { title: value })) closeTextDialog();
  }, [closeTextDialog, initialWorkbench.persistence, persistProjectPatch, persistThreadPatch, projects, switchComposerSelection, textDialog, t]);

  const handleProjectAction = useCallback(async (project: WorkbenchProject, action: ProjectMenuAction, returnFocus?: HTMLElement | null) => {
    if (action === "settings") {
      if (!await selectProject(project.id)) return;
      beginSidebarOverlay("project", returnFocus);
      setProjectOpen(true);
      return;
    }
    if (action === "archive" && threads.some((thread) =>
      thread.projectId === project.id &&
      (threadActivityById[thread.id]?.state === "running" ||
        threadActivityById[thread.id]?.state === "needs_attention"))) {
      setNotice(workbenchNotice(t("Detén o resuelve las conversaciones en curso antes de archivar el proyecto."), "warning"));
      return;
    }
    if (action === "rename") {
      beginSidebarOverlay("text", returnFocus);
      setTextDialog({ kind: "rename-project", project });
    } else if (action === "archive") {
      beginSidebarOverlay("confirm", returnFocus);
      setConfirmDialog({ kind: "archive-project", project });
    }
    else if (action === "restore") void persistProjectPatch(project, { status: "active" });
    else void persistProjectPatch(project, { pinned: action === "pin" });
  }, [beginSidebarOverlay, persistProjectPatch, selectProject, threadActivityById, threads, t]);

  const handleThreadAction = useCallback((thread: WorkbenchThread, action: ThreadMenuAction, returnFocus?: HTMLElement | null) => {
    const workState = threadActivityById[thread.id]?.state;
    if ((action === "archive" || action === "remove") && (workState === "running" || workState === "needs_attention")) {
      setNotice(workbenchNotice(t("Detén o resuelve esta conversación antes de archivarla."), "warning"));
      return;
    }
    if (action === "rename") {
      beginSidebarOverlay("text", returnFocus);
      setTextDialog({ kind: "rename-thread", thread });
    } else if (action === "archive") {
      beginSidebarOverlay("confirm", returnFocus);
      setConfirmDialog({ kind: "archive-thread", thread });
    } else if (action === "remove") {
      beginSidebarOverlay("confirm", returnFocus);
      setConfirmDialog({ kind: "remove-thread", thread });
    }
    else if (action === "restore") void persistThreadPatch(thread, { status: "active" });
    else void persistThreadPatch(thread, { pinned: action === "pin" });
  }, [beginSidebarOverlay, persistThreadPatch, threadActivityById, t]);

  const confirmAction = useCallback(async () => {
    if (!confirmDialog) return;
    if (confirmDialog.kind === "undo-result") {
      if (!activeThreadId) return;
      setActionBusy(true);
      const target = confirmDialog.message;
      try {
        const updateState = async (action: "undo_waiting" | "undo_complete") => {
          const response = await fetch(`/api/threads/${activeThreadId}/messages/${target.id}/result`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
          });
          const result: unknown = await response.json().catch(() => null);
          if (!response.ok || !result || typeof result !== "object" || !("message" in result)) {
            throw new Error(t("No se ha podido guardar el estado de la reversión."));
          }
          const updated = result.message as ChatMessage;
          setThreads((current) => updateThreadMessage(current, activeThreadId, target.id, () => updated));
        };
        await updateState("undo_waiting");
        closeConfirmDialog();
        setActionBusy(false);
        const completed = await sendMessage(
          t("Revierte exclusivamente los cambios de este resultado. Antes de terminar, comprueba el estado final y explica qué se ha restaurado.\n\nCambios originales:\n{p0}", { p0: target.diff.slice(0, 10_000) }),
          t("Deshaz los cambios de este resultado y comprueba que todo queda restaurado."),
        );
        setActionBusy(true);
        if (!completed) throw new Error(t("La reversió no s’ha pogut verificar."));
        await updateState("undo_complete");
        setNotice(workbenchNotice(t("Cambios revertidos y verificados. El estado se ha guardado."), "success"));
      } catch (error) {
        setNotice(workbenchNotice(error instanceof Error ? error.message : t("No se ha podido completar la reversión."), "error"));
      } finally {
        setActionBusy(false);
      }
      return;
    }
    const updated = confirmDialog.kind === "archive-project"
      ? await persistProjectPatch(confirmDialog.project, { status: "archived" })
      : await persistThreadPatch(confirmDialog.thread, { status: "archived" });
    if (updated) closeConfirmDialog();
  }, [activeThreadId, closeConfirmDialog, confirmDialog, persistProjectPatch, persistThreadPatch, sendMessage, t]);

  const changePreference = useCallback(
    <Key extends keyof BrainPreferences>(key: Key, value: BrainPreferences[Key]) => {
      setPreferences((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const enabledWindows = manifest.windows.filter((window) =>
    window.enabled && (window.id === "chat" || window.id === "inspector"));
  const inspectorEnabled = enabledWindows.some((window) => window.id === "inspector");
  const blockingModalSurfaceOpen = customizationOpen || projectOpen || commandPaletteOpen || mobileSidebarOpen ||
    taskCenterOpen || automationsBlockingSurfaceOpen || Boolean(textDialog) || Boolean(confirmDialog) || Boolean(previewDocument);
  const modalSurfaceOpen = blockingModalSurfaceOpen ||
    (compactOverlayLayout && Boolean(activeSideWindow));

  useEffect(() => {
    if (!taskCenterRequested || modalSurfaceOpen) return;
    setTaskCenterRequested(false);
    setTaskCenterOpen(true);
  }, [modalSurfaceOpen, taskCenterRequested]);


  const toggleSidebar = useCallback((opener?: HTMLElement | null) => {
    if (window.matchMedia("(min-width: 768px)").matches) {
      setDesktopSidebarOpen((current) => !current);
      return;
    }
    mobileSidebarHandoffRef.current = null;
    sidebarReturnFocusRef.current = null;
    setMobileSidebarRestoreFocus(false);
    setMobileSidebarOpen((current) => {
      if (!current) {
        mobileSidebarOpenerRef.current = opener ?? (
          document.activeElement instanceof HTMLElement ? document.activeElement : null
        );
      }
      return !current;
    });
  }, []);

  useEffect(() => {
    const desktopQuery = window.matchMedia("(min-width: 768px)");
    const closeMobileSidebar = (event: MediaQueryListEvent) => {
      if (!event.matches) return;
      mobileSidebarHandoffRef.current = null;
      sidebarReturnFocusRef.current = null;
      mobileSidebarOpenerRef.current = null;
      setMobileSidebarRestoreFocus(false);
      setMobileSidebarOpen(false);
    };
    if (desktopQuery.matches) {
      mobileSidebarHandoffRef.current = null;
      sidebarReturnFocusRef.current = null;
      mobileSidebarOpenerRef.current = null;
      setMobileSidebarRestoreFocus(false);
      setMobileSidebarOpen(false);
    }
    desktopQuery.addEventListener("change", closeMobileSidebar);
    return () => desktopQuery.removeEventListener("change", closeMobileSidebar);
  }, []);

  useEffect(() => {
    const compactQuery = window.matchMedia("(max-width: 1279px)");
    const syncCompactLayout = () => {
      if (compactQuery.matches && blockingModalSurfaceOpen) setActiveSideWindow(null);
      setCompactOverlayLayout(compactQuery.matches);
    };
    const frame = requestAnimationFrame(syncCompactLayout);
    compactQuery.addEventListener("change", syncCompactLayout);
    return () => {
      cancelAnimationFrame(frame);
      compactQuery.removeEventListener("change", syncCompactLayout);
    };
  }, [blockingModalSurfaceOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const modifier = (event.metaKey || event.ctrlKey) && event.metaKey !== event.ctrlKey;
      const editing = isEditableShortcutTarget(event.target);
      const searchShortcut = modifier && !event.altKey && !event.shiftKey && event.code === "KeyK";
      if (searchShortcut) {
        event.preventDefault();
        if (event.repeat) return;
        if (commandPaletteOpen) {
          closeCommandPalette();
        } else if (!modalSurfaceOpen) {
          setCommandPaletteOpen(true);
        }
        return;
      }
      const taskCenterShortcut = !event.shiftKey && isTaskCenterShortcut(event);
      if (taskCenterShortcut) {
        event.preventDefault();
        if (event.repeat) return;
        if (taskCenterOpen) {
          setTaskCenterOpen(false);
        } else if (!modalSurfaceOpen && !editing) {
          setTaskCenterOpen(true);
        }
        return;
      }
      if (event.key !== "Escape") return;
      if (commandPaletteOpen) closeCommandPalette();
      else if (taskCenterOpen) setTaskCenterOpen(false);
      else if (customizationOpen) closeCustomization();
      else if (productView) setProductView(null);
      else if (insijetsPanel) { if (canLeaveInsiJetsCMS()) setInsiJetsPanel(null); }
      else if (automationsOpen) setAutomationsOpen(false);
      else if (textDialog && !actionBusy) closeTextDialog();
      else if (confirmDialog && !actionBusy) closeConfirmDialog();
      else if (previewDocument) setPreviewDocument(null);
      else if (activeSideWindow) setActiveSideWindow(null);
      else if (mobileSidebarOpen) dismissMobileSidebar();
      else if (outreachOpen) setOutreachOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    actionBusy,
    activeSideWindow,
    closeCommandPalette,
    commandPaletteOpen,
    closeConfirmDialog,
    closeCustomization,
    closeTextDialog,
    dismissMobileSidebar,
    modalSurfaceOpen,
    confirmDialog,
    customizationOpen,
    automationsOpen,
    productView,
    insijetsPanel,
    canLeaveInsiJetsCMS,
    mobileSidebarOpen,
    previewDocument,
    textDialog,
    taskCenterOpen,
    outreachOpen,
  ]);

  const textDialogCopy = textDialog?.kind === "create-project"
    ? { title: t("Nuevo proyecto"), label: t("Nombre del proyecto"), value: "", submit: t("Crear proyecto"), maxLength: 80 }
    : textDialog?.kind === "rename-project"
      ? { title: t("Renombrar proyecto"), label: t("Nombre del proyecto"), value: textDialog.project.name, submit: t("Guardar"), maxLength: 80 }
      : textDialog?.kind === "rename-thread"
        ? { title: t("Renombrar conversación"), label: t("Título de la conversación"), value: textDialog.thread.title, submit: t("Guardar"), maxLength: 120 }
        : null;
  const noticeLabel = notice?.kind === "error"
    ? "Error"
    : notice?.kind === "warning"
      ? t("Aviso")
      : notice?.kind === "success"
        ? t("Completado")
        : t("Estado");
  const noticeTone = notice?.kind === "error"
    ? "border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]"
    : notice?.kind === "warning"
      ? "border-[var(--warning)] bg-[var(--warning-soft)] text-[var(--warning)]"
      : notice?.kind === "success"
        ? "border-[var(--positive)] bg-[var(--positive-soft)] text-[var(--positive)]"
        : "border-[var(--border)] bg-[var(--surface-raised)] text-[var(--text-secondary)]";

  return (
    <div style={style} className="workbench-shell flex h-[100dvh] overflow-hidden bg-[var(--page)] font-sans text-[var(--text)]">
      <Sidebar
        branding={branding}
        session={session}
        projects={projects}
        threads={threads}
        activeProjectId={activeProjectId}
        activeThreadId={activeThreadId}
        mobileOpen={mobileSidebarOpen}
        mobileInitialFocusRef={mobileSidebarRestoreFocus ? sidebarReturnFocusRef : undefined}
        mobileReturnFocusRef={mobileSidebarOpenerRef}
        desktopOpen={desktopSidebarOpen}
        busy={actionBusy}
        threadActivityById={threadActivityById}
        onCloseMobile={dismissMobileSidebar}
        onCloseDesktop={() => setDesktopSidebarOpen(false)}
        onOpenDesktop={() => setDesktopSidebarOpen(true)}
        onOpenCommandPalette={(returnFocus) => {
          beginSidebarOverlay("command", returnFocus);
          setCommandPaletteOpen(true);
        }}
        insijetsWorkspaceAccess={insijetsWorkspaceAccess}
        insijetsSourcingAccess={insijetsSourcingAccess}
        insijetsOutreachAccess={insijetsOutreachAccess}
        onOpenCMS={() => { if (insijetsWorkspaceAccess && canLeaveInsiJetsCMS()) { setOutreachOpen(false); setMobileSidebarOpen(false); setAutomationsOpen(false); setInsiJetsPanel("cms"); } }}
        onOpenPriceIndex={() => { if (insijetsWorkspaceAccess && canLeaveInsiJetsCMS()) { setOutreachOpen(false); setMobileSidebarOpen(false); setAutomationsOpen(false); setInsiJetsPanel("pricing"); } }}
        onOpenDirectory={() => { if (insijetsWorkspaceAccess && canLeaveInsiJetsCMS()) { setOutreachOpen(false); setMobileSidebarOpen(false); setAutomationsOpen(false); setInsiJetsPanel("directory"); } }}
        onOpenOutreach={() => { if (!insijetsOutreachAccess || !canLeaveInsiJetsCMS()) return; setInsiJetsPanel(null); setProductView(null); setAutomationsOpen(false); setMobileSidebarOpen(false); setPreviewDocument(null); setActiveSideWindow(null); setOutreachCompactView('outreach'); setOutreachOpen(true); }}
        productView={productView}
        onOpenProduction={() => { setMobileSidebarOpen(false); setAutomationsOpen(false); setProductView("production"); }}
        onOpenReception={() => { setMobileSidebarOpen(false); setAutomationsOpen(false); setProductView("reception"); }}
        onOpenApps={() => { setMobileSidebarOpen(false); setAutomationsOpen(false); setProductView("apps"); }}
        onOpenAutomations={() => { if (!canLeaveInsiJetsCMS()) return; setOutreachOpen(false); setInsiJetsPanel(null); setProductView(null); setMobileSidebarOpen(false); setNewAutomationRequested(false); setAutomationsOpen(true); }}
        onSelectProject={(projectId) => { if (!canLeaveInsiJetsCMS()) return; setInsiJetsPanel(null); setProductView(null); setAutomationsOpen(false); selectProject(projectId); }}
        onSelectThread={(threadId) => { if (!canLeaveInsiJetsCMS()) return; setInsiJetsPanel(null); setProductView(null); setAutomationsOpen(false); selectThread(threadId); }}
        onNewThread={(projectId) => { if (!canLeaveInsiJetsCMS()) return; setInsiJetsPanel(null); setProductView(null); setAutomationsOpen(false); startNewThread(projectId); }}
        onNewProject={(returnFocus) => {
          beginSidebarOverlay("text", returnFocus);
          setTextDialog({ kind: "create-project" });
        }}
        onProjectAction={handleProjectAction}
        onThreadAction={handleThreadAction}
        onOpenCustomization={(returnFocus, initialTab = "appearance") => {
          beginSidebarOverlay("customization", returnFocus);
          setCustomizationInitialTab(initialTab);
          setCustomizationOpen(true);
        }}
      />

      <WorkbenchContent
        installationId={branding.installationId}
        actorId={session.user.id}
        productView={productView}
        onProductChat={(message) => { setProductView(null); startNewThread(); setPrompt(message); }}
        onToggleSidebar={toggleSidebar}
        insijets={{
          allowed: insijetsWorkspaceAccess,
          panel: insijetsPanel,
          onDirtyChange: setInsiJetsCMSDirty,
          onRequestChat: (message) => {
            const draft = promptRef.current.trimEnd();
            updateComposerPrompt(draft.trim() ? `${draft}\n\n${message}` : message);
            setInsiJetsPanel(null);
            setOutreachCompactView("chat");
          },
        }}
        automations={{
          open: automationsOpen,
          projects,
          initialCreate: newAutomationRequested,
          onBlockingSurfaceChange: setAutomationsBlockingSurfaceOpen,
          onOpenThread: (threadId) => { setAutomationsOpen(false); selectThread(threadId); },
        }}
        outreach={{
          allowed: insijetsOutreachAccess,
          open: outreachOpen,
          compactView: outreachCompactView,
          onCompactViewChange: setOutreachCompactView,
          panel: {
            onClose: () => setOutreachOpen(false),
            onContextChange: setOutreachPaneContext,
            onAsk: (message) => {
              const draft = promptRef.current.trimEnd(), request = message.trim();
              const alreadyPrepared = draft.trim() === request || draft.endsWith(`\n\n${request}`);
              updateComposerPrompt(draft.trim() ? alreadyPrepared ? draft : `${draft}\n\n${request}` : request);
              setOutreachCompactView("chat");
            },
          },
        }}
      >
        <ChatWorkspace
        onCreateAutomation={() => { setProductView(null); setNewAutomationRequested(true); setAutomationsOpen(true); }}
        liveAnswers={liveAnswers}
        manifest={manifest}
        preferences={preferences}
        project={activeProject}
        thread={activeThread}
        projects={projects}
        userName={session.user.name}
        companyName={branding.companyName}
        installationId={branding.installationId}
        assistantName={branding.productName}
        hydrated={hydrated}
        prompt={prompt}
        composerExperience={composerExperience}
        imageGeneration={imageGeneration}
        connectorMentions={connectorMentions}
        connectorCatalogStatus={initialWorkbench.persistence === "browser-preview" ? "ready" : connectorCatalogStatus}
        onRetryConnectorCatalog={() => setConnectorCatalogAttempt(attempt => attempt + 1)}
        selectedConnectorMentionIds={selectedConnectorMentionIds}
        serverReferences={selectedServerReferences}
        onServerReferencesChange={(items) => { if (pendingSelectionRef.current === null) updateServerReferences(items); }}
        attachments={attachments}
        documents={documents}
        publications={publications}
        documentUploading={documentUploading}
        sending={sending}
        selectionLoading={selectionLoading}
        stopping={activeThread ? stoppingThreadIds.has(activeThread.id) : false}
        queuedMessages={activeQueuedMessages}
        runtimeStatus={effectiveRuntimeStatus}
        networkOnline={networkOnline}
        streamRecovery={streamRecoveryNotice?.threadId === activeThreadId
          ? { attempt: streamRecoveryNotice.attempt, paused: streamRecoveryNotice.attempt === null, admissionUnconfirmed: streamRecoveryNotice.admissionUnconfirmed,
            onRetry: () => { streamRetryRef.current.get(activeThreadId!)?.(); setStoredResponseRetry(current => current + 1); } }
          : storedResponsePhase ? { attempt: storedResponsePhase === "checking" ? 0 : null, paused: storedResponsePhase === "paused",
            onRetry: () => setStoredResponseRetry(current => current + 1) } : null}
        onRetryRuntime={() => setRuntimeRetry((current) => current + 1)}
        onPromptChange={updateComposerPrompt}
        onComposerExperienceChange={setComposerExperience}
        onImageGenerationChange={setImageGeneration}
        onDestinationChange={startNewThread}
        onConnectorMentionIdsChange={(ids) => { if (pendingSelectionRef.current === null) setSelectedConnectorMentionIds(ids); }}
        onAttachmentsChange={(items) => { if (pendingSelectionRef.current === null) setAttachments(items); }}
        onDocumentsChange={changeDocuments}
        onAddDocuments={addDocuments}
        onRequestPublication={requestDocumentPublication}
        onFreezePublication={freezePublication}
        onDecidePublication={decidePublication}
        onComposerNotice={(message, kind = "warning") => setNotice(workbenchNotice(message, kind))}
        onSend={submitOutreachMessage}
        onStop={() => void stopActiveTurn()}
        onCancelQueuedMessage={(id) => setQueuedTurns((current) => current.filter((item) => item.id !== id))}
        sidebarOpen={desktopSidebarOpen || mobileSidebarOpen}
        onToggleSidebar={toggleSidebar}
        onResolveApproval={resolveApproval}
        onEditMessage={(message, content) => void branchConversation(message, { kind: "edit", messageId: message.id, editedContent: content }, true)}
        managedAppActionEnabled={managedAppAvailable}
        managedAppApprovalKeys={Object.values(managedAppActions)
          .filter((descriptor) => descriptor.locator.threadId === activeThreadId)
          .map((descriptor) => managedAppActionKey(descriptor.locator))}
        onManagedAppPrepared={prepareManagedAppAction}
        onPreviewDocument={(artifact) => {
          setOutreachOpen(false);
          setActiveSideWindow(null);
          setPreviewDocument(artifact);
        }}
        onOpenReview={(messageId) => {
          setOutreachOpen(false);
          setPreviewDocument(null);
          setSelectedMessageId(messageId);
          setActiveSideWindow("inspector");
        }}
        readOnly={!workbenchThreadAccess(activeThread, activeProject).canEdit}
      />
      </WorkbenchContent>

      {previewDocument ? (
        <DocumentPreviewPanel key={previewDocument.id} artifact={previewDocument} onClose={() => setPreviewDocument(null)} />
      ) : null}

      {inspectorEnabled && preferences.showInspector && activeSideWindow === "inspector" ? (
        <DetailsPanel
          readOnly={!workbenchThreadAccess(activeThread, activeProject).canEdit}
          message={selectedMessage}
          performance={selectedMessage ? clientTurnReadbacks[selectedMessage.id] ?? null : null}
          open
          onClose={() => setActiveSideWindow(null)}
          onResolveApproval={(approvalId, decision) => {
            if (selectedMessage) void resolveApproval(selectedMessage.id, approvalId, decision);
          }}
        />
      ) : null}

      <TaskCenterPanel
        open={taskCenterOpen}
        tasks={taskCenterItems}
        preferences={taskCenterPayload.preferences}
        notificationPermission={typeof Notification === "undefined" ? "unsupported" : Notification.permission}
        busy={taskCenterBusy}
        onClose={() => setTaskCenterOpen(false)}
        onOpenConversation={(task) => {
          setTaskCenterOpen(false);
          void selectThread(task.threadId);
          if (task.unread) void mutateTaskCenter({ action: "mark_read", taskIds: [task.id] });
        }}
        onMarkRead={(taskId) => void mutateTaskCenter({ action: "mark_read", taskIds: [taskId] })}
        onMarkAllRead={() => void mutateTaskCenter({ action: "mark_read", taskIds: taskCenterItems.filter((task) => task.unread).map((task) => task.id) })}
        onPreferencesChange={(nextPreferences) => void mutateTaskCenter({ action: "preferences", preferences: nextPreferences })}
        onRequestDesktopNotifications={() => {
          if (typeof Notification === "undefined") return;
          void Notification.requestPermission().then((permission) => {
            if (permission === "granted") void mutateTaskCenter({ action: "preferences", preferences: { ...taskCenterPayload.preferences, desktop: true } });
          });
        }}
      />

      <CustomizationPanel
        key={customizationInitialTab}
        productName={branding.productName}
        open={customizationOpen}
        initialTab={customizationInitialTab}
        runtimeStatus={effectiveRuntimeStatus}
        projects={projects}
        threads={threads}
        archiveBusy={actionBusy}
        onRestoreProject={(project) => handleProjectAction(project, "restore")}
        onRestoreThread={(thread) => handleThreadAction(thread, "restore")}
        onSettingsSnapshot={setSettingsSnapshot}
        activeProjectId={activeProject?.id ?? null}
        returnFocusRef={sidebarReturnFocusRef}
        onClose={closeCustomization}
      />

      <ProjectPanel
        key={activeProject?.id ?? "none"}
        project={activeProject && activeProject.slug !== STANDALONE_PROJECT_SLUG ? activeProject : null}
        open={projectOpen}
        returnFocusRef={sidebarReturnFocusRef}
        onClose={closeProjectPanel}
        onSave={async (patch) => Boolean(activeProject && await persistProjectPatch(activeProject, patch))}
      />

      <CommandPalette
        open={commandPaletteOpen}
        projects={projects}
        threads={threads}
        activeProjectId={activeProjectId}
        returnFocusRef={sidebarReturnFocusRef}
        onClose={closeCommandPalette}
        onSelectProject={(projectId) => {
          mobileSidebarHandoffRef.current = null;
          sidebarReturnFocusRef.current = null;
          selectProject(projectId);
        }}
        onSelectThread={(threadId) => {
          mobileSidebarHandoffRef.current = null;
          sidebarReturnFocusRef.current = null;
          selectThread(threadId);
        }}
      />

      {textDialogCopy ? (
        <TextDialog
          open
          title={textDialogCopy.title}
          label={textDialogCopy.label}
          initialValue={textDialogCopy.value}
          maxLength={textDialogCopy.maxLength}
          submitLabel={textDialogCopy.submit}
          busy={actionBusy}
          returnFocusRef={sidebarReturnFocusRef}
          onClose={() => !actionBusy && closeTextDialog()}
          onSubmit={(value) => void submitTextDialog(value)}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(confirmDialog)}
        title={confirmDialog?.kind === "undo-result" ? t("¿Quieres deshacer estos cambios?") : confirmDialog?.kind === "archive-project" ? t("¿Archivar proyecto?") : confirmDialog?.kind === "remove-thread" ? t("¿Eliminar la conversación de la lista?") : t("¿Archivar conversación?")}
        description={confirmDialog?.kind === "archive-project"
          ? t("El proyecto y sus conversaciones dejarán de aparecer en la vista activa. Podrás restaurarlos desde Configuración > Archivados.")
          : confirmDialog?.kind === "undo-result"
            ? t("Se revertirán solo los cambios de este resultado, se comprobará el estado final y se conservará el original en el historial.")
            : confirmDialog?.kind === "remove-thread"
              ? t("Se retirará de la lista activa y se conservará en Conversaciones archivadas, donde podrás restaurarla. No se borrará su contenido.")
              : t("La conversación dejará de aparecer en la lista activa. Podrás restaurarla desde Configuración > Archivados.")}
        confirmLabel={confirmDialog?.kind === "undo-result" ? t("Sí, deshacer") : confirmDialog?.kind === "remove-thread" ? t("Eliminar de la lista") : t("Archivar")}
        busy={actionBusy}
        returnFocusRef={sidebarReturnFocusRef}
        onClose={() => !actionBusy && closeConfirmDialog()}
        onConfirm={() => void confirmAction()}
      />

      {notice ? (
        <div role={notice.kind === "error" ? "alert" : "status"} aria-live={notice.kind === "error" ? "assertive" : "polite"} aria-atomic="true" className={`fixed right-4 top-4 z-[90] flex max-w-[min(26rem,calc(100%-2rem))] items-center gap-2.5 rounded-xl border px-3 py-2.5 text-[13px] font-medium leading-5 shadow-[var(--shadow-md)] ${noticeTone}`}>
          <span className="size-2 shrink-0 rounded-full bg-current" aria-hidden="true" />
          <span className="min-w-0 flex-1"><span className="sr-only">{noticeLabel}: </span>{notice.message}</span>
          {!modalSurfaceOpen ? <button type="button" className="touch-target grid size-8 shrink-0 place-items-center rounded-lg text-current opacity-70 transition hover:bg-black/5 hover:opacity-100 active:scale-95 dark:hover:bg-white/10" aria-label={`Cerrar ${noticeLabel.toLocaleLowerCase("es")}`} onClick={() => setNotice(null)}><span aria-hidden="true">{t("×")}</span></button> : null}
        </div>
      ) : null}
    </div>
  );
}
