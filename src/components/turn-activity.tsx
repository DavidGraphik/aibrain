"use client";
import { spanishUiText, type UiText } from "@/i18n/messages";
import { useUiText } from "@/i18n/provider";

import { useState } from "react";
import {
  Brain,
  Check,
  FileCode,
  GitDiff,
  Globe,
  ListChecks,
  Pause,
  Robot,
  SpinnerGap,
  TerminalWindow,
  Wrench,
  X,
} from "@phosphor-icons/react";
import type {
  ActivityItem,
  ApprovalDecision,
  ApprovalItem,
  ChatMessage,
} from "@/lib/chat-contract";
import { ManagedAppActionControl } from "@/components/managed-app-action-control";
import type { ManagedAppActionDescriptor } from "@/ui/codex-managed-app-ui";
import { managedAppActionKey } from "@/ui/codex-managed-app-ui";
import { PermissionGrant } from "@/components/assistant-ui/elements/permission-grant";
import { ToolTimeline } from "@/components/assistant-ui/elements/tool-timeline";
import { ToolResultCard } from "@/components/tool-result-list";
import { AgentStatusOrb } from "@/components/agent-status-orb";
import { WorkspaceFilePreview } from "@/components/workspace-file-preview";
import {
  buildTurnTimeline,
  formatWorkDuration,
  turnDurationMs,
} from "@/ui/turn-timeline";
import {
  publicActivityText,
  publicCommandTitle,
  publicProjectPath,
  publicToolOutput,
} from "@/ui/public-activity";
import {
  ThinkingStep,
} from "@/components/ui/thinking-steps";

type TurnActivityProps = {
  message: ChatMessage;
  projectId?: string;
  compact?: boolean;
  showDiff?: boolean;
  readOnly?: boolean;
  recoveryPaused?: boolean;
  onResolveApproval: (approval: ApprovalItem, decision: ApprovalDecision) => void;
  onOpenReview?: () => void;
  managedAppAction?: {
    enabled: boolean;
    threadId: string;
    onPrepared: (descriptor: ManagedAppActionDescriptor) => void;
  } | null;
  /** Connector identity remains available while the employee visits another thread. */
  managedAppApprovalKeys?: readonly string[];
};

const SYSTEM_ACTIVITY_LABELS: Record<string, string> = {
  "Resultat aprovat": "Resultado aprobado",
  "Resultat pendent de revisió": "Resultado pendiente de revisión",
  "Revertint els canvis": "Deshaciendo los cambios",
  "Canvis revertits i verificats": "Cambios deshechos y verificados",
  "Preparant el context": "Preparando el contexto",
  "Context preparat": "Contexto preparado",
  "Connectant amb Codex": "Conectando con el asistente",
  "Codex connectat": "El asistente está listo",
  "Obrint la conversa": "Abriendo la conversación",
  "Conversa oberta": "Conversación abierta",
  "Recuperant la conversa": "Recuperando la conversación",
  "Conversa recuperada": "Conversación recuperada",
  "Iniciant el torn": "Iniciando la tarea",
  "Torn iniciat": "Tarea iniciada",
  "Torn recuperat": "Tarea recuperada",
  "Recuperant el torn": "Recuperando la tarea",
  "No s’ha pogut recuperar el torn": "No se ha podido recuperar la tarea",
  "Esperant activitat del model": "Esperando actividad del modelo",
  "Codex està treballant": "El asistente está trabajando",
  "Preparant el resum del raonament": "Preparando el resumen del razonamiento",
  "Codex està raonant": "El asistente está preparando la respuesta",
  "Verificant el model": "Verificando el modelo",
  "Canviant de model": "Cambiando de modelo",
  "Verificant la resposta": "Verificando la respuesta",
  "Processant la resposta del model": "Procesando la respuesta del modelo",
  "Resposta del model rebuda": "Respuesta del modelo recibida",
};

const GENERIC_RUNTIME_LABELS = new Set([
  "Executant una ordre",
  "Ordre executada",
  "Preparant canvis",
  "Canvis de fitxers",
  "Cercant al web",
  "Cerca web completada",
  "Raonant",
  "Raonament completat",
  "Preparant el pla",
  "Pla preparat",
  "Coordinant agents",
  "Coordinació completada",
]);

const LIFECYCLE_ACTIVITY_IDS = new Set([
  "runtime-context",
  "runtime-connect",
  "runtime-thread",
  "runtime-thread-recovery",
  "runtime-thread-retry",
  "runtime-turn-start",
  "runtime-turn-recovery",
  "runtime-awaiting-model",
  "runtime-model-active",
  "runtime-reasoning",
  "runtime-model-verification",
  "runtime-model-reroute",
  "runtime-safety-buffering",
  "runtime-response-processing",
  "runtime-performance",
  "client-request-status",
]);

function translatedRuntimeLabel(label: string, t: UiText) {
  const safe = label.replace(/el asistente/gu, t("El asistente").toLocaleLowerCase());
  const running = safe.match(/^(?:Utilitzant|Usando) (.+)$/u);
  if (running) return t("Usando {herramienta}", { herramienta: t(running[1]) });
  const completed = safe.match(/^(.+) (?:completat|completado)$/u);
  if (completed) return t("{herramienta} completado", { herramienta: t(completed[1]) });
  return t(safe);
}

function ActivityIcon({ item, recoveryPaused = false }: { item: ActivityItem; recoveryPaused?: boolean }) {
  if (recoveryPaused && (item.status === "running" || item.status === "waiting")) return <Pause size={13} />;
  if (item.status === "running" || item.status === "waiting") {
    return <SpinnerGap size={13} className="motion-safe:animate-spin" />;
  }
  if (item.status === "failed" || item.status === "stopped") return <X size={12} weight="bold" />;

  const props = { size: 13, weight: "regular" as const };
  if (item.kind === "command") return <TerminalWindow {...props} />;
  if (item.kind === "file") return <FileCode {...props} />;
  if (item.kind === "web") return <Globe {...props} />;
  if (item.kind === "agent") return <Robot {...props} />;
  if (item.kind === "reasoning") return <Brain {...props} />;
  if (item.kind === "plan") return <ListChecks {...props} />;
  if (item.kind === "tool") return <Wrench {...props} />;
  return <Check {...props} weight="bold" />;
}

function activityPresentation(item: ActivityItem, t: UiText = spanishUiText) {
  const detail = publicActivityText(item.detail) ?? undefined;
  const active = item.status === "running" || item.status === "waiting";
  const safeLabel = publicActivityText(item.label, 240) ?? t("Actividad completada");
  const customLabel = safeLabel && !GENERIC_RUNTIME_LABELS.has(item.label)
    ? (SYSTEM_ACTIVITY_LABELS[item.label] ? t(SYSTEM_ACTIVITY_LABELS[item.label]) : translatedRuntimeLabel(safeLabel, t))
    : null;
  let title = customLabel;
  let secondaryDetail: string | undefined = detail;

  if (!title) {
    if (item.kind === "reasoning") {
      title = detail || (active ? t("Pensando") : t("Razonamiento completado"));
      secondaryDetail = undefined;
    } else if (item.kind === "command") {
      title = publicCommandTitle(item.detail, active);
      secondaryDetail = undefined;
    } else if (item.kind === "file") {
      title = detail ? `${active ? t("Preparando cambios en") : t("Cambios preparados en")} ${detail}` : active ? t("Editando archivos") : t("Cambios preparados");
      secondaryDetail = undefined;
    } else if (item.kind === "web") {
      title = detail ? `${active ? t("Buscando") : t("Búsqueda completada")}: ${detail}` : active ? t("Buscando en la web") : t("Información consultada");
      secondaryDetail = undefined;
    } else if (item.kind === "agent") {
      title = detail ? `${active ? t("Coordinando") : t("Coordinación completada")}: ${detail}` : active ? t("Coordinando agentes") : t("Coordinación completada");
      secondaryDetail = undefined;
    } else {
      title = {
        tool: active ? t("Usando herramienta") : t("Herramienta completada"),
        plan: active ? t("Preparando el plan") : t("Plan preparado"),
        system: SYSTEM_ACTIVITY_LABELS[item.label] ? t(SYSTEM_ACTIVITY_LABELS[item.label]) : item.label,
      }[item.kind];
    }
  }

  if (item.status === "failed") title = t("No se ha podido completar: {p0}", { p0: title });
  if (item.status === "stopped") title = t("Paso detenido: {title}", { title });
  if (item.status === "pending") title = t("Pendiente: {title}", { title });
  return { title, detail: secondaryDetail };
}

/** Runtime lifecycle events remain persisted for diagnostics, but they are not
 * useful steps in the employee-facing work process. Failures stay visible. */
export function isRelevantProcessActivity(item: ActivityItem) {
  if (item.status === "failed" || item.status === "stopped") return true;
  return !LIFECYCLE_ACTIVITY_IDS.has(item.id);
}

export function hasRelevantWorkProcess(
  message: Pick<ChatMessage, "activity" | "plan"> & Partial<Pick<ChatMessage, "toolResults">>,
) {
  return message.plan.some((step) => step.status !== "pending") ||
    message.activity.some((item) => item.status !== "pending" && isRelevantProcessActivity(item)) ||
    Boolean(message.toolResults?.length);
}

export function currentActivityLabel(relevantActivity: ActivityItem[], t: UiText = spanishUiText) {
  for (let index = relevantActivity.length - 1; index >= 0; index -= 1) {
    const item = relevantActivity[index];
    if (item.status === "running" || item.status === "waiting") return activityPresentation(item, t).title;
  }
  const latestItem = relevantActivity.at(-1);
  return latestItem ? activityPresentation(latestItem, t).title : t("Pensando");
}

/** One safe, factual status for the collapsed live response surface. */
export function currentTurnStatusLabel(message: Pick<ChatMessage, "activity">, t: UiText = spanishUiText) {
  return message.activity.length ? currentActivityLabel(message.activity, t) : null;
}

export function TurnActivity({
  message,
  projectId,
  compact = false,
  showDiff = true,
  readOnly = false,
  recoveryPaused = false,
  onResolveApproval,
  onOpenReview,
  managedAppAction = null,
  managedAppApprovalKeys = [],
}: TurnActivityProps) {
  const t = useUiText();
  const streaming = message.status === "streaming" && !recoveryPaused;
  const [manualDisclosure, setManualDisclosure] = useState<{
    status: ChatMessage["status"];
    open: boolean;
  } | null>(null);
  const executionOpen = manualDisclosure?.status === message.status
    ? manualDisclosure.open
    : false;

  const visiblePlan = message.plan.flatMap((step) => {
    const publicStep = publicActivityText(step.step, 1_000);
    return step.status !== "pending" && publicStep ? [{ ...step, step: publicStep }] : [];
  });
  const visibleActivity = message.activity
    .filter((item) => item.status !== "pending" && isRelevantProcessActivity(item))
    .map((item) => ({
      ...item,
      label: publicActivityText(item.label, 240) ?? t("Actividad"),
      ...(item.detail ? { detail: publicActivityText(item.detail) ?? undefined } : {}),
      ...(item.output ? { output: publicToolOutput(item.output) ?? undefined } : {}),
      ...(item.files ? {
        files: item.files.flatMap((file) => {
          const safePath = publicProjectPath(file.path);
          return safePath ? [{ ...file, path: safePath }] : [];
        }),
      } : {}),
    }));
  const timeline = buildTurnTimeline(visibleActivity, message.toolResults ?? []);
  const hasWorkProcess = visiblePlan.length > 0 || timeline.length > 0;
  const hasDetails = hasWorkProcess || message.approvals.length > 0 ||
    Boolean(message.diff) || Boolean(message.toolResults?.length);
  if (!hasDetails && !managedAppAction) return null;
  const duration = turnDurationMs(message);
  const executionLabel = recoveryPaused
    ? t("Recuperación de la respuesta en pausa")
    : message.status === "streaming"
    ? currentActivityLabel(visibleActivity, t)
    : duration !== null
      ? t("Ha trabajado durante {duration}", { duration: formatWorkDuration(duration) })
      : message.status === "stopped"
        ? t("Pensamiento interrumpido")
        : message.status === "error"
          ? t("Trabajo interrumpido")
          : t("Ha trabajado durante unos segundos");

  const activeActivity = [...visibleActivity].reverse().find((item) => item.status === "running" || item.status === "waiting");
  const visibleStepCount = visiblePlan.length + timeline.length;

  return (
    <div className={compact ? "space-y-4" : "mt-4 space-y-3"}>
      {hasWorkProcess ? (
        <ToolTimeline
          open={executionOpen}
          onOpenChange={(open) => setManualDisclosure({ status: message.status, open })}
          streaming={streaming}
          label={executionLabel}
          complete={message.status === "complete"}
          indicator={recoveryPaused ? <Pause size={14} /> : streaming
            ? <AgentStatusOrb kind={activeActivity?.kind ?? "system"} />
            : message.status === "stopped" || message.status === "error" ? <X size={14} /> : null}
        >
            {visiblePlan.map((step, index) => (
              <ThinkingStep
                key={`${step.step}-${index}`}
                indicator={streaming && step.status === "in_progress"
                  ? <SpinnerGap size={12} className="motion-safe:animate-spin" />
                  : <ListChecks size={12} />}
                label={step.step}
                status={step.status === "in_progress" && message.status === "streaming" ? recoveryPaused ? "pending" : "active" : "complete"}
                delay={Math.min(index * 0.035, 0.18)}
                isLast={index === visibleStepCount - 1}
              />
            ))}

            <div role="list" aria-label={t("Actividad del trabajo")}>
              {timeline.map((entry, index) => {
                const stepIndex = visiblePlan.length + index;
                if (entry.type === "tool") {
                  return (
                    <div
                      key={entry.key}
                      role="listitem"
                      data-timeline-key={entry.key}
                      className="ml-7 py-1"
                    >
                      <ToolResultCard result={entry.item} />
                    </div>
                  );
                }
                const item = entry.item;
                const presentation = activityPresentation(item, t);
                return (
                  <div key={entry.key} role="listitem" data-timeline-key={entry.key}>
                    <ThinkingStep
                      indicator={<ActivityIcon item={item} recoveryPaused={recoveryPaused} />}
                      label={presentation.title}
                      description={presentation.detail}
                      status={item.status === "running" || item.status === "waiting" ? recoveryPaused ? "pending" : "active" : "complete"}
                      delay={Math.min(stepIndex * 0.035, 0.18)}
                      isLast={stepIndex === visibleStepCount - 1}
                    >
                      {projectId && item.kind === "file" && item.files?.length ? (
                        <div className="mt-2">
                          {item.files.map((file) => (
                            <WorkspaceFilePreview key={`${file.change}:${file.path}`} projectId={projectId} file={file} />
                          ))}
                        </div>
                      ) : null}
                      {item.output ? (
                        <details className="mt-2">
                          <summary className="w-fit cursor-pointer text-[9px] font-medium text-[var(--text)]">{t("Ver salida")}</summary>
                          <pre tabIndex={0} className="scrollbar-thin mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-[#222220] px-2.5 py-2 font-mono text-[9px] leading-4 text-[#deddd9]">{publicToolOutput(item.output)}</pre>
                        </details>
                      ) : null}
                    </ThinkingStep>
                  </div>
                );
              })}
            </div>
        </ToolTimeline>
      ) : null}

      {message.approvals.map((approval) => (
        <PermissionGrant key={approval.id} approval={approval} readOnly={readOnly} connectorApproval={Boolean(approval.connectorAuthorizationFingerprint) || managedAppApprovalKeys.includes(managedAppActionKey({ ...approval, approvalId: approval.id }))} onResolve={(decision) => onResolveApproval(approval, decision)} />
      ))}

      {managedAppAction ? <ManagedAppActionControl
        enabled={managedAppAction.enabled}
        threadId={managedAppAction.threadId}
        message={message}
        onPrepared={managedAppAction.onPrepared}
      /> : null}

      {message.diff && showDiff ? onOpenReview ? (
        <button type="button" aria-label={t("Abrir cambios y resultados")} onClick={onOpenReview} className="flex max-w-[360px] items-start gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-left text-[var(--text)]">
          <GitDiff size={14} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
          <div><p className="text-[10px] font-semibold">{t("Abrir cambios y resultados")}</p><p className="mt-0.5 text-[9px] leading-4 text-[var(--text-muted)]">{t("Incluidos en este turno")}</p></div>
        </button>
      ) : (
        <section className="flex max-w-[360px] items-start gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-[var(--text)]">
          <GitDiff size={14} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
          <div><p className="text-[10px] font-semibold">{t("Cambios preparados")}</p><p className="mt-0.5 text-[9px] leading-4 text-[var(--text-muted)]">{t("Incluidos en este turno")}</p></div>
        </section>
      ) : null}
    </div>
  );
}
