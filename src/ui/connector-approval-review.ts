type ReviewField = { label: string; value: string; translateValue?: boolean };
const actions: Record<string, string> = {
  create_draft: "Guardar borrador de correo", create_offer: "Crear oferta", update_offer: "Actualizar oferta",
  attach_offer_pdf: "Adjuntar PDF a oferta", convert_offer_to_order: "Convertir oferta en pedido",
  record_order_delivery: "Registrar entrega parcial (ANL)", update_order: "Modificar pedido",
  update_order_status: "Cambiar estado de pedido", create_customer: "Crear cliente",
  create_purchase_invoice: "Crear factura de compra", update_purchase_invoice_status: "Cambiar estado de factura",
  create_company: "Crear empresa", update_company: "Actualizar empresa", update_person: "Actualizar contacto",
  create_note: "Añadir nota", create_task: "Crear tarea", update_task: "Actualizar tarea", delete_task: "Eliminar tarea",
  create_deal: "Crear oportunidad", update_deal: "Actualizar oportunidad",
};
const labels: Record<string, string> = {
  offerId: "Oferta", orderId: "Pedido", customer_id: "Cliente", provider_id: "Proveedor",
  description: "Descripción", remarks: "Observaciones", valid_from: "Válida desde",
  valid_until: "Válida hasta", subject: "Asunto", toRecipients: "Destinatarios",
  ccRecipients: "Cc", bccRecipients: "Bcc", contentType: "Formato", content: "Cuerpo completo",
  attachments: "Adjuntos", filename: "Nombre del archivo", lines: "Líneas",
};
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

// Display the frozen request itself, without the activity redactor or length
// cap. Redacting identifiers, Markdown or long mail bodies changes what the
// employee sees compared with the action they authorize. React renders text,
// including HTML mail bodies, without executing it.
export function connectorApprovalReview(detail: string): ReviewField[] | null {
  let preview: unknown;
  try { preview = JSON.parse(detail); } catch { return null; }
  if (!record(preview) || !["mail_draft", "sibema_action", "attio_action"].includes(String(preview.operation)) ||
      !record(preview.input) || !record(preview.input.request)) return null;
  const fields: ReviewField[] = [];
  if (typeof preview.input.type === "string") fields.push({ label: "Acción", value: Object.hasOwn(actions, preview.input.type) ? actions[preview.input.type]! : preview.input.type, translateValue: true });
  if (record(preview.prepared) && record(preview.prepared.action) && typeof preview.prepared.action.mailbox === "string")
    fields.push({ label: "Buzón", value: preview.prepared.action.mailbox });
  const visit = (value: Record<string, unknown>, prefix = "") => {
    for (const [key, item] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (record(item) && Object.keys(item).length) visit(item, path);
      else fields.push({ label: Object.hasOwn(labels, key) ? labels[key]! : path, value: typeof item === "string" ? item : JSON.stringify(item, null, 2) });
    }
  };
  const preparedAction=record(preview.prepared)&&record(preview.prepared.action)?preview.prepared.action:null;
  // Composing an email adds the verified signature and original attachments.
  // The broker's frozen provider request is what will actually be saved.
  visit(preparedAction&&record(preparedAction.request)?preparedAction.request:preview.input.request);
  return fields;
}
