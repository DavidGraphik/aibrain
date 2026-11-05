import { createHash } from 'node:crypto';
import { prisma } from '../services/prisma.js';
import { loadState, saveState } from './durable-state.js';
import { inspectWorkbook, compareReviewedWorkbook } from './reviewed-workbook.js';
import { requireDelivery } from './providers.js';
import { readMetaTemplates, requireApprovedTemplate } from './meta-templates.js';
import { weekLabel } from '../utils/isoWeek.js';

const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const hash = value => createHash('sha256').update(value).digest('hex');
function check(ok, message, status = 400) { if (!ok) throw Object.assign(new Error(message), { status }); }
const publicError = handler => async (req, res) => {
  try { return await handler(req, res); }
  catch (error) { return res.status([400, 403, 404, 409].includes(error.status) ? error.status : 500).json({ error: error.status ? error.message : 'No s’ha pogut completar el repartiment de l’Excel. Consulta’n l’estat abans de repetir.' }); }
};

export async function sendReviewedExcel(phone, buffer, filename) {
  return sendReviewedDocument(phone, buffer, filename, MIME);
}

export async function reviewedPdfTemplate() {
  const [name, language = process.env.WHATSAPP_TEMPLATE_LANG || 'es', extra] = (process.env.WHATSAPP_TEMPLATE_HORARIO || '').split(':');
  check(name && /^[a-z0-9_]+$/.test(name) && /^[a-z]{2}(?:_[A-Z]{2})?$/.test(language) && extra === undefined, 'Falta configurar la plantilla aprovada de PDF.', 409);
  requireApprovedTemplate(await readMetaTemplates(), name, language, [3], true);
  return { name, language };
}

export async function sendReviewedPdf(phone, buffer, filename, template) {
  return sendReviewedDocument(phone, buffer, filename, 'application/pdf', template);
}

async function sendReviewedDocument(phone, buffer, filename, mime, template) {
  requireDelivery();
  check((process.env.WHATSAPP_PROVIDER || 'meta') === 'meta', 'Aquest repartiment necessita el proveïdor Meta.');
  const base = `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_ID}`;
  const headers = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
  const form = new FormData(); form.set('messaging_product', 'whatsapp'); form.set('type', mime);
  form.set('file', new Blob([buffer], { type: mime }), filename);
  const uploaded = await fetch(`${base}/media`, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(60000) });
  if (!uploaded.ok) throw new Error(`Meta media status ${uploaded.status}`);
  const media = await uploaded.json();
  if (typeof media.id !== 'string' || !/^\d+$/.test(media.id)) throw new Error('Meta media receipt missing');
  const content = template ? { type: 'template', template: {
    name: template.name, language: { code: template.language }, components: [
      { type: 'header', parameters: [{ type: 'document', document: { id: media.id, filename } }] },
      { type: 'body', parameters: template.bodyParameters.map(text => ({ type: 'text', text })) },
    ],
  } } : { type: 'document', document: { id: media.id, filename, caption: 'Horari revisat: s’adjunta exactament la versió confirmada.' } };
  const sent = await fetch(`${base}/messages`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, ...content }), signal: AbortSignal.timeout(60000) });
  if (!sent.ok) throw new Error(`Meta message status ${sent.status}`);
  const result = await sent.json();
  if (typeof result.messages?.[0]?.id !== 'string') throw new Error('Meta message receipt missing');
  return { providerMessageId: result.messages[0].id, providerMediaId: media.id };
}

export function createReviewedScheduleHandlers({ database = prisma, load = loadState, save = saveState, send = sendReviewedExcel, sendPdf = sendReviewedPdf, pdfTemplate = reviewedPdfTemplate,
  preflight = () => { requireDelivery(); check((process.env.WHATSAPP_PROVIDER || 'meta') === 'meta', 'Aquest repartiment necessita el proveïdor Meta.'); }, now = () => new Date() } = {}) {
  const context = req => {
    const id = Number(req.body.establecimientoId ?? req.query.establecimiento);
    check(Number.isSafeInteger(id) && id > 0, 'Cal indicar una botiga concreta.');
    return { establishmentId: id, actorId: req.horariaClaims.actorId, installationId: req.horariaClaims.installationId };
  };
  const read = (req, kind, id) => {
    check(typeof id === 'string' && /^[a-f0-9]{64}$/.test(id), 'Identificador de versió no vàlid.');
    const record = load(`${kind}-${id}.json`), ctx = context(req);
    check(record && record.actorId === ctx.actorId && record.installationId === ctx.installationId && record.establishmentId === ctx.establishmentId, 'Versió no disponible per a aquest usuari i botiga.', 404);
    return record;
  };
  const upload = (req, withPdf = false) => {
    const files = req.horariaUploads || [], file = files.find(f => f.fieldname === 'workbook');
    check(files.length === (withPdf ? 2 : 1) && file?.mimetype === MIME && file.size > 0 && file.size <= 10 * 1024 * 1024 && file.size === file.buffer.length && /^[^/\\\x00-\x1f]{1,115}\.xlsx$/i.test(file.originalname), 'Adjunta un únic Excel .xlsx de la botiga.');
    return file;
  };
  const pdfUpload = (req, workbookHash) => {
    const file = req.horariaUploads.find(f => f.fieldname === 'reviewedPdf');
    check(file?.mimetype === 'application/pdf' && file.size > 0 && file.size <= 4 * 1024 * 1024 && file.size === file.buffer.length && file.buffer.subarray(0, 5).toString() === '%PDF-', 'Falta el PDF generat pel servidor.');
    check(req.body.pdfSourceSha256 === workbookHash && req.body.pdfSha256 === hash(file.buffer) && req.body.pdfPages === '1', 'El PDF no correspon al rebut de conversió de l’Excel corregit.');
    return { bytes: file.buffer.toString('base64'), sha256: req.body.pdfSha256, sourceSha256: workbookHash, pages: 1 };
  };
  const receipt = record => ({ reviewId: record.id, sourceId: record.sourceId, establecimientoId: record.establishmentId, semana: record.week,
    sha256: record.sha256, filename: record.filename, originalFilename: record.originalFilename, size: Buffer.from(record.bytes, 'base64').length,
    changes: record.changes, status: record.status, recipient: record.recipient, previewHash: record.previewHash,
    result: record.result || null, deliveryBlocker: record.deliveryBlocker || null, artifactPurpose: 'reviewed-excel', originalPreserved: true, regenerated: false,
    deliveryFormat: record.deliveryFormat || 'xlsx',
    pdf: record.pdf ? { sha256: record.pdf.sha256, sourceSha256: record.pdf.sourceSha256, filename: record.pdf.filename, pages: record.pdf.pages } : null,
    template: record.template ? { name: record.template.name, language: record.template.language } : null });
  async function destination(req, establishmentId, requestedEmployeeId) {
    const shop = await database.establishment.findUnique({ where: { id: establishmentId }, select: { id: true, nombre: true, activo: true, managerLocalId: true } });
    check(shop?.activo, 'La botiga no està activa.');
    if (requestedEmployeeId !== undefined) check(req.user.rol === 'MANAGER_GENERAL' && Number.isSafeInteger(requestedEmployeeId) && requestedEmployeeId > 0, 'Només una responsable general pot designar un destinatari concret.', 403);
    const id = requestedEmployeeId ?? shop.managerLocalId;
    check(id, 'Falta configurar la responsable de la botiga.');
    const person = await database.employee.findFirst({ where: { id, activo: true, OR: [{ establecimientoId: establishmentId }, { establecimientosPermitidos: { some: { establishmentId } } }, ...(id === shop.managerLocalId ? [{ id: shop.managerLocalId }] : [])] }, select: { id: true, nombre: true, apellidos: true, telefonoWhatsapp: true } });
    check(person?.telefonoWhatsapp && /^\+?[1-9]\d{7,14}$/.test(person.telefonoWhatsapp), 'El destinatari no està actiu, no pertany a aquesta botiga o no té telèfon vàlid.');
    const inbound = await database.whatsappMessage.findFirst({ where: { direccion: 'entrante', conversacion: { telefono: person.telefonoWhatsapp } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const lastInbound = inbound ? new Date(inbound.createdAt).getTime() : NaN;
    const age = now().getTime() - lastInbound;
    return { phone: person.telefonoWhatsapp, phoneHash: hash(person.telefonoWhatsapp), id: person.id,
      name: `${person.nombre} ${person.apellidos || ''}`.trim(), establishmentName: shop.nombre, phoneSuffix: person.telefonoWhatsapp.slice(-3),
      windowOpen: age >= 0 && age < 24 * 60 * 60 * 1000, lastInboundAt: inbound?.createdAt || null };
  }
  const binding = (record, recipient) => hash(JSON.stringify([record.id, record.sha256, record.establishmentId, record.week, recipient.id, recipient.phoneHash,
    ...(record.deliveryFormat === 'pdf' ? ['pdf', record.pdf.sha256, record.template, recipient.name, recipient.establishmentName] : [])]));
  const publicRecipient = ({ phone: _phone, phoneHash: _hash, ...recipient }) => recipient;
  return {
    // Private bridge entry point, called only after the server generated and verified the original artifact.
    source: publicError(async (req, res) => {
      const ctx = context(req), file = upload(req), week = req.body.semana;
      check(/^\d{4}-W\d{2}$/.test(week || '') && req.body.sha256 === hash(file.buffer), 'No coincideix el rebut del fitxer original.');
      const workbook = inspectWorkbook(file.buffer);
      const shop = await database.establishment.findUnique({ where: { id: ctx.establishmentId }, select: { nombre: true, activo: true } });
      const cells = workbook.grid[0].cells;
      check(shop?.activo && cells.get('G4')?.value === shop.nombre && cells.get('O4')?.value === week.slice(0, 4) && Number(cells.get('D4')?.value) === Number(week.slice(6)), 'L’Excel original no correspon a la botiga i setmana.');
      const id = hash(JSON.stringify([ctx, week, req.body.sha256]));
      if (!load(`review-source-${id}.json`)) save(`review-source-${id}.json`, { ...ctx, id, week, sha256: req.body.sha256, filename: file.originalname, bytes: file.buffer.toString('base64'), createdAt: now().toISOString() });
      return res.json({ sourceId: id, sha256: req.body.sha256, semana: week, establecimientoId: ctx.establishmentId });
    }),
    review: publicError(async (req, res) => {
      const format = req.body.deliveryFormat || 'xlsx';
      check(['pdf', 'xlsx'].includes(format), 'Format de repartiment no vàlid.');
      const source = read(req, 'review-source', req.body.sourceId), file = upload(req, format === 'pdf');
      const comparison = compareReviewedWorkbook(Buffer.from(source.bytes, 'base64'), file.buffer);
      const sha256 = hash(file.buffer), id = hash(JSON.stringify([source.id, sha256, ...(format === 'pdf' ? ['pdf'] : [])]));
      const converted = format === 'pdf' ? pdfUpload(req, sha256) : null;
      const previous = load(`reviewed-${id}.json`);
      if (previous && previous.status !== 'reviewed') return res.json(receipt(previous));
      const requestedEmployeeId = req.body.recipientEmployeeId === undefined ? undefined : Number(req.body.recipientEmployeeId);
      let recipient = null, deliveryBlocker = null;
      try { recipient = await destination(req, source.establishmentId, requestedEmployeeId); }
      catch (error) { if (error.status !== 400) throw error; deliveryBlocker = error.message; }
      if (format === 'xlsx' && recipient && !recipient.windowOpen) deliveryBlocker = 'RECIPIENT_MUST_REPLY_FIRST';
      let template = null;
      if (format === 'pdf') {
        try { template = await pdfTemplate(); }
        catch { deliveryBlocker = 'PDF_TEMPLATE_NOT_APPROVED_OR_UNAVAILABLE'; }
      }
      const record = { ...context(req), id, sourceId: source.id, week: source.week, sha256,
        bytes: file.buffer.toString('base64'), filename: `horari-${source.establishmentId}-${source.week}-${sha256.slice(0, 12)}.xlsx`, originalFilename: file.originalname,
        changes: comparison.changes, status: 'reviewed', requestedEmployeeId, recipient: recipient ? publicRecipient(recipient) : null, deliveryBlocker, createdAt: now().toISOString(),
        deliveryFormat: format, template,
        pdf: converted ? previous?.pdf || { ...converted, filename: `horari-${source.establishmentId}-${source.week}-${sha256.slice(0, 12)}.pdf` } : null };
      record.previewHash = recipient ? binding(record, recipient) : null;
      save(`reviewed-${id}.json`, record);
      return res.json({ ...receipt(record),
        note: format === 'pdf' ? 'Es conserva l’Excel corregit exacte i el PDF de la seva impressió original. Revisa canvis, PDF i destinatari abans de confirmar. S’enviarà amb la plantilla aprovada, sense necessitat d’una resposta recent. No s’han modificat els horaris desats.' : 'Es conserva el fitxer corregit exacte. Revisa els canvis i el destinatari abans de confirmar el repartiment. No s’han modificat els horaris desats.' });
    }),
    status: publicError(async (req, res) => res.json(receipt(read(req, 'reviewed', req.params.id)))),
    send: publicError(async (req, res) => {
      const record = read(req, 'reviewed', req.body.reviewId);
      check(record.previewHash && record.recipient, 'Falta un destinatari revisat. Completa la configuració i revisa de nou aquest mateix Excel.', 409);
      check(req.body.sha256 === record.sha256 && req.body.previewHash === record.previewHash, 'La versió o el destinatari no coincideixen amb la revisió.', 409);
      if (record.status === 'accepted') return res.json(receipt(record));
      check(record.status === 'reviewed', 'El resultat anterior és incert. Cal comprovar-lo amb Meta abans de repetir; no s’ha reenviat.', 409);
      const recipient = await destination(req, record.establishmentId, record.requestedEmployeeId);
      check(binding(record, recipient) === record.previewHash, 'El destinatari ha canviat. Revisa de nou el repartiment.', 409);
      const isPdf = record.deliveryFormat === 'pdf';
      if (!isPdf) check(recipient.windowOpen, 'El destinatari ha de respondre al WhatsApp abans de rebre l’Excel. La plantilla PDF no envia aquest format.', 409);
      const bytes = Buffer.from(record.bytes, 'base64'); check(hash(bytes) === record.sha256, 'La versió desada no supera la comprovació d’integritat.', 409);
      const deliveryBytes = isPdf ? Buffer.from(record.pdf.bytes, 'base64') : bytes;
      if (isPdf) check(hash(deliveryBytes) === record.pdf.sha256 && record.pdf.sourceSha256 === record.sha256, 'El PDF desat no supera la comprovació d’integritat.', 409);
      try {
        await preflight();
        if (isPdf) check(record.template && JSON.stringify(await pdfTemplate()) === JSON.stringify(record.template), 'La plantilla ha canviat. Revisa de nou el repartiment.', 409);
      } catch (error) { throw Object.assign(error, { status: 409 }); }
      record.status = 'sending'; save(`reviewed-${record.id}.json`, record);
      try {
        const result = isPdf ? await sendPdf(recipient.phone, deliveryBytes, record.pdf.filename, { ...record.template, bodyParameters: [recipient.name, recipient.establishmentName, weekLabel(record.week)] }) : await send(recipient.phone, bytes, record.filename);
        record.status = 'accepted'; record.result = { ...result, acceptedAt: now().toISOString(), deliveryConfirmed: false, sha256: hash(deliveryBytes), workbookSha256: record.sha256, deliveryFormat: isPdf ? 'pdf' : 'xlsx', ...(isPdf ? { template: record.template } : {}) };
        save(`reviewed-${record.id}.json`, record);
      } catch {
        record.status = 'uncertain'; save(`reviewed-${record.id}.json`, record);
        return res.status(409).json({ ...receipt(record), error: 'L’enviament no té un resultat confirmat. No es repetirà automàticament; cal comprovar-lo amb Meta.' });
      }
      return res.json(receipt(record));
    }),
  };
}
