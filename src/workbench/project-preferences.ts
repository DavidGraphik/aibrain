import { createHash } from "node:crypto";
import type { InstallationConfig } from "@/config/installation-schema";
import type { ResolvedPermissions } from "@/permissions";
import { FileWorkbenchStore } from "./filesystem-store";

export function requestsProjectPreferences(message: string) {
  // Only the authenticated user's own message is supplied here. Tool results,
  // attachment contents and assistant-generated notes are never intent evidence.
  const text = message
    .replace(/```[\s\S]*?```|<untrusted[^>]*>[\s\S]*?<\/untrusted[^>]*>/giu, "")
    .replace(/^\s*>.*$/gmu, "")
    .normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  // Remembering future behaviour does not require saying the word "project".
  // The server, rather than the model, fixes the destination to this project.
  // A request to reuse a procedure/template is also a behavioural preference,
  // even when the same request asks us to retain its original PDF.
  const reusableProcedure = /\b(?:proceso\w*|proces\w*|procedim\w*|procedur\w*|plantill\w*|template\w*|workflow\w*)\b/u.test(text)
    && /\b(?:futur\w*|siempre|sempre|automatiz\w*|automatitz\w*|de ahora en adelante|a partir de ahora|para todos|per a tots)\b/u.test(text);
  const describesCriteria = reusableProcedure || /\b(?:criteri\w*|preferenc\w*|reglas?|rules?|instruccion\w*|instructions?|pautas?|normas?)\b/u.test(text);
  const onlyArtifactSave = !describesCriteria
    && /\b(?:borrador\w*|draft\w*|correos?|emails?|pdfs?|archiv\w*|files?|document\w*|informes?|reports?|excels?|factur\w*)\b/u.test(text)
    && !/\b(?:(?:record\w*|recuerd\w*)\s+que|remember\s+that|ten\w*\s+en\s+cuenta\s+que|tingu\w*\s+en\s+compte\s+que)\b/u.test(text);
  // A prohibition on general/company memory does not revoke a separate request
  // to save project criteria. Remove that entire negative command, so it cannot
  // itself supply positive intent. Ambiguous or project-scoped prohibitions stay.
  const intentText = text.replace(/\b(?:no|not|don't|do not)\s+(?:\w+\s+){0,3}(?:actuali[zc]\w*|actualitz\w*|guard\w*|des[ai]\w*|record\w*|recuerd\w*|save|remember|keep|ten\w*|tingu\w*)\b[^.!?;\n]*/gu, command => {
    const outsideProjectMemory = /\b(?:memoria\s+(?:general|global|(?:compartida\s+)?(?:de\s+)?empresa)|(?:general|global|company(?:-wide)?|shared company)\s+memory)\b/u.test(command);
    return outsideProjectMemory && !/\b(?:proyect\w*|project\w*|aqui|here)\b/u.test(command) ? "" : command;
  });
  return !onlyArtifactSave && /\b(?:actuali[zc]\w*|actualitz\w*|guard\w*|des[ai]\w*|record\w*|recuerd\w*|save|remember|keep|ten\w*\s+en\s+cuenta|tingu\w*\s+en\s+compte)\b/u.test(intentText)
    && !/\b(?:no|not|don't|do not)\s+(?:\w+\s+){0,3}(?:actuali[zc]\w*|actualitz\w*|guard\w*|des[ai]\w*|record\w*|recuerd\w*|save|remember|keep|ten\w*|tingu\w*)\b/u.test(intentText)
    && !/\b(?:otro\s+proyecto|altre\s+projecte|another\s+project|other\s+project)\b/u.test(text);
}

/** Current user request and current owned project only; never model-selected IDs. */
export async function saveProjectPreferences(input: {
  config: Readonly<InstallationConfig>; userId: string; ownerUserId?: string;
  projectId: string; threadId: string; message: string; notes: string;
  expectedNotes: string; permissions: ResolvedPermissions;
}) {
  if (!requestsProjectPreferences(input.message)) throw new Error("Pide explícitamente guardar o actualizar los criterios de este proyecto.");
  const p = input.permissions;
  const rules = p.rules.filter(rule => rule.ruleId === "tools.execute" && rule.action === "execute");
  if (p.installationId !== input.config.installationId || p.userId !== input.userId || p.projectId !== input.projectId ||
      !rules.some(rule => rule.effect === "allow") || rules.some(rule => rule.effect === "deny") || input.ownerUserId !== input.userId) {
    throw new Error("No se pueden autorizar los criterios de este proyecto.");
  }
  if (typeof input.notes !== "string" || !input.notes.trim() || input.notes.length > 16000 || /\p{C}/u.test(input.notes.replace(/[\t\r\n]/g, ""))) throw new Error("Los criterios no son válidos.");
  const store = FileWorkbenchStore.fromInstallation(input.config);
  const thread = await store.getThread(input.userId, input.threadId);
  if (thread.projectId !== input.projectId) throw new Error("La conversación no pertenece a este proyecto.");
  const project = await store.updateProjectPreferences(input.userId, input.projectId, input.expectedNotes, input.notes.trim());
  return { status: "saved", projectId: project.id, updatedAt: project.memory.updatedAt,
    sha256: createHash("sha256").update(project.memory.notes).digest("hex"), notes: project.memory.notes,
    availableIn: "all conversations in this project" };
}
