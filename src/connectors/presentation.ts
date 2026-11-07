import type { ConnectorMention } from "./mentions-contract";
/** Presentation never grants access: callers supply the authorized resource IDs. */
const descriptions: Record<string, string> = {
  mail: "Lee, organiza, redacta y envía correos de Nominalia desde la conversación.",
  "shopify-themes": "Edita el borrador de tu web: contenido, vídeo, imágenes, diseño y opciones del configurador.",
  shopify: "Consulta pedidos y borradores de pedido de la tienda. No permite editar la web.",
  "g03-sage": "Pendiente de confirmación y de recibir la API.",
  "company-mail": "Recoge adjuntos de tu correo de empresa y consulta el registro de facturas.",
  gmail: "Busca y lee tus correos.", googlecalendar: "Consulta tus calendarios y eventos.",
  googledrive: "Busca archivos y consulta su información.", outlook: "Busca y lee tus correos de Outlook.",
  github: "Consulta repositorios públicos e incidencias.", slack: "Busca conversaciones y mensajes.",
  notion: "Busca páginas y consulta su contenido.", googlesheets: "Consulta hojas de cálculo.",
  googledocs: "Consulta documentos.", linear: "Consulta proyectos e incidencias.",
  airtable: "Consulta tus bases y registros.", hubspot: "Consulta contactos y empresas.",
  jira: "Consulta proyectos e incidencias.", youtube: "Busca vídeos y consulta sus detalles.",
};
export function connectorPresentation(id: string) {
  const slug = id.startsWith("composio-") ? id.slice(9).replaceAll("-", "_") : id;
  return {
    logoUrl: /^[a-z][a-z0-9_]{0,39}$/.test(slug) && (descriptions[slug] || slug === "supabase") ? `/connector-logos/${slug}.svg` : null,
    description: descriptions[slug] ?? "Consulta las fuentes autorizadas de esta app.",
  };
}

/** Describe internal tools by their type, without presenting them as external connections. */
export function connectorStatusLabel(mention: Pick<ConnectorMention, "id" | "status" | "requiresApprovalForWrites">) {
  if (mention.status === "connected") {
    if (mention.id === "g03-production") return "Hoja de producción";
    if (mention.id.startsWith("g03-app-")) return "Automatización";
    return mention.requiresApprovalForWrites ? "conectado · escritura con aprobación" : "conectado";
  }
  return mention.status === "requires_login" ? "Conectar" : mention.status === "admin_setup_required" ? "falta configuración administrativa" : "no disponible";
}
