import type { WorkbenchProject, WorkbenchThread } from "@/workbench/types";

export type ConversationExportFormat = "markdown" | "json";

export function conversationMarkdown(project: WorkbenchProject, thread: WorkbenchThread) {
  const lines = [
    `# ${thread.title}`,
    "",
    `Proyecto: ${project.name}`,
    `Exportado: ${new Date().toISOString()}`,
    "",
  ];
  for (const message of thread.messages) {
    lines.push(`## ${message.role === "user" ? "Tú" : "Asistente"}`, "", message.content || "_(sin texto)_", "");
    if (message.attachments.length) {
      lines.push("Adjuntos:", ...message.attachments.map((item) => `- ${item.name} (${item.mimeType})`), "");
    }
    if (message.serverReferences?.length) lines.push("Referencias Server:", ...message.serverReferences.map(item => `- ${item.name}: ${item.path}`), "");
    if (message.artifacts.length) {
      lines.push("Resultados:", ...message.artifacts.map((item) => `- ${item.name} (${item.type})`), "");
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

export function conversationJson(project: WorkbenchProject, thread: WorkbenchThread) {
  return `${JSON.stringify({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    project: { id: project.id, name: project.name },
    thread,
  }, null, 2)}\n`;
}

export function safeExportName(title: string) {
  return title.normalize("NFD").replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("es").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64) || "conversacion";
}
