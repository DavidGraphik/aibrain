"use client";
import { MAX_FILES_PER_MESSAGE } from "@/lib/chat-attachment-limits";
import { useUiLocale, useUiText } from "@/i18n/provider";

import { ConnectorPopover } from "@/components/connector-popover";
import { ConnectorLogo } from "@/components/connector-logo";
import { connectorPresentation, connectorStatusLabel } from "@/connectors/presentation";
import { mentionQueryAt, mentionTextParts } from "@/ui/connector-mention-text";
import { useMenuViewport } from "@/ui/use-menu-viewport";
import { ServerPicker } from "@/components/server-picker";
import type { ServerReference } from "@/documents/server-reference-contract";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  At,
  CaretDown,
  Check,
  Copy,
  FolderOpen,
  File as FileIcon,
  Image as ImageIcon,
  ImagesSquare,
  Paperclip,
  Plus,
  PencilSimple,
  SidebarSimple,
  SpinnerGap,
  Stop,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { ChatAttachmentImage } from "@/components/chat-attachment-image";
import { ChatAudioAttachment } from "@/components/chat-audio-attachment";
import NextImage from "next/image";
import { useComposerFileDrop } from "@/ui/use-composer-file-drop";
import { useStickToBottom } from "use-stick-to-bottom";
import { DaySeparator } from "@/components/assistant-ui/elements/day-separator";
import { MarkdownMessage } from "@/components/markdown-message";
import { type LiveAnswerStore, useLiveAnswer } from '@/ui/live-answer-store';
import { StreamingResponse } from "@/components/agents/streaming-response";
import { MessageQueue, type QueuedMessage } from "@/components/assistant-ui/elements/message-queue";
import { ThinkingOrb } from "thinking-orbs";
import type { ApprovalDecision, ApprovalItem, ChatAttachment, ChatInputAttachment, ChatMessage, DocumentArtifact, TurnSource } from "@/lib/chat-contract";
import type { BrainManifest, BrainPreferences } from "@/config/brain";
import type { RuntimeStatus } from "@/lib/runtime-status";
import type { ComposerExperience } from "@/lib/composer-experience";
import { LandingTasks } from "@/components/landing-tasks";
import { g03ProductInstallation } from "@/g03-products/contracts";
import { landingSuggestions } from "@/lib/landing-suggestions";
import { isStandaloneProject, type WorkbenchProject, type WorkbenchThread } from "@/workbench/types";
import { currentTurnStatusLabel, hasRelevantWorkProcess, TurnActivity } from "@/components/turn-activity";
import { publicActivityText, publicAssistantText } from "@/ui/public-activity";
import { TurnArtifactCard } from "@/components/turn-artifact-card";
import { DocumentPublicationCard } from "@/components/document-publication-card";
import { TurnSourceChips } from "@/components/turn-sources";
import { VoiceDictationControl, type VoiceNoticeKind } from "@/components/voice-controls";
import { StreamRecoveryBanner } from "@/components/stream-recovery-banner";
import type { StagedComposerDocument } from "@/ui/document-ui-adapter";
import type { DocumentPublicationDraft } from "@/ui/publication-ui-adapter";
import type { ManagedAppActionDescriptor } from "@/ui/codex-managed-app-ui";
import { managedAppActionKey } from "@/ui/codex-managed-app-ui";
import type { ConnectorMention } from "@/connectors/mentions-contract";
import { useMenuKeyboardNavigation } from "@/ui/use-menu-keyboard-navigation";
import { restoreRequestDocument } from "@/ui/restore-request-documents";
import { readerScrolledAway } from "@/ui/reader-scroll-intent";

type ChatWorkspaceProps = {
  liveAnswers?: LiveAnswerStore;
  manifest: BrainManifest;
  preferences: BrainPreferences;
  project: WorkbenchProject | null;
  thread: WorkbenchThread | null;
  projects: WorkbenchProject[];
  userName: string;
  companyName: string;
  installationId?: string;
  assistantName: string;
  hydrated: boolean;
  prompt: string;
  composerExperience: ComposerExperience;
  imageGeneration: boolean;
  connectorMentions: ConnectorMention[];
  connectorCatalogStatus?: "loading" | "ready" | "error";
  onRetryConnectorCatalog?: () => void;
  selectedConnectorMentionIds: string[];
  serverReferences?: ServerReference[];
  onServerReferencesChange?: (items: ServerReference[]) => void;
  attachments: ChatInputAttachment[];
  documents: StagedComposerDocument[];
  publications: DocumentPublicationDraft[];
  documentUploading: boolean;
  sending: boolean;
  selectionLoading?: boolean;
  stopping: boolean;
  queuedMessages: readonly QueuedMessage[];
  runtimeStatus: RuntimeStatus;
  networkOnline: boolean;
  streamRecovery: { attempt: number | null; paused?: boolean; admissionUnconfirmed?: boolean; onRetry?: () => void } | null;
  onRetryRuntime: () => void;
  onPromptChange: (value: string) => void;
  onComposerExperienceChange: (value: ComposerExperience) => void;
  onImageGenerationChange: (value: boolean) => void;
  onDestinationChange: (projectId: string) => void;
  onConnectorMentionIdsChange: (value: string[]) => void;
  onAttachmentsChange: (value: ChatInputAttachment[]) => void;
  onDocumentsChange: (value: StagedComposerDocument[]) => void;
  onAddDocuments: (files: File[]) => Promise<void>;
  onRequestPublication?: (attachment: ChatAttachment, turnId: string) => void;
  onFreezePublication: (draftId: string, targetRelativePath: string) => Promise<void>;
  onDecidePublication: (draftId: string, action: "confirm" | "decline") => Promise<void>;
  onComposerNotice: (message: string, kind?: VoiceNoticeKind) => void;
  onSend: (message?: string, displayMessage?: string) => void;
  onStop: () => void;
  onCancelQueuedMessage: (id: string) => void;
  sidebarOpen: boolean;
  onToggleSidebar: (opener?: HTMLElement | null) => void;
  onResolveApproval: (
    messageId: string,
    approval: ApprovalItem,
    decision: ApprovalDecision,
  ) => Promise<void>;
  onEditMessage: (message: ChatMessage, content: string) => void;
  managedAppActionEnabled: boolean;
  managedAppApprovalKeys: readonly string[];
  onManagedAppPrepared: (descriptor: ManagedAppActionDescriptor) => void;
  onPreviewDocument: (artifact: DocumentArtifact) => void;
  onOpenReview: (messageId: string) => void;
  onCreateAutomation?: () => void;
  readOnly?: boolean;
};

type ComposerPickerOption = {
  value: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
};

function connectorOptionId(scope: "mention" | "catalog", id: string) {
  return `connector-${scope}-${id}`;
}

function nextEnabledConnectorIndex(
  options: readonly ConnectorMention[],
  current: number,
  direction: 1 | -1,
) {
  if (!options.length) return 0;
  for (let step = 1; step <= options.length; step += 1) {
    const index = (current + direction * step + options.length) % options.length;
    if (options[index]?.canRead || options[index]?.connectUrl) return index;
  }
  return Math.max(0, Math.min(current, options.length - 1));
}

function ComposerPicker({
  ariaLabel,
  value,
  valueLabel,
  options,
  open,
  placement,
  align = "start",
  anchor = "self",
  className,
  disabled = false,
  onOpenChange,
  onSelect,
}: {
  ariaLabel: string;
  value: string;
  valueLabel: string;
  options: ComposerPickerOption[];
  open: boolean;
  placement: "above" | "below";
  align?: "start" | "end";
  anchor?: "self" | "controls";
  className?: string;
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (value: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const closeAndRestore = useCallback(() => {
    onOpenChange(false);
    triggerRef.current?.focus({ preventScroll: true });
  }, [onOpenChange]);
  const onMenuKeyDown = useMenuKeyboardNavigation(closeAndRestore);
  useMenuViewport(menuRef, open, placement);

  useLayoutEffect(() => {
    if (!open) return;
    // Finish keyboard ownership when the menu mounts. A deferred frame can
    // miss the next key or overwrite a user's End/Home navigation.
    const menu = menuRef.current;
    const target = menu?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')
      ?? menu?.querySelector<HTMLElement>('[role="menuitemradio"]');
    target?.focus({ preventScroll: true });
  }, [open]);

  return (
    <div className={`composer-picker shrink-0 ${anchor === "controls" ? "static" : "relative"} ${className ?? ""}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={`composer-picker-button !min-h-11 ${open ? "composer-picker-button-active" : ""}`}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          onOpenChange(true);
        }}
      >
        <span className="max-w-32 truncate">{valueLabel}</span>
        <CaretDown size={11} className={`shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={ariaLabel}
          className={`menu-enter absolute z-40 w-56 rounded-[20px] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-1.5 shadow-[var(--shadow-popover)] ${placement === "above" ? "bottom-full mb-2 origin-bottom" : "top-full mt-2 origin-top"} ${align === "end" ? "right-0" : "left-0"}`}
          onKeyDown={onMenuKeyDown}
        >
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                tabIndex={-1}
                aria-checked={selected}
                className={`flex min-h-10 w-full items-center gap-2.5 rounded-[14px] px-3 py-2 text-left transition-colors ${selected ? "bg-[var(--surface-selected)] text-[var(--text)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"}`}
                onClick={() => {
                  onSelect(option.value);
                  onOpenChange(false);
                  triggerRef.current?.focus({ preventScroll: true });
                }}
              >
                {option.icon ? <span className="grid size-5 shrink-0 place-items-center text-[var(--text-subtle)]">{option.icon}</span> : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium">{option.label}</span>
                  {option.detail ? <span className="mt-0.5 block text-[12px] leading-4 text-[var(--text-subtle)]">{option.detail}</span> : null}
                </span>
                <Check size={13} weight="bold" className={selected ? "opacity-100" : "opacity-0"} />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ResultActions({ content, sources }: { content: string; sources: readonly TurnSource[] }) {
  const t = useUiText();
  const [copied, setCopied] = useState(false);
  const copyResult = async () => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = content;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copiedWithFallback = document.execCommand("copy");
      textarea.remove();
      if (!copiedWithFallback) return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className="assistant-response-actions mt-3 flex items-start gap-2 text-[var(--text-muted)]">
      <button type="button" title={t("Copiar")} aria-label={t("Copiar")} className="result-action" onClick={() => void copyResult()}><Copy size={14} />{copied ? <span className="ml-1 text-[12px]">{t("Copiado")}</span> : null}</button>
      <TurnSourceChips sources={sources} />
    </div>
  );
}

function AssistantMessage({
  liveAnswers,
  threadId,
  message,
  assistantName,
  projectId,
  showActivity,
  onResolveApproval,
  publications,
  onFreezePublication,
  onDecidePublication,
  managedAppAction,
  managedAppApprovalKeys,
  onPreviewDocument,
  onOpenReview,
  onRestoreRequest,
  restoreDisabled,
  readOnly = false,
  recoveryPaused = false,
}: {
  liveAnswers?: LiveAnswerStore;
  threadId: string;
  message: ChatMessage;
  assistantName: string;
  projectId: string | undefined;
  showActivity: boolean;
  onResolveApproval: (approval: ApprovalItem, decision: ApprovalDecision) => void;
  publications: DocumentPublicationDraft[];
  onFreezePublication: (draftId: string, targetRelativePath: string) => Promise<void>;
  onDecidePublication: (draftId: string, action: "confirm" | "decline") => Promise<void>;
  managedAppAction: {
    enabled: boolean;
    threadId: string;
    onPrepared: (descriptor: ManagedAppActionDescriptor) => void;
  } | null;
  managedAppApprovalKeys: readonly string[];
  onPreviewDocument: (artifact: DocumentArtifact) => void;
  onOpenReview: (messageId: string) => void;
  onCreateAutomation?: () => void;
  onRestoreRequest?: () => void;
  restoreDisabled?: boolean;
  readOnly?: boolean;
  recoveryPaused?: boolean;
}) {
  const t = useUiText();
  const liveContent = useLiveAnswer(liveAnswers, `${threadId}:${message.id}`);
  const content = message.status === 'streaming' ? liveContent ?? message.content : message.content;
  const streaming = message.status === "streaming" && !recoveryPaused;
  const hasExecution = hasRelevantWorkProcess(message);
  const liveStatus = currentTurnStatusLabel(message, t) ?? t("Enviando solicitud");
  const publicContent = publicAssistantText(content, assistantName);
  const failureLabel = publicActivityText(message.activity.find(item => item.id === "host-analysis-outcome" && item.status === "failed")?.label ?? "", 500);

  return (
    <article className="message-enter group">
      {showActivity || ((message.status === "error" || message.status === "stopped") && hasExecution) || managedAppAction || message.approvals.some((approval) => managedAppApprovalKeys.includes(managedAppActionKey({ ...approval, approvalId: approval.id }))) ? (
        <TurnActivity message={message} recoveryPaused={recoveryPaused} projectId={projectId} readOnly={readOnly} onResolveApproval={onResolveApproval} onOpenReview={() => onOpenReview(message.id)} managedAppAction={readOnly ? null : managedAppAction} managedAppApprovalKeys={managedAppApprovalKeys} />
      ) : null}

      {streaming && !content && !hasExecution ? (
        <div className="flex items-center gap-2 py-1 text-[15px] leading-5 text-[var(--text-muted)]" role="status">
          <ThinkingOrb state="working" size={20} aria-hidden="true" />
          <span className="activity-shimmer">{liveStatus}…</span>
        </div>
      ) : publicContent ? (
        <StreamingResponse
          status={recoveryPaused && message.status === "streaming" ? "paused" : message.status === "streaming" ? "streaming" : message.status === "error" ? "error" : "complete"}
          announce={streaming}
          showActions={false}
          className="mt-4 max-w-[76ch]"
          contentClassName="text-[length:var(--font-chat-message)] leading-[1.75] text-[var(--text)]"
        >
          <MarkdownMessage streaming={streaming}>{publicContent}</MarkdownMessage>
        </StreamingResponse>
      ) : null}

      {message.status !== "complete" || !publicContent ? <TurnSourceChips sources={message.sources ?? []} /> : null}

      {message.status === "error" ? (
        <div className="mt-3 flex max-w-xl items-start gap-2 rounded-[var(--brain-radius)] border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2.5 text-[12px] text-[var(--danger)]" role="alert">
          <WarningCircle size={15} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p>{failureLabel || t("No se ha podido completar esta respuesta.")}</p>
            {!readOnly && onRestoreRequest ? <>
              <p className="mt-1">{t("Revisa la solicitud y los resultados parciales antes de volver a enviarla.")}</p>
              <button type="button" disabled={restoreDisabled} className="touch-target mt-2 min-h-9 rounded-lg border border-current px-3 py-2 font-medium disabled:opacity-40" onClick={onRestoreRequest}>{t("Editar solicitud")}</button>
            </> : null}
          </div>
        </div>
      ) : null}

      {message.status === "stopped" ? <p className="mt-3 text-[12px] text-[var(--text-muted)]">{t("Respuesta detenida.")}</p> : null}

      {message.artifacts.length ? (
        <div className={`mt-4 grid min-w-0 grid-cols-1 gap-3 ${message.artifacts.length > 1 && message.artifacts.every((artifact) => artifact.type === "image") ? "sm:grid-cols-2" : ""}`}>
          {message.artifacts.map((artifact) => (
            <TurnArtifactCard key={artifact.id} artifact={artifact} onPreviewDocument={onPreviewDocument} />
          ))}
        </div>
      ) : null}

      {publications.map((draft) => (
        <DocumentPublicationCard key={draft.id} draft={draft} readOnly={readOnly} onFreeze={onFreezePublication} onDecide={onDecidePublication} />
      ))}

      {message.status === "complete" && publicContent ? <ResultActions content={publicContent} sources={message.sources ?? []} /> : null}
    </article>
  );
}

function UserMessage({ message, connectorMentions, threadId, onRequestPublication, onEdit, readOnly = false }: { message: ChatMessage; connectorMentions: ConnectorMention[]; threadId: string; onRequestPublication?: (attachment: ChatAttachment) => void; onEdit: (content: string) => void; readOnly?: boolean }) {
  const t = useUiText();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(message.content);
  const messageRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [editWidth, setEditWidth] = useState<number>();
  const resizeEditor = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.style.height = "0px";
    editor.style.height = `${editor.scrollHeight}px`;
  }, []);
  useLayoutEffect(() => { if (editing) resizeEditor(); }, [editing, value, resizeEditor]);
  useEffect(() => {
    if (!editing || !editorRef.current) return;
    const observer = new ResizeObserver(resizeEditor);
    observer.observe(editorRef.current);
    return () => observer.disconnect();
  }, [editing, resizeEditor]);
  return (
    <article className="message-enter group flex justify-end">
      <div ref={messageRef} style={editing ? { width: editWidth } : undefined} className="min-w-0 max-w-[86%] md:max-w-[70%]">
      <div className="user-message-bubble min-w-0 overflow-hidden rounded-[24px] bg-[var(--user-message)] px-5 py-3 text-[length:var(--font-chat-message)] leading-[1.65] text-[var(--user-message-text)] [overflow-wrap:anywhere]">
        {message.serverReferences?.length ? <div className="mb-2 flex flex-wrap gap-2">{message.serverReferences.map(ref => <span className="rounded bg-[var(--surface-raised)]/70 px-2 py-1 text-xs text-[var(--text)]" key={ref.path} title={ref.path}>{t("Server ·")}{" "}{ref.name}</span>)}</div> : null}
        {message.attachments.length ? (
          <div className="mb-2 flex flex-wrap justify-end gap-1.5">
            {message.attachments.map((attachment) => (
              <span key={attachment.id} className="flex max-w-52 items-center gap-1.5 rounded-md bg-[var(--surface-raised)]/70 px-2 py-1 text-[12px] text-[var(--text)]">
                {attachment.mimeType === "audio/ogg" ? <ChatAudioAttachment attachment={attachment} threadId={threadId} /> : <>
                  {attachment.mimeType.startsWith("image/") ? <ChatAttachmentImage attachment={attachment} threadId={threadId} /> : <FileIcon size={11} />}
                  <span className="truncate">{attachment.name}</span>
                </>}
                {!readOnly && onRequestPublication ? <button type="button" aria-label={t("Preparar publicación de {p0}", { p0: attachment.name })} title={t("Publicar como documento oficial")} onClick={() => onRequestPublication(attachment)} className="touch-target shrink-0 rounded p-1 hover:bg-[var(--surface-hover)]"><Plus size={12} /></button> : null}
              </span>
            ))}
          </div>
        ) : null}
        {editing ? (
          <div>
            <label className="sr-only" htmlFor={`edit-${message.id}`}>{t("Editar mensaje")}</label>
            <textarea ref={editorRef} id={`edit-${message.id}`} autoFocus value={value} maxLength={32_000} rows={1} className="user-message-editor w-full min-w-0 bg-transparent outline-none [overflow-wrap:anywhere]" onChange={(event) => setValue(event.target.value)} />
            <div className="mt-2 flex flex-wrap justify-end gap-2 text-[12px]">
              <button type="button" className="rounded-full px-3 py-1.5 hover:bg-black/5" onClick={() => { setValue(message.content); setEditing(false); }}>{t("Cancelar")}</button>
              <button type="button" disabled={!value.trim() || value.trim() === message.content.trim()} className="rounded-full bg-[var(--send-button)] px-3 py-1.5 font-semibold text-[var(--send-button-text)] disabled:opacity-40" onClick={() => { onEdit(value.trim()); setEditing(false); }}>{t("Enviar edición")}</button>
            </div>
          </div>
        ) : <div className="whitespace-pre-wrap">{mentionTextParts(message.content, connectorMentions.filter(m => message.connectorMentions?.includes(m.id))).map((part, index) => part.id ? <span key={index} className="rounded bg-[var(--surface-selected)] text-[var(--text)]"><span className="inline-flex align-middle"><ConnectorLogo id={part.id} size={14} /></span>{part.text.slice(1)}</span> : part.text)}</div>}
      </div>
      {!readOnly && !editing && message.attachments.length === 0 ? <div className="mt-1 flex justify-end opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"><button type="button" className="result-action" aria-label={t("Editar mensaje y crear una rama")} title={t("Editar mensaje")} onClick={() => { setEditWidth(Math.max(320, messageRef.current?.getBoundingClientRect().width ?? 0)); setValue(message.content); setEditing(true); }}><PencilSimple size={14} /></button></div> : null}
      </div>
    </article>
  );
}

export function ChatWorkspace({
  liveAnswers,
  manifest,
  preferences,
  project,
  thread,
  projects,
  userName,
  onCreateAutomation,
  companyName,
  installationId,
  assistantName,
  hydrated,
  prompt,
  composerExperience,
  imageGeneration,
  connectorMentions,
  connectorCatalogStatus = "ready",
  onRetryConnectorCatalog,
  selectedConnectorMentionIds,
  serverReferences = [],
  onServerReferencesChange,
  attachments,
  documents,
  publications,
  documentUploading,
  sending,
  stopping,
  queuedMessages,
  runtimeStatus,
  networkOnline,
  streamRecovery,
  onRetryRuntime,
  onPromptChange,
  onComposerExperienceChange,
  onImageGenerationChange,
  onDestinationChange,
  onConnectorMentionIdsChange,
  onAttachmentsChange,
  onDocumentsChange,
  onAddDocuments,
  onRequestPublication,
  onFreezePublication,
  onDecidePublication,
  onComposerNotice,
  onSend,
  onStop,
  onCancelQueuedMessage,
  sidebarOpen,
  onToggleSidebar,
  onResolveApproval,
  onEditMessage,
  managedAppActionEnabled,
  managedAppApprovalKeys,
  onManagedAppPrepared,
  onPreviewDocument,
  onOpenReview,
  readOnly = false,
  selectionLoading = false,
}: ChatWorkspaceProps) {
  const t = useUiText();
  const locale = useUiLocale();
  const { scrollRef, contentRef, scrollToBottom, stopScroll, isAtBottom, state: scrollState } = useStickToBottom({
    initial: "instant",
    resize: "instant",
  });
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const mentionOverlayRef = useRef<HTMLDivElement>(null);
  const [composerCaret, setComposerCaret] = useState(prompt.length);
  const [composing, setComposing] = useState(false);
  const composerCaretRef = useRef(prompt.length);
  const composerSelectionEndRef = useRef(prompt.length);
  const composerDraftAdoptedRef = useRef(false);
  const composerShellRef = useRef<HTMLDivElement>(null);
  const landingBandRef = useRef<HTMLDivElement>(null);
  const composerMeasurementRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerAddButtonRef = useRef<HTMLButtonElement>(null);
  const composerMenuRef = useRef<HTMLDivElement>(null);
  const connectorCatalogRef = useRef<HTMLDivElement>(null);
  const connectorTriggerRef = useRef<HTMLButtonElement>(null);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [composerPickerOpen, setComposerPickerOpen] = useState<"destination" | "experience" | null>(null);
  const fileReadingRef = useRef(false);
  const [fileReading, setFileReading] = useState(false);
  const attachmentSelectionRef = useRef(0);
  useEffect(() => {
    attachmentSelectionRef.current += 1;
    return () => { attachmentSelectionRef.current += 1; };
  }, [project?.id, thread?.id]);
  const serverSelectionKey = `${project?.id ?? ""}:${thread?.id ?? ""}`;
  const serverReturnFocusRef = useRef<HTMLButtonElement>(null);
  const serverFilesAvailable = installationId !== "trinalum-production" && installationId !== "insijets-demo";
  const [serverOpenKey, setServerOpenKey] = useState<string | null>(null);
  const serverOpen = serverOpenKey === serverSelectionKey;
  const [mentionOpen, setMentionOpen] = useState(false);
  const [connectorCatalogOpen, setConnectorCatalogOpen] = useState(false);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [catalogActiveIndex, setCatalogActiveIndex] = useState(0);
  const [composerMultiline, setComposerMultiline] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [restoringThreadId, setRestoringThreadId] = useState<string | null>(null);
  const restoringRequest = Boolean(thread && restoringThreadId === thread.id);
  const restoreControllerRef = useRef<AbortController | null>(null);
  const currentDraftRef = useRef({ prompt, attachments, documents, serverReferences });
  useLayoutEffect(() => {
    currentDraftRef.current = { prompt, attachments, documents, serverReferences };
  }, [prompt, attachments, documents, serverReferences]);
  useEffect(() => () => {
    restoreControllerRef.current?.abort();
    restoreControllerRef.current = null;
  }, [project?.id, thread?.id]);
  const restoreFailedRequest = async (request: ChatMessage) => {
    if (!thread || readOnly || sending || documentUploading || restoreControllerRef.current) return;
    if (prompt.trim() || attachments.length || documents.length || serverReferences.length) {
      onComposerNotice(t("Conserva o vacía el borrador actual antes de recuperar otra solicitud."));
      return;
    }
    const selection = attachmentSelectionRef.current;
    const controller = new AbortController();
    restoreControllerRef.current = controller;
    setRestoringThreadId(thread.id);
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const restored = await Promise.all(request.attachments.map((attachment) => restoreRequestDocument(thread.id, attachment, controller.signal)));
      if (controller.signal.aborted || selection !== attachmentSelectionRef.current) return;
      const current = currentDraftRef.current;
      if (current.prompt.trim() || current.attachments.length || current.documents.length || current.serverReferences.length) {
        onComposerNotice(t("Tu borrador actual se ha conservado. Vacíalo antes de recuperar otra solicitud."));
        return;
      }
      onPromptChange(request.content);
      onDocumentsChange(restored);
      onServerReferencesChange?.(request.serverReferences ?? []);
      onConnectorMentionIdsChange(request.connectorMentions ?? []);
      onComposerNotice(restored.some((document) => document.status === "error")
        ? t("Solicitud recuperada. Vuelve a adjuntar los archivos no disponibles o quítalos antes de enviar.")
        : t("Solicitud recuperada para revisar. No se ha enviado nada."), "status");
      requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
    } catch {
      if (selection === attachmentSelectionRef.current) onComposerNotice(t("No se ha podido recuperar la solicitud. Vuelve a intentarlo."));
    } finally {
      window.clearTimeout(timeout);
      if (restoreControllerRef.current === controller) {
        restoreControllerRef.current = null;
        setRestoringThreadId(null);
      }
    }
  };
  const standaloneConversation = Boolean(project && isStandaloneProject(project));
  const latestAssistantMessageId = thread?.messages.filter((message) => message.role === "assistant").at(-1)?.id ?? null;
  const closeComposerMenuAndRestore = useCallback(() => {
    setComposerMenuOpen(false);
    requestAnimationFrame(() => composerAddButtonRef.current?.focus());
  }, []);
  const onComposerMenuKeyDown = useMenuKeyboardNavigation(closeComposerMenuAndRestore);

  useLayoutEffect(() => {
    // New/recovered threads start at their latest message. Resize observation
    // follows later deltas only until the reader intentionally scrolls away.
    void scrollToBottom({ animation: "instant" });
  }, [scrollToBottom, thread?.id]);

  useEffect(() => {
    if (!hydrated || thread?.messages.length) return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (document.querySelector('[role="dialog"], [aria-modal="true"]') || (active && active !== document.body && active !== composerRef.current)) return;
      composerRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [hydrated, thread?.id, thread?.messages.length]);

  const resizeComposer = useCallback(() => {
    const textarea = composerRef.current;
    const measurement = composerMeasurementRef.current;
    if (!textarea || !measurement) return;
    const style = getComputedStyle(textarea);
    for (const key of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "padding"] as const) measurement.style[key] = style[key];
    measurement.style.width = `${textarea.clientWidth}px`;
    const minHeight = thread?.messages.length ? 32 : 48;
    const nextHeight = Math.min(Math.max(measurement.scrollHeight, minHeight), 192);
    textarea.style.height = `${nextHeight}px`;
    setComposerMultiline(nextHeight > minHeight + 1);
  }, [thread?.messages.length]);

  useLayoutEffect(() => {
    resizeComposer();
  }, [prompt, resizeComposer]);

  useLayoutEffect(() => {
    const textarea = composerRef.current;
    if (!textarea || !hydrated) return;
    if (!composerDraftAdoptedRef.current) {
      composerDraftAdoptedRef.current = true;
      if (textarea.value && textarea.value !== prompt) {
        onPromptChange(textarea.value);
        return;
      }
    }
    if (textarea.value !== prompt) textarea.value = prompt;
  }, [hydrated, onPromptChange, prompt]);

  useEffect(() => {
    const shell = composerShellRef.current;
    if (!shell || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resizeComposer);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [resizeComposer]);

  const hasMessages = Boolean(thread?.messages.length);
  useMenuViewport(composerMenuRef, composerMenuOpen, hasMessages ? "above" : "below");
  const composerEngaged = Boolean(prompt.trim() || attachments.length || documents.length || selectedConnectorMentionIds.length);
  const canAttachImages = manifest.composer.images && (runtimeStatus.mode === "demo" || runtimeStatus.capabilities.imageInput);
  const canGenerateImages = manifest.composer.imageGeneration && (runtimeStatus.mode === "demo" || runtimeStatus.capabilities.imageGeneration);
  const canAttachDocuments = runtimeStatus.mode === "codex";
  const runtimeReady = networkOnline && (runtimeStatus.mode === "demo" || runtimeStatus.ready);
  const hasSendableContent = Boolean(prompt.trim() || attachments.length || documents.some((document) => document.status === "ready"));
  const documentsBlocked = restoringRequest || documents.some((document) => document.status !== "ready");
  const destinationOptions = useMemo(() => projects
    .filter((candidate) => candidate.status === "active")
    .map((candidate) => ({
      value: candidate.id,
      label: isStandaloneProject(candidate) ? t("Sin proyecto") : candidate.name,
    })), [projects, t]);
  const gmailAuthorized = connectorMentions.some((mention) =>
    mention.canRead && mention.status === "connected" &&
    (mention.id.toLocaleLowerCase("es") === "gmail" || mention.label.toLocaleLowerCase("es") === "gmail"));
  const suggestions = useMemo(
    () => landingSuggestions(project, companyName, { gmailAuthorized, imageGeneration, installationId }, t),
    [companyName, gmailAuthorized, imageGeneration, installationId, project, t],
  );
  const noProject = !project || standaloneConversation;
  const firstName = userName.trim().split(/\s+/)[0] || t("ahí");
  const landingHeadline = imageGeneration ? t("¿Qué imagen quieres crear?")
    : t("¿En qué te puedo ayudar, {p0}?", { p0: firstName });
  const placeholderName = assistantName.trim().replace(/\bbrain\b/giu, "AI") || "AI";
  const mentionMatch = composing ? null : mentionQueryAt(prompt, composerCaret);
  const mentionQuery = mentionMatch?.query ?? null;
  const toolMentions = connectorMentions.filter(mention =>
    !g03ProductInstallation(installationId ?? "") || !mention.id.startsWith("g03-app-"))
    .sort((a, b) => Number(b.canRead) - Number(a.canRead));
  const mentionOptions = mentionQuery === null ? [] : toolMentions
    .filter((mention) => mention.label.toLocaleLowerCase("es").includes(mentionQuery) || mention.id.includes(mentionQuery));
  const selectedMentions = useMemo(() => connectorMentions.filter((mention) => selectedConnectorMentionIds.includes(mention.id)), [connectorMentions, selectedConnectorMentionIds]);
  const mentionParts = useMemo(() => mentionTextParts(prompt, selectedMentions), [prompt, selectedMentions]);
  const hasInlineMentions = mentionParts.some(part => part.id);
  const syncCaret = (textarea: HTMLTextAreaElement) => {
    composerCaretRef.current = textarea.selectionStart;
    composerSelectionEndRef.current = textarea.selectionEnd;
    setComposerCaret(textarea.selectionStart);
  };
  const changeComposerText = (text: string) => {
    if (selectionLoading) return;
    onPromptChange(text);
  };
  const selectSuggestion = (text: string) => {
    const textarea = composerRef.current;
    if (textarea) {
      // Set the editable value before React updates defaultValue; otherwise a
      // pristine textarea can reset its selection on the next focus/select render.
      textarea.value = text;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(text.length, text.length);
      syncCaret(textarea);
    }
    changeComposerText(text);
    setMentionOpen(false);
    setConnectorCatalogOpen(false);
  };
  // The editable text is authoritative, including paste, undo and restored drafts.
  // A partial/deleted token cannot retain an invisible tool selection.
  useEffect(() => {
    if (!hydrated || connectorMentions.length === 0 || composing) return;
    const ids = [...new Set(mentionTextParts(prompt, connectorMentions.filter(mention => mention.canRead))
      .flatMap(part => part.id ? [part.id] : []))];
    if (ids.length !== selectedConnectorMentionIds.length || ids.some((id, index) => id !== selectedConnectorMentionIds[index])) {
      onConnectorMentionIdsChange(ids);
    }
  }, [hydrated, prompt, connectorMentions, composing, selectedConnectorMentionIds, onConnectorMentionIdsChange]);
  // Native textarea owns caret, selection, undo, clipboard and IME. Its decorative
  // overlay has exactly the same metrics; no contenteditable serialization.
  useLayoutEffect(() => {
    const textarea = composerRef.current, overlay = mentionOverlayRef.current;
    if (!textarea || !overlay) return;
    const sync = () => {
      const style = getComputedStyle(textarea);
      for (const key of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "textAlign", "tabSize"] as const) overlay.style[key] = style[key];
      overlay.style.width = `${textarea.clientWidth}px`;
      overlay.style.height = `${textarea.clientHeight}px`;
      overlay.style.left = `${textarea.offsetLeft}px`;
      overlay.style.top = `${textarea.offsetTop}px`;
      overlay.scrollTop = textarea.scrollTop;
    };
    sync();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(textarea);
    window.addEventListener("resize", sync);
    return () => { observer?.disconnect(); window.removeEventListener("resize", sync); };
  }, [prompt, hasInlineMentions, composerFocused, composerMultiline]);
  const runningMessage = thread?.messages.findLast((message) => message.role === "user")?.content ?? t("Respuesta en curso");
  const queueingMessage = sending && hasMessages && Boolean(prompt.trim());
  const visibleMentionActiveIndex = Math.min(mentionActiveIndex, Math.max(mentionOptions.length - 1, 0));
  const activeMentionOption = mentionOptions[visibleMentionActiveIndex] ?? null;
  const catalogOptions = connectorCatalogStatus === "ready" ? toolMentions : [];
  const visibleCatalogActiveIndex = Math.min(catalogActiveIndex, Math.max(catalogOptions.length - 1, 0));
  const activeCatalogOption = catalogOptions[visibleCatalogActiveIndex] ?? null;
  useEffect(() => {
    const scope = mentionOpen ? "mention" : connectorCatalogOpen ? "catalog" : null;
    const option = mentionOpen ? activeMentionOption : activeCatalogOption;
    if (scope && option) document.getElementById(connectorOptionId(scope, option.id))?.scrollIntoView?.({ block: "nearest" });
  }, [mentionOpen, connectorCatalogOpen, activeMentionOption, activeCatalogOption]);

  useEffect(() => {
    if (!composerMenuOpen) return;
    const frame = requestAnimationFrame(() => {
      composerMenuRef.current?.querySelector<HTMLElement>(
        '[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)',
      )?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [composerMenuOpen]);

  useEffect(() => {
    if (!connectorCatalogOpen) return;
    const frame = requestAnimationFrame(() => connectorCatalogRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [connectorCatalogOpen]);

  const openAuthorizedConnectors = (trigger: HTMLButtonElement | null) => {
    connectorTriggerRef.current = trigger;
    if (connectorCatalogStatus === "error") onRetryConnectorCatalog?.();
    setComposerMenuOpen(false);
    setMentionOpen(false);
    const firstEnabled = catalogOptions.findIndex((mention) => mention.canRead);
    setCatalogActiveIndex(firstEnabled >= 0 ? firstEnabled : 0);
    setConnectorCatalogOpen(true);
  };

  const connectMention = (mention: ConnectorMention) => {
    if (mention.connectUrl?.startsWith("/api/connectors/") && !mention.connectUrl.startsWith("//")) window.location.assign(mention.connectUrl);
  };
  const insertMention = (mention: ConnectorMention, start: number, end: number) => {
    if (!mention.canRead) { connectMention(mention); return; }
    const prefix = prompt.slice(0, start);
    const token = `${prefix && !/\s$/u.test(prefix) ? " " : ""}@${mention.label} `;
    const next = `${prefix}${token}${prompt.slice(end)}`;
    const textarea = composerRef.current;
    if (textarea) {
      textarea.value = next;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(start + token.length, start + token.length);
      syncCaret(textarea);
    }
    changeComposerText(next);
    setMentionOpen(false);
    setConnectorCatalogOpen(false);
  };
  const selectConnectorMention = (mention: ConnectorMention) => {
    if (mentionMatch) insertMention(mention, mentionMatch.start, mentionMatch.end);
  };
  const selectCatalogConnector = (mention: ConnectorMention) => insertMention(mention, composerCaretRef.current, composerSelectionEndRef.current);

  useEffect(() => {
    if (!composerMenuOpen && !composerPickerOpen && !mentionOpen && !connectorCatalogOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (composerShellRef.current?.contains(event.target as Node) || landingBandRef.current?.contains(event.target as Node) || (event.target instanceof Element && event.target.closest("[data-connector-popover]"))) return;
      setComposerMenuOpen(false);
      setComposerPickerOpen(null);
      setMentionOpen(false);
      setConnectorCatalogOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      const returnToAddButton = composerMenuOpen || connectorCatalogOpen;
      setComposerMenuOpen(false);
      setComposerPickerOpen(null);
      setMentionOpen(false);
      setConnectorCatalogOpen(false);
      requestAnimationFrame(() => {
        if (connectorCatalogOpen) connectorTriggerRef.current?.focus();
        else if (returnToAddButton) composerAddButtonRef.current?.focus();
        else composerRef.current?.focus({ preventScroll: true });
      });
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [composerMenuOpen, composerPickerOpen, connectorCatalogOpen, mentionOpen]);

  const addImages = async (files: FileList | File[] | null) => {
    if (!files || !canAttachImages) return;
    const selection = attachmentSelectionRef.current;
    const available = Math.max(0, MAX_FILES_PER_MESSAGE - attachments.length - documents.filter((document) => document.status !== "error").length);
    const selected = Array.from(files).slice(0, available);
    if (files.length > available) onComposerNotice(t("Puedes adjuntar un máximo de {p0} archivos por mensaje.", { p0: MAX_FILES_PER_MESSAGE }));
    const next: ChatInputAttachment[] = [];
    for (const file of selected) {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
        onComposerNotice(t("{p0} no es una imagen compatible.", { p0: file.name }));
        continue;
      }
      if (file.size > 2_000_000) {
        onComposerNotice(t("{p0} supera el límite de 2 MB.", { p0: file.name }));
        continue;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("invalid"));
        reader.onerror = () => reject(reader.error ?? new Error("read"));
        reader.readAsDataURL(file);
      }).catch(() => "");
      if (!dataUrl) {
        onComposerNotice(t("No se ha podido leer {p0}.", { p0: file.name }));
        continue;
      }
      next.push({ id: crypto.randomUUID(), name: file.name, mimeType: file.type, size: file.size, dataUrl });
    }
    if (selection !== attachmentSelectionRef.current) return;
    if (next.length) onAttachmentsChange([...attachments, ...next]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const addFiles = async (files: FileList | File[] | null) => {
    if (!files || selectionLoading || sending || documentUploading || readOnly || fileReadingRef.current) return;
    fileReadingRef.current = true;
    setFileReading(true);
    try {
    const images: File[] = [];
    const documentFiles: File[] = [];
    for (const file of Array.from(files)) {
      if (!canAttachDocuments && canAttachImages && /^image\/(png|jpeg|webp|gif)$/.test(file.type) && file.size <= 2_000_000) {
        images.push(file);
      } else if (canAttachDocuments) {
        documentFiles.push(file);
      } else {
        onComposerNotice(t("{p0} no es compatible con el servicio actual.", { p0: file.name }));
      }
    }
    if (images.length) await addImages(images);
    if (documentFiles.length) await onAddDocuments(documentFiles);
    } finally {
      fileReadingRef.current = false;
      setFileReading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const { dragActive, dropProps } = useComposerFileDrop({
    enabled: (canAttachImages || canAttachDocuments) && !selectionLoading && !readOnly && !sending && !documentUploading && !fileReading,
    selection: `${project?.id}:${thread?.id}`,
    onFiles: (files) => { void addFiles(files); },
    onNotice: onComposerNotice,
  });

  const jumpToBottom = () => {
    void scrollToBottom({ animation: "instant" });
  };

  return (
    <main {...dropProps} aria-busy={!hydrated || selectionLoading} data-section="chat" data-read-only={readOnly ? "true" : "false"} className="workbench-main relative flex min-w-0 flex-1 flex-col bg-[var(--surface)]">
      <header data-testid="mobile-app-header" className="mobile-app-header workbench-navigation shrink-0 items-center px-2 md:px-3">
        <div className="workbench-navigation-context flex min-w-0 items-center gap-2">
          <button aria-label={t("Mostrar u ocultar la barra lateral")} aria-expanded={sidebarOpen} className="touch-target rounded-lg p-2 text-[var(--text-subtle)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] md:hidden" onClick={(event) => onToggleSidebar(event.currentTarget)}>
            <SidebarSimple size={17} />
          </button>
          <div data-testid="project-breadcrumb" className="min-w-0 px-1 py-1 text-left">
            {!standaloneConversation ? <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-5 text-[var(--text-secondary)]"><FolderOpen size={15} className="shrink-0" /><span className="max-w-[calc(100vw-6rem)] truncate sm:max-w-44">{project?.name}</span></span> : null}
            {thread ? <h1 className="max-w-[calc(100vw-5.5rem)] truncate text-[13px] font-semibold leading-4 text-[var(--text)] sm:max-w-72">{thread.title}</h1> : null}
          </div>
        </div>
        <div aria-hidden="true" className="workbench-navigation-balance" />
      </header>


      <div
        ref={scrollRef}
        className="mobile-chat-scroll scrollbar-thin min-h-0 flex-1 overflow-y-auto"
        onScrollCapture={(event) => {
          if (event.target !== event.currentTarget) return;
          const element = event.currentTarget;
          // Stop upward reader movement before a queued resize-follow frame
          // can win, but never mistake the hook's own scroll or downward
          // layout adjustment for an intentional escape from following.
          if (readerScrolledAway(element, scrollState)) stopScroll();
        }}
      >
        {!hydrated ? (
          <div className="mx-auto max-w-3xl px-6 py-14">
            <div className="mb-8 h-7 w-48 rounded-md bg-[var(--surface-muted)] motion-safe:animate-pulse" />
            <div className="space-y-4"><div className="h-20 rounded-xl bg-[var(--surface-muted)] motion-safe:animate-pulse" /><div className="h-14 rounded-xl bg-[var(--surface-hover)] motion-safe:animate-pulse" /></div>
          </div>
        ) : hasMessages ? (
          <div ref={contentRef} className="mobile-chat-content mx-auto w-full max-w-[var(--conversation-width)] px-5 py-5 md:px-6">
            <div className={preferences.density === "compact" ? "space-y-6" : "space-y-8"}>
              {thread?.messages.map((message, index) => (
                <div key={message.id} id={`message-${message.id}`} className="scroll-mt-8">
                  <DaySeparator date={message.createdAt} previousDate={thread.messages[index - 1]?.createdAt} />
                  {message.role === "user" ? <UserMessage message={message} connectorMentions={connectorMentions} threadId={thread.id} onRequestPublication={onRequestPublication && thread.messages[index + 1]?.role === "assistant" ? (attachment) => onRequestPublication(attachment, thread.messages[index + 1]!.id) : undefined} readOnly={readOnly} onEdit={(content) => onEditMessage(message, content)} /> : (
                    <AssistantMessage
                      liveAnswers={liveAnswers}
                      threadId={thread.id}
                      message={message}
                      recoveryPaused={streamRecovery?.paused === true && message.status === "streaming" && message.id === latestAssistantMessageId}
                      assistantName={assistantName}
                      projectId={project?.id}
                      showActivity={preferences.showActivityPanel}
                      onResolveApproval={(approval, decision) => void onResolveApproval(message.id, approval, decision)}
                      publications={publications.filter((draft) => draft.turnId === message.id && draft.threadId === thread.id)}
                      onFreezePublication={onFreezePublication}
                      onDecidePublication={onDecidePublication}
                      managedAppApprovalKeys={managedAppApprovalKeys}
                      onPreviewDocument={onPreviewDocument}
                      onOpenReview={onOpenReview}

                      onRestoreRequest={message.status === "error" && thread.messages[index - 1]?.role === "user" ? () => void restoreFailedRequest(thread.messages[index - 1]) : undefined}
                      restoreDisabled={sending || documentUploading || restoringRequest}
                      readOnly={readOnly}
                      managedAppAction={!readOnly && managedAppActionEnabled && message.id === latestAssistantMessageId && thread ? {
                        enabled: true,
                        threadId: thread.id,
                        onPrepared: onManagedAppPrepared,
                      } : null}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="h-8" aria-hidden="true" />
          </div>
        ) : <section className={`chat-empty-state mx-auto min-h-full w-full ${composerEngaged ? "chat-empty-state-engaged" : ""}`} aria-label={t("Conversación vacía")} />}
      </div>

      {readOnly ? (
        <div className="shrink-0 border-t border-[var(--border-subtle)] bg-[var(--surface)] px-4 py-3 text-center text-[11px] font-medium text-[var(--text-muted)]">
          {streamRecovery ? <StreamRecoveryBanner {...streamRecovery} /> : null}
          <div role="status">{t("Conversación de solo lectura · puedes consultar el historial y los archivos compartidos.")}</div>
        </div>
      ) : <div data-g03-landing={!hasMessages && g03ProductInstallation(installationId ?? "") ? "true" : undefined} className={`mobile-composer-dock ${hasMessages ? "relative shrink-0 bg-[var(--surface)]/94 pb-[max(.75rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur-md md:pb-6" : "chat-empty-composer-dock !absolute inset-x-0 z-10"} px-3 md:px-6`}>
        {selectionLoading ? <div role="status" className="px-3 py-2 text-center text-xs text-[var(--text-secondary)]">{t("Abriendo conversación…")}</div> : null}
        {hasMessages && !isAtBottom ? <div className="mb-2 flex justify-center md:absolute md:left-1/2 md:top-0 md:z-20 md:mb-0 md:-translate-x-1/2 md:-translate-y-full"><button
          type="button"
          className="flex min-h-10 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-[11px] font-medium text-[var(--text)] shadow-[var(--shadow-sm)]"
          onPointerDown={(event) => {
            if (event.button === 0) jumpToBottom();
          }}
          onClick={(event) => {
            if (event.detail === 0) jumpToBottom();
          }}
        ><ArrowDown size={13} />{t("Volver al final")}</button></div> : null}
        <div className="relative mx-auto max-w-[var(--composer-width)]">
          {!hasMessages ? <h1 className="landing-headline mb-7 text-center text-balance font-normal text-[var(--text)]">{landingHeadline}</h1> : null}
          {sending && hasMessages ? <MessageQueue
            running={runningMessage}
            queued={queuedMessages}
            onCancel={onCancelQueuedMessage}
            onStop={queueingMessage ? onStop : undefined}
            stopping={stopping}
            language={locale}
            className="mb-2 max-w-none"
          /> : null}
          {!networkOnline ? <div className={`menu-enter flex min-h-11 items-center justify-center gap-2 rounded-[18px] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-4 py-2.5 text-center text-[12px] text-[var(--text-secondary)] shadow-[var(--shadow-popover)] ${hasMessages ? "mb-2" : "absolute inset-x-0 bottom-full mb-2"}`} role="alert"><WarningCircle size={15} className="shrink-0 text-[var(--text-subtle)]" />{t("Sin conexión. El historial sigue disponible y no se enviará nada.")}</div> : streamRecovery ? <div className={hasMessages ? "mb-2" : "absolute inset-x-0 bottom-full mb-2"}><StreamRecoveryBanner {...streamRecovery} /></div> : sending && !hasMessages ? <div className="absolute inset-x-0 bottom-full mb-2 flex min-h-9 items-center justify-center gap-2 text-center text-[11px] text-[var(--text-secondary)]" role="status"><span className="size-3.5 animate-spin rounded-full border-2 border-[var(--border-strong)] border-t-[var(--text-secondary)] motion-reduce:animate-none" aria-hidden="true" />{t("Enviando solicitud")}</div> : runtimeStatus.codex === "checking" ? <div className={`flex min-h-9 items-center justify-center gap-2 text-center text-[11px] text-[var(--text-secondary)] ${hasMessages ? "mb-2" : "absolute inset-x-0 bottom-full mb-2"}`} role="status"><span className="size-3.5 animate-spin rounded-full border-2 border-[var(--border-strong)] border-t-[var(--text-secondary)] motion-reduce:animate-none" aria-hidden="true" />{t("Conectando con el servicio…")}</div> : runtimeStatus.mode === "codex" && !runtimeStatus.ready ? <div className={`menu-enter flex min-h-11 flex-wrap items-center justify-center gap-2 rounded-[18px] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-4 py-2.5 text-center text-[12px] text-[var(--text-secondary)] shadow-[var(--shadow-popover)] ${hasMessages ? "mb-2" : "absolute inset-x-0 bottom-full mb-2"}`} role="alert"><WarningCircle size={15} className="shrink-0 text-[var(--text-subtle)]" /><span>{t(runtimeStatus.authenticationRequired === true ? "Necesitas iniciar sesión en tu cuenta de IA para continuar. Puedes revisar el historial." : "El servicio no está disponible. Puedes revisar el historial.")}</span><button type="button" className="min-h-8 rounded-full border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 text-[11px] font-semibold text-[var(--text)] transition hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" onClick={onRetryRuntime}>{t("Reintentar")}</button></div> : null}
          <div
            ref={composerShellRef}
            data-testid="composer"
            data-layout={hasMessages ? "conversation" : "landing"}
            data-focused={composerFocused ? "true" : "false"}
            className={`composer-shadow relative flex flex-col rounded-2xl border bg-[var(--surface-raised)] p-2 ${hasMessages ? "composer-conversation" : "composer-landing"} ${composerFocused ? "composer-focused" : ""} ${hasMessages && !composerMultiline && !attachments.length && !documents.length && !serverReferences.length && !imageGeneration ? "composer-compact" : ""} ${dragActive ? "border-[var(--border-strong)] ring-2 ring-[var(--border)]" : "border-transparent"}`}
            onPaste={(event) => {
              // Some clipboard providers expose file items without populating
              // FileList. Read handles synchronously while the paste is trusted.
              const listed = Array.from(event.clipboardData.files);
              const files = listed.length ? listed : Array.from(event.clipboardData.items ?? [])
                .filter((item) => item.kind === "file")
                .map((item) => item.getAsFile())
                .filter((file): file is File => file !== null);
              if (!files.length) return;
              event.preventDefault();
              void addFiles(files);
            }}
            onFocusCapture={() => setComposerFocused(true)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setComposerFocused(false);
            }}
          >
            {fileReading ? <p role="status" className="px-3 py-1 text-[11px] text-[var(--text-muted)]">{t("Preparando adjuntos…")}</p> : null}
            {dragActive ? <div className="pointer-events-none absolute inset-1 z-20 grid place-items-center rounded-[var(--brain-radius)] bg-[var(--surface-raised)]/95 text-[12px] font-semibold text-[var(--text)]">{t("Suelta los archivos para adjuntarlos")}</div> : null}
            {composerMenuOpen ? (
              <div ref={composerMenuRef} id="composer-add-menu" role="menu" aria-label={t("Añadir al mensaje")} className={`absolute inset-x-0 z-30 rounded-[20px] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-2 shadow-[var(--shadow-lg)] ${hasMessages ? "bottom-full mb-2 origin-bottom" : "top-full mt-2 origin-top"}`} onKeyDown={onComposerMenuKeyDown}>
                {(canAttachImages || canAttachDocuments) ? <button role="menuitem" tabIndex={-1} className="touch-target flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] text-[var(--text)] hover:bg-[var(--surface-hover)] active:scale-[.99]" disabled={selectionLoading || sending || documentUploading} onClick={() => { setComposerMenuOpen(false); fileInputRef.current?.click(); }}><Paperclip size={17} />{t("Adjuntar archivos")}</button> : null}
                {canGenerateImages ? <button role="menuitemcheckbox" tabIndex={-1} aria-checked={imageGeneration} className="touch-target flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] text-[var(--text)] hover:bg-[var(--surface-hover)] active:scale-[.99] disabled:opacity-45" disabled={sending} onClick={() => { onImageGenerationChange(!imageGeneration); setComposerMenuOpen(false); requestAnimationFrame(() => composerAddButtonRef.current?.focus()); }}><ImagesSquare size={17} /><span className="min-w-0 flex-1">{t("Crear imagen")}</span>{imageGeneration ? <Check size={13} weight="bold" /> : null}</button> : null}
                <button role="menuitem" tabIndex={-1} className="touch-target flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] text-[var(--text)] hover:bg-[var(--surface-hover)] active:scale-[.99] disabled:opacity-45" disabled={sending} onClick={() => openAuthorizedConnectors(composerAddButtonRef.current)}><At size={17} />{t("Tools")}</button>
                {serverFilesAvailable ? <button role="menuitem" tabIndex={-1} className="touch-target flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] text-[var(--text)] disabled:opacity-45" disabled={!project || sending || !onServerReferencesChange} onClick={() => { serverReturnFocusRef.current = composerAddButtonRef.current; setComposerMenuOpen(false); setServerOpenKey(serverSelectionKey); }}><FileIcon size={17} />{t("Server")}</button> : null}
              </div>
            ) : null}
            {serverFilesAvailable && serverOpen && project && onServerReferencesChange ? <ServerPicker key={project.id + (thread?.id ?? "")} projectId={project.id} selected={serverReferences} onSelect={onServerReferencesChange} onClose={() => setServerOpenKey(null)} returnFocus={serverReturnFocusRef} /> : null}
            {serverFilesAvailable && serverReferences.length ? <div className="flex flex-wrap gap-2 px-2 py-1" aria-label={t("Referencias Server")}>{serverReferences.map(item => <span key={item.path} title={item.path} className="flex max-w-full items-center gap-2 rounded-lg bg-[var(--surface-hover)] px-2 py-1 text-xs"><FileIcon size={14}/><span className="truncate">{item.name}{item.kind === "directory" ? " · carpeta" : ""}</span><button type="button" aria-label={t("Quitar referencia {p0}", { p0: item.name })} className="touch-target" onClick={() => onServerReferencesChange?.(serverReferences.filter(ref => ref.path !== item.path))}><X size={14}/></button></span>)}</div> : null}
            {attachments.length || documents.length ? (
              <div className="flex gap-2 overflow-x-auto px-2 pb-1 pt-1">
                {attachments.map((attachment) => (
                  <div key={attachment.id} className="group/attachment flex min-w-0 max-w-56 shrink-0 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-1.5">
                    <span className="grid size-6 shrink-0 place-items-center rounded-md bg-[var(--surface-raised)] text-[var(--text-muted)]"><NextImage unoptimized src={attachment.dataUrl} width={32} height={32} alt={t("Vista previa de {p0}", { p0: attachment.name })} className="size-6 object-contain" /></span>
                    <span className="min-w-0"><span className="block truncate text-[12px] font-medium text-[var(--text-secondary)]">{attachment.name}</span><span className="block text-[11px] text-[var(--text-subtle)]">{t("Lista ·")}{" "}{Math.ceil(attachment.size / 1024)} {" "}{t("KB")}</span></span>
                    <button type="button" aria-label={t("Quitar {p0}", { p0: attachment.name })} className="touch-target ml-auto grid size-5 shrink-0 place-items-center rounded-md text-[var(--text-subtle)] hover:bg-[var(--surface-raised)] hover:text-[var(--text)]" onClick={() => onAttachmentsChange(attachments.filter((item) => item.id !== attachment.id))}><X size={10} /></button>
                  </div>
                ))}
                {documents.map((document) => (
                  <div key={document.uploadId} className={`group/attachment flex min-w-0 max-w-64 shrink-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 ${document.status === "error" ? "border-[var(--danger)] bg-[var(--danger-soft)]" : "border-[var(--border)] bg-[var(--surface-muted)]"}`}>
                    <span className="grid size-6 shrink-0 place-items-center rounded-md bg-[var(--surface-raised)] text-[var(--text-muted)]">{document.kind === "image" && document.status === "ready" && document.previewFiles[0] ? <NextImage unoptimized src={document.previewFiles[0].url} width={32} height={32} alt={t("Vista previa de {p0}", { p0: document.name })} className="size-6 object-contain" /> : document.status === "uploading" ? <SpinnerGap size={12} className="motion-safe:animate-spin" /> : <FileIcon size={12} />}</span>
                    <span className="min-w-0"><span className="block truncate text-[12px] font-medium text-[var(--text-secondary)]">{document.name}</span><span className={`block truncate text-[11px] ${document.status === "error" ? "text-[var(--danger)]" : "text-[var(--text-subtle)]"}`}>{document.status === "uploading" ? (document.kind === "audio" ? t("Transcribiendo audio…") : t("Preparando vista previa…")) : document.status === "error" ? document.error : document.processingUnavailable ? t("Original guardado · procesamiento no disponible") : document.passive ? t("Copia pasiva · datos sin verificar") : document.previewUnavailable ? t("Guardado · vista previa no disponible") : `Lista · ${document.kind.toUpperCase()}${document.pages ? t(" · {p0} pág.", { p0: document.pages }) : ""}`}</span></span>
                    {document.status === "ready" && document.previewFiles[0] ? <a href={document.previewFiles[0].url} target="_blank" rel="noreferrer" className="text-[11px] font-semibold text-[var(--brain-accent)] hover:underline">{t("Abrir")}</a> : null}
                    <button type="button" aria-label={t("Quitar {p0}", { p0: document.name })} className="touch-target ml-auto grid size-5 shrink-0 place-items-center rounded-md text-[var(--text-subtle)] hover:bg-[var(--surface-raised)] hover:text-[var(--text)]" onClick={() => onDocumentsChange(documents.filter((item) => item.uploadId !== document.uploadId))}><X size={10} /></button>
                  </div>
                ))}
              </div>
            ) : null}
            {imageGeneration ? <div className="flex px-2 pt-1" aria-label={t("Generación de imágenes activada")}>
              <span className="flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"><ImagesSquare size={11} />{t("Crear imagen")}<button type="button" aria-label={t("Desactivar generación de imágenes")} disabled={sending} className="touch-target grid place-items-center rounded-full hover:bg-[var(--surface-raised)] disabled:opacity-40" onClick={() => onImageGenerationChange(false)}><X size={10} /></button></span>
            </div> : null}
            {restoringRequest ? <p className="px-3 py-2 text-xs text-[var(--text-secondary)]" role="status">{t("Recuperando solicitud…")}</p> : documents.some((document) => document.status === "error") ? <p className="px-3 py-2 text-xs text-[var(--danger)]" role="alert">{t("Hay archivos no disponibles. Vuelve a adjuntarlos o quítalos antes de enviar.")}</p> : null}
            <div
              ref={composerMeasurementRef}
              aria-hidden="true"
              className="composer-measurement pointer-events-none invisible absolute inset-x-2 top-2 whitespace-pre-wrap [overflow-wrap:anywhere]"
            >
              {`${prompt}\u200b`}
            </div>
            {hasInlineMentions ? <div ref={mentionOverlayRef} aria-hidden="true" className="composer-mention-overlay pointer-events-none absolute overflow-hidden whitespace-pre-wrap [overflow-wrap:anywhere] text-[var(--text)]">{mentionParts.map((part, index) => part.id ? <span key={index} className="text-[var(--text)]"><span className="relative text-transparent">@<span className="absolute inset-0 flex items-center justify-center"><ConnectorLogo id={part.id} size={13} /></span></span>{part.text.slice(1)}</span> : part.text)}{"\u200b"}</div> : null}
            <textarea
              ref={composerRef}
              disabled={selectionLoading}
              aria-label={t("Mensaje")}
              aria-autocomplete="list"
              aria-controls={mentionOpen ? "connector-mention-options" : undefined}
              aria-activedescendant={mentionOpen && activeMentionOption ? connectorOptionId("mention", activeMentionOption.id) : undefined}
              autoFocus={false}
              className={`composer-textarea max-h-52 w-full resize-none overflow-y-auto bg-transparent px-2.5 py-2.5 leading-[24px] text-[var(--text)] outline-none placeholder:text-[var(--text-subtle)] ${hasMessages ? "min-h-8" : "min-h-12"}`}
              style={hasInlineMentions ? { color: "transparent", caretColor: "var(--text)" } : undefined}
              placeholder={imageGeneration ? t("Describe la imagen que quieres crear…") : t("Escribe a {name}…", { name: placeholderName })}
              rows={1}
              defaultValue={prompt}
              onChange={(event) => { changeComposerText(event.target.value); syncCaret(event.target); setConnectorCatalogOpen(false); setMentionActiveIndex(0); const inputType = (event.nativeEvent as InputEvent).inputType ?? ""; setMentionOpen(!inputType.startsWith("delete") && Boolean(mentionQueryAt(event.target.value, event.target.selectionStart))); }}
              onSelect={(event) => syncCaret(event.currentTarget)}
              onClick={(event) => { syncCaret(event.currentTarget); setMentionOpen(Boolean(mentionQueryAt(event.currentTarget.value, event.currentTarget.selectionStart))); }}
              onScroll={(event) => { if (mentionOverlayRef.current) mentionOverlayRef.current.scrollTop = event.currentTarget.scrollTop; }}
              onCompositionStart={() => { setComposing(true); setMentionOpen(false); }}
              onCompositionEnd={(event) => { setComposing(false); syncCaret(event.currentTarget); }}
              onBlur={() => setMentionOpen(false)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (mentionOpen) {
                  if (event.key === "ArrowDown" && mentionOptions.length) {
                    event.preventDefault();
                    setMentionActiveIndex((current) => (current + 1) % Math.max(mentionOptions.length, 1));
                    return;
                  }
                  if (event.key === "ArrowUp" && mentionOptions.length) {
                    event.preventDefault();
                    setMentionActiveIndex((current) => (current - 1 + Math.max(mentionOptions.length, 1)) % Math.max(mentionOptions.length, 1));
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setMentionOpen(false);
                    return;
                  }
                  if (event.key === "Enter" && activeMentionOption && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    selectConnectorMention(activeMentionOption);
                    return;
                  }
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (!selectionLoading && !documentUploading && !documentsBlocked && hasSendableContent && runtimeReady) {
                    jumpToBottom();
                    onSend();
                  }
                }
              }}
            />
            {mentionOpen && mentionQuery !== null ? <ConnectorPopover anchor={composerRef} caret={composerCaret}><div id="connector-mention-options" role="listbox" aria-label={t("Conectores disponibles")} className="max-h-[inherit] overflow-y-auto overscroll-contain outline-none">
              {mentionOptions.length ? mentionOptions.map((mention, index) => <button key={mention.id} id={connectorOptionId("mention", mention.id)} type="button" role="option" aria-selected={index === visibleMentionActiveIndex} tabIndex={-1} disabled={(!mention.canRead && !mention.connectUrl) || sending} className={`touch-target flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] text-[var(--text)] ${index > 0 && !mention.canRead && mentionOptions[index - 1].canRead ? "mt-2 border-t border-[var(--border)] pt-3" : ""} ${index === visibleMentionActiveIndex ? "bg-[var(--surface-selected)]" : "hover:bg-[var(--surface-hover)]"} disabled:cursor-not-allowed disabled:opacity-55`} onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setMentionActiveIndex(index)} onClick={() => selectConnectorMention(mention)}><ConnectorLogo id={mention.id} /><span className="min-w-0 flex-1"><span className="block truncate font-medium">{mention.label}</span><span className="mt-0.5 block truncate text-[11px] text-[var(--text-subtle)]">{t(connectorPresentation(mention.id).description)}</span></span><span className="text-[11px] text-[var(--text-subtle)]">{t(connectorStatusLabel(mention))}</span>{selectedConnectorMentionIds.includes(mention.id) ? <Check size={13} weight="bold" aria-label={t("Seleccionado")} /> : null}</button>) : <p className="px-3 py-2 text-[12px] text-[var(--text-subtle)]">{t("No hay conectores autorizados que coincidan.")}</p>}
            </div></ConnectorPopover> : null}
            {connectorCatalogOpen ? <ConnectorPopover anchor={connectorTriggerRef} triggerAligned avoidOverlapWith={composerShellRef}><>
              {connectorCatalogStatus === "loading" ? <p role="status" className="px-3 py-4 text-[12px] text-[var(--text-subtle)]">{t("Cargando tus conectores…")}</p> : null}
              {connectorCatalogStatus === "error" ? <div className="px-3 py-3"><p role="alert" className="text-[12px] text-[var(--text-subtle)]">{t("No se ha podido cargar el catálogo de conectores.")}</p><button type="button" onClick={onRetryConnectorCatalog} className="touch-target mt-2 rounded-lg border border-[var(--border)] px-3 py-2 text-[12px]">{t("Reintentar")}</button></div> : null}
              <div ref={connectorCatalogRef} tabIndex={0} role="listbox" aria-label={t("Catálogo de conectores")} aria-busy={connectorCatalogStatus === "loading"} aria-activedescendant={activeCatalogOption ? connectorOptionId("catalog", activeCatalogOption.id) : undefined} className="max-h-[inherit] overflow-y-auto overscroll-contain outline-none" onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setCatalogActiveIndex((current) => nextEnabledConnectorIndex(catalogOptions, current, event.key === "ArrowDown" ? 1 : -1));
              } else if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                const ordered = event.key === "Home" ? catalogOptions : [...catalogOptions].reverse();
                const target = ordered.find((mention) => mention.canRead || mention.connectUrl);
                if (target) setCatalogActiveIndex(catalogOptions.indexOf(target));
              } else if (event.key === "Enter" && activeCatalogOption) {
                event.preventDefault();
                selectCatalogConnector(activeCatalogOption);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setConnectorCatalogOpen(false);
                requestAnimationFrame(() => connectorTriggerRef.current?.focus());
              } else if (event.key === "Tab" && connectorCatalogStatus !== "error") {
                event.preventDefault();
                setConnectorCatalogOpen(false);
                requestAnimationFrame(() => (event.shiftKey ? composerRef.current : connectorTriggerRef.current)?.focus());
              }
            }}>
              {catalogOptions.map((mention, index) => <button key={mention.id} id={connectorOptionId("catalog", mention.id)} type="button" role="option" aria-selected={index === visibleCatalogActiveIndex} tabIndex={-1} disabled={(!mention.canRead && !mention.connectUrl) || sending} className={`touch-target flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] text-[var(--text)] ${index > 0 && !mention.canRead && catalogOptions[index - 1].canRead ? "mt-2 border-t border-[var(--border)] pt-3" : ""} ${index === visibleCatalogActiveIndex ? "bg-[var(--surface-selected)]" : "hover:bg-[var(--surface-hover)]"} disabled:cursor-not-allowed disabled:opacity-55`} onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setCatalogActiveIndex(index)} onClick={() => selectCatalogConnector(mention)}><ConnectorLogo id={mention.id} /><span className="min-w-0 flex-1"><span className="block truncate font-medium">{mention.label}</span><span className="mt-0.5 block truncate text-[11px] text-[var(--text-subtle)]">{t(connectorPresentation(mention.id).description)}</span></span><span className="text-[11px] text-[var(--text-subtle)]">{t(connectorStatusLabel(mention))}</span>{selectedConnectorMentionIds.includes(mention.id) ? <Check size={13} weight="bold" aria-label={t("Seleccionado")} /> : null}</button>)}
              {connectorCatalogStatus === "ready" && catalogOptions.length === 0 ? <p className="px-3 py-4 text-[12px] text-[var(--text-subtle)]">{t("No hay conectores habilitados en tu catálogo.")}</p> : null}
            </div></></ConnectorPopover> : null}
            <div data-testid="composer-controls" className="composer-controls relative flex items-center justify-between gap-3 px-1 pb-0.5">
              <div className="composer-controls-start flex min-w-0 items-center gap-1 overflow-visible">
                <button ref={composerAddButtonRef} aria-label={t("Añadir al mensaje")} aria-haspopup="menu" aria-controls={composerMenuOpen ? "composer-add-menu" : undefined} aria-expanded={composerMenuOpen} className={`composer-add-button composer-tool !grid !size-8 !place-items-center !rounded-full ${composerMenuOpen ? "composer-tool-active" : ""}`} disabled={selectionLoading || sending || !project} onClick={() => { setComposerPickerOpen(null); setMentionOpen(false); setConnectorCatalogOpen(false); setComposerMenuOpen((current) => !current); }}><span className="composer-add-icon" aria-hidden="true"><Plus size={15} /></span></button>
                {canAttachImages || canAttachDocuments ? <input ref={fileInputRef} disabled={selectionLoading} aria-label={t("Seleccionar archivos para adjuntar")} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif,audio/ogg,audio/opus,.ogg,.opus,application/pdf,.docx,.xlsx,.xltx,.xls,.xlsm,.pptx,.txt,.asc,.md,.csv,.json" multiple tabIndex={-1} onChange={(event) => void addFiles(event.target.files)} /> : null}
              </div>
              <div className="composer-controls-end flex shrink-0 items-center gap-2">
                <ComposerPicker
                  ariaLabel={t("Experiencia")}
                  value={composerExperience}
                  valueLabel={composerExperience === "expert" ? t("Experto") : t("Inteligente")}
                  options={[
                    { value: "smart", label: t("Inteligente"), detail: t("Redacción y planificación diaria") },
                    { value: "expert", label: t("Experto"), detail: t("Análisis y problemas complejos") },
                  ]}
                  open={composerPickerOpen === "experience"}
                  placement={hasMessages ? "above" : "below"}
                  align="end"
                  anchor="controls"
                  className="composer-experience"
                  disabled={sending}
                  onOpenChange={(open) => { setComposerMenuOpen(false); setMentionOpen(false); setConnectorCatalogOpen(false); setComposerPickerOpen(open ? "experience" : null); }}
                  onSelect={(value) => onComposerExperienceChange(value as ComposerExperience)}
                />
                <VoiceDictationControl
                  value={prompt}
                  disabled={selectionLoading || !project || sending || documentUploading}
                  language={locale === "en" ? "en-US" : locale === "ca" ? "ca-ES" : "es-ES"}
                  onChange={onPromptChange}
                  onNotice={onComposerNotice}
                />
                <button
                  type="button"
                  aria-label={queueingMessage ? t("Añadir mensaje a la cola") : sending ? (stopping ? t("Deteniendo respuesta") : t("Detener respuesta")) : t("Enviar mensaje")}
                  aria-busy={(!queueingMessage && stopping) || undefined}
                  className="composer-submit grid size-8 place-items-center rounded-full bg-[var(--send-button)] text-[var(--send-button-text)] transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 sm:rounded-full"
                  disabled={(selectionLoading && (!sending || queueingMessage)) || (queueingMessage ? !project || !runtimeReady || documentUploading || documentsBlocked : sending ? stopping : !project || !hasSendableContent || !runtimeReady || documentUploading || documentsBlocked)}
                  onClick={() => {
                    if (sending) {
                      if (queueingMessage) onSend();
                      else onStop();
                      return;
                    }
                    jumpToBottom();
                    onSend();
                  }}
                >
                  <span key={queueingMessage ? "queue" : sending ? "stop" : "send"} className="composer-submit-icon" aria-hidden="true">
                    {queueingMessage ? <ArrowUp size={18} weight="bold" /> : sending ? <Stop size={15} weight="fill" /> : <ArrowUp size={18} weight="bold" />}
                  </span>
                </button>
              </div>
            </div>
          </div>
          {!hasMessages ? <div ref={landingBandRef} className="landing-band" aria-label={t("Opciones para empezar")}>
            <div className="landing-project"><FolderOpen size={15} aria-hidden="true" />
                {!hasMessages ? (
                  <ComposerPicker
                    ariaLabel={t("Destino de la conversación")}
                    value={project?.id ?? ""}
                    valueLabel={noProject ? t("Proyecto") : project?.name ?? t("Proyecto")}
                    options={destinationOptions}
                    open={composerPickerOpen === "destination"}
                    placement="below"
                    className="composer-destination"
                    disabled={sending}
                    onOpenChange={(open) => { setComposerMenuOpen(false); setMentionOpen(false); setConnectorCatalogOpen(false); setComposerPickerOpen(open ? "destination" : null); }}
                    onSelect={onDestinationChange}
                  />
                ) : null}

            </div>
            {serverFilesAvailable ? <button type="button" className="landing-band-item" disabled={!project || sending || !onServerReferencesChange} onClick={event => { serverReturnFocusRef.current = event.currentTarget; setServerOpenKey(serverSelectionKey); }}><FileIcon size={15} aria-hidden="true" /><span className="truncate">{t("Server")}</span><CaretDown size={11} aria-hidden="true" /></button> : null}
            <button type="button" className="landing-band-item" disabled={sending} aria-haspopup="listbox" aria-expanded={connectorCatalogOpen} onClick={(event) => { setComposerPickerOpen(null); if (connectorCatalogOpen) setConnectorCatalogOpen(false); else openAuthorizedConnectors(event.currentTarget); }}><At size={15} aria-hidden="true" /><span className="truncate">{t("Tools")}</span><CaretDown size={11} aria-hidden="true" /></button>
          </div> : null}
          {!hasMessages ? <div className="landing-suggestions mx-auto mt-5 w-full max-w-[720px]" aria-label={t("Sugerencias para empezar")}>
            <LandingTasks tasks={suggestions} disabled={sending} onSelect={selectSuggestion} onCreateAutomation={onCreateAutomation} />
          </div> : null}
        </div>
      </div>}
    </main>
  );
}
