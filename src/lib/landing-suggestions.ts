import { spanishUiText, type UiText } from "@/i18n/messages";
import { type WorkbenchProject } from "@/workbench/types";

export type LandingSuggestion = {
  id: "presentation" | "spreadsheets" | "schedule" | "presentation-image" | "illustration" | "diagram" | "store-performance" | "meta-review" | "shopify-review" | "trinalum-crm" | "trinalum-erp" | "trinalum-documents" | "outreach-campaigns" | "outreach-leads" | "outreach-attention" | "document-summary" | "compare-options" | "next-steps" | "automation" | "production" | "quality" | "administration";
  label: string;
  prompt: string;
  iconPath?: string;
  action?: "create-automation";
  children?: { id: string; label: string; prompt: string; disabledReason?: string }[];
};

/** Installation identity selects business templates; display names never select another client’s tasks. */
export function landingSuggestions(
  _project: WorkbenchProject | null,
  companyName: string,
  capabilities: { gmailAuthorized?: boolean; imageGeneration?: boolean; installationId?: string } = {},
  t: UiText = spanishUiText,
): LandingSuggestion[] {
  if (capabilities.imageGeneration) return [
    { id: "presentation-image", label: t("Para una presentación"), prompt: t("Crea una imagen horizontal para una presentación sobre…") },
    { id: "illustration", label: t("Ilustrar una idea"), prompt: t("Crea una ilustración que represente…") },
    { id: "diagram", label: t("Explicar un proceso"), prompt: t("Crea un diagrama visual que explique estos pasos: …") },
  ];
  // Department labels are not an actor permission matrix. G03 uses the neutral
  // prompts below; its authorized apps remain available through normal navigation.
  if (capabilities.installationId === "modtime") return [
    { id: "store-performance", label: "How is my store performing?", prompt: "Review MODTIME’s store performance for the last seven complete days using authorized Shopify and Meta reads. State each source’s exact dates, timezone, currency and completeness. Shopify periods are UTC and Meta periods follow the ad account timezone; do not claim a reconciled comparison when boundaries differ. Separate order totals, receipts, net payments and merchandise revenue. Identify missing connections or data; never invent sales, profit, new-customer CAC or reconciled ROAS. Read-only analysis: do not change campaigns, budgets, orders or store content." },
    { id: "meta-review", label: "Let’s review my Meta ads.", prompt: "Review MODTIME’s Meta ads for the last seven complete days in the ad account timezone using the authorized Meta connector. Show the exact dates, source, currency, spend and available delivery/conversion metrics, preserving missing values. Explain that platform-attributed purchases and ROAS are not verified store sales or reconciled merchandise ROAS. Identify any missing connection or incomplete data. Suggest priorities for review without changing campaigns, ads or budgets." },
    { id: "shopify-review", label: "Let’s review my Shopify orders.", prompt: "Review MODTIME’s Shopify orders and drafts for the last seven complete UTC days, within the connector’s 60-day access window. Use authorized Shopify reads and report exact dates, currency, pagination completeness, test-order exclusions and cancelled, unpaid and refunded-order caveats. Separate order totals, receipts and net payments; do not infer profit, new-customer history or reconciled ROAS. Report missing consent, permissions or data honestly. Provide aggregates without customer PII and do not create or change orders, drafts or store content." },
  ];
  if (capabilities.installationId === "insijets-demo") return [
    { id: "outreach-campaigns", label: t("¿Qué campañas tenemos en marcha?"), prompt: t("¿Qué campañas tenemos en marcha?") },
    { id: "outreach-leads", label: t("Preparar más leads cualificados"), prompt: t("Prepara 1000 leads cualificados más con la distribución de ICP acordada. Propón primero el plan y el coste estimado; no busques contactos, gastes, subas datos ni envíes sin la aprobación necesaria.") },
    { id: "outreach-attention", label: t("¿Qué necesita mi atención?"), prompt: t("¿Qué necesita mi atención en outreach hoy?") },
  ];
  if (capabilities.installationId === "trinalum-production") return [
    { id: "trinalum-crm", label: t("Consultar Attio"), prompt: t("Consulta Attio y muéstrame las tareas abiertas, responsables y próximos pasos. Solo lectura.") },
    { id: "trinalum-erp", label: t("Consultar Sibema"), prompt: t("Quiero consultar un cliente, una oferta o un pedido en Sibema. Pídeme el nombre o la referencia antes de buscar.") },
    { id: "trinalum-documents", label: t("Trabajar con un documento"), prompt: t("Voy a subir un documento. Resume sus datos y dime qué falta; no cambies ningún sistema sin mostrarme antes la acción.") },
  ];
  if (capabilities.installationId === "arnall" || capabilities.installationId === "company-qa") return scheduledPromptTemplates(companyName, t);
  return [
    { id: "document-summary", label: t("Resumir documentos"), prompt: t("Ayúdame a resumir estos documentos para {company}: … Usa solo el material aportado o autorizado, cita las fuentes y destaca decisiones, dudas y datos que faltan.", { company: companyName }) },
    { id: "compare-options", label: t("Comparar opciones"), prompt: t("Comparemos estas opciones para {company}: … Organiza criterios, ventajas, costes conocidos y dudas con los datos disponibles. Indica qué falta para decidir sin inventar cifras ni compromisos.", { company: companyName }) },
    { id: "next-steps", label: t("Organizar los próximos pasos"), prompt: t("Ayúdame a organizar los próximos pasos de este trabajo de {company}: … A partir de la información aportada, resume pendientes, dependencias y preguntas. Propón responsables y fechas para revisar, sin crear tareas programadas ni enviar mensajes.", { company: companyName }) },
  ];
}

/** Fixed editable prompts, never scheduled jobs or automatic actions. */
export function scheduledPromptTemplates(companyName: string, t: UiText = spanishUiText): LandingSuggestion[] {
  return [
    { id: "presentation", iconPath: "/branding/microsoft/powerpoint.svg", label: t("Prepárame una presentación"), prompt: t("Prepárame una presentación sobre…") },
    { id: "spreadsheets", iconPath: "/branding/microsoft/excel.svg", label: t("Trabajemos con estos Excels"), prompt: t("Trabajemos con estos Excels. Quiero…") },
    { id: "schedule", iconPath: companyName.trim().toLocaleLowerCase() === "arnall" ? "/branding/arnall/logo.jpg?v=d09bb6bb7e8a" : undefined, label: t("Trabajemos en los horarios del equipo de {company}", { company: companyName }), prompt: "", children: [
      { id: "whatsapp", label: t("Enviar los WhatsApps a los trabajadores"), prompt: t("Preparemos los WhatsApps con los horarios para los trabajadores de {company}. Quiero revisar los destinatarios y los mensajes antes de enviarlos.", { company: companyName }) },
      { id: "prepared", label: t("Dame los horarios preparados"), prompt: t("Dame los horarios preparados del equipo de {company} para…", { company: companyName }) },
      { id: "changes", label: t("Revisar cambios de horarios"), prompt: t("Revisemos los cambios de horarios del equipo de {company} para…", { company: companyName }) },
    ] },
  ];
}
