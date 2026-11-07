import { isTurnOptions, type ActivityItem, type ChatRequest, type PlanStep } from "@/lib/chat-contract";
import { MAX_COMPOSER_TEXT_CHARS } from "@/lib/chat-input-limits";

export function isChatRequest(value: unknown): value is ChatRequest {
  if (!value || typeof value !== "object") return false;
  if (!("message" in value) || typeof value.message !== "string") return false;
  if ("displayMessage" in value && (typeof value.displayMessage !== "string" || value.displayMessage.length > MAX_COMPOSER_TEXT_CHARS)) return false;
  if (!("projectId" in value) || typeof value.projectId !== "string") return false;
  if (!("threadId" in value) || typeof value.threadId !== "string") return false;
  if (!("userMessageId" in value) || typeof value.userMessageId !== "string") return false;
  if (!("assistantMessageId" in value) || typeof value.assistantMessageId !== "string") return false;
  if (!("preferences" in value) || !value.preferences || typeof value.preferences !== "object") return false;

  const preferences = value.preferences;
  return (
    "tone" in preferences &&
    (preferences.tone === "direct" || preferences.tone === "balanced" || preferences.tone === "detailed") &&
    "language" in preferences &&
    (preferences.language === "ca" || preferences.language === "es" || preferences.language === "en") &&
    "showActivity" in preferences &&
    typeof preferences.showActivity === "boolean" &&
    "options" in value &&
    isTurnOptions(value.options)
  );
}

export function buildDemoPlan(): PlanStep[] {
  return [
    { step: "Entender el objetivo", status: "completed" },
    { step: "Revisar el proyecto", status: "completed" },
    { step: "Preparar el resultado", status: "in_progress" },
  ];
}

export function buildDemoActivities(showActivity: boolean): ActivityItem[] {
  if (!showActivity) return [];
  return [
    { id: "demo-reasoning", kind: "reasoning", label: "Analizando la petición", detail: "Objetivo, contexto y límites identificados", status: "complete" },
    { id: "demo-files", kind: "file", label: "Revisando el proyecto", detail: "Se han identificado los elementos necesarios", status: "complete" },
    { id: "demo-plan", kind: "plan", label: "Plan preparado", detail: "Resultado listo para revisar", status: "complete" },
  ];
}

export function buildDemoAnswer(request: ChatRequest): string {
  const topic = request.message.length > 120 ? `${request.message.slice(0, 117)}…` : request.message;
  const context = [
    request.options.mode === "plan" ? "modo Plan" : request.options.mode === "ask" ? "modo Pregunta" : "modo Agente",
    request.options.webSearch ? "búsqueda web activa" : null,
    request.options.imageGeneration ? "imagen solicitada" : null,
    request.options.skill ? "herramienta especializada" : null,
    request.options.attachments.length ? `${request.options.attachments.length} imagen${request.options.attachments.length === 1 ? "" : "es"} adjunta${request.options.attachments.length === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");
  const detail = request.preferences.tone === "direct"
    ? "La propuesta está lista para revisar."
    : request.preferences.tone === "detailed"
      ? "He separado el objetivo, el contexto y la revisión final para que el resultado sea fácil de comprobar antes de utilizarlo."
      : "Puedes revisar el resultado y pedir cambios en esta misma conversación.";
  return [
    "## Vista previa",
    "",
    `He preparado una respuesta sintética para **“${topic}”** con ${context}.`,
    "",
    "### Resumen",
    "",
    "- Objetivo identificado.",
    "- Información organizada para revisión.",
    `- ${detail}`,
    "",
    "| Estado | Resultado |",
    "| --- | --- |",
    "| Preparación | Completada |",
    "| Revisión | Pendiente |",
  ].join("\n");
}

export function buildDemoDiff(): string {
  return [
    "diff --git a/docs/preview.md b/docs/preview.md",
    "index 40d1b21..8ac2e75 100644",
    "--- a/docs/preview.md",
    "+++ b/docs/preview.md",
    "@@ -1,3 +1,5 @@",
    " # Tall de demostració",
    " ",
    "-Estat: pendent",
    "+Estat: preparat per revisar",
    "+",
    "+La preview usa el mateix contracte de diff que el runtime Codex.",
  ].join("\n");
}
