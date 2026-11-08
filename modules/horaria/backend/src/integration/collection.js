import { createHash } from 'node:crypto';
import { getAll as getEmployees } from '../controllers/employees.js';
import { prisma } from '../services/prisma.js';

export const COLLECTION_DAYS = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
export const COLLECTION_VALUES = ['MANANA', 'TARDE', 'AMBOS', 'NO_DISPONIBLE', 'SIN_INDICAR'];
export const COLLECTION_HEADERS = ['ID persona', 'Persona', 'Tienda', 'Semana', 'Origen', 'Estado', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo', 'Observaciones'];
const record = v => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => record(v) && Object.keys(v).every(k => keys.includes(k));

function validateScope(week, shop) {
  if (!/^\d{4}-W\d{2}$/.test(week || '') || !Number.isSafeInteger(shop) || shop < 1) throw Object.assign(new Error('Indica una semana ISO y tienda válidas.'), { status: 400 });
  const [year, number] = week.split('-W').map(Number);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const thursday = new Date(jan4.getTime() + (3 - (jan4.getUTCDay() + 6) % 7 + (number - 1) * 7) * 86400000);
  if (year < 1900 || year > 9999 || number < 1 || number > 53 || thursday.getUTCFullYear() !== year) throw Object.assign(new Error('Semana ISO no válida.'), { status: 400 });
}

export function collectionTemplate(week, shop, employees) {
  validateScope(week, shop);
  const rows = [COLLECTION_HEADERS, ...employees.map(e => [e.id, `${e.nombre} ${e.apellidos || ''}`.trim(), shop, week, '', 'PENDIENTE', ...COLLECTION_DAYS.map(() => 'SIN_INDICAR'), ''])];
  const reply = `Disponibilidad — ${week}\n${COLLECTION_DAYS.map(d => `${d}: SIN_INDICAR`).join('\n')}\nObservaciones:\nOpciones: MANANA / TARDE / AMBOS / NO_DISPONIBLE. Indica los siete días; SIN_INDICAR queda pendiente de revisión.`;
  const formSchema = { type: 'object', additionalProperties: false, required: ['employeeId', 'week', 'days', 'notes'], properties: {
    employeeId: { type: 'integer', enum: employees.map(e => e.id) }, week: { const: week },
    days: { type: 'object', additionalProperties: false, required: COLLECTION_DAYS, properties: Object.fromEntries(COLLECTION_DAYS.map(d => [d, { type: 'string', enum: COLLECTION_VALUES }])) },
    notes: { type: 'string', maxLength: 2000 },
  } };
  return collectionPreview(week, shop, rows, { reply, formSchema, responseFormat: { establecimientoId: shop, semana: week, responses: 'One object per person: employeeId, week, days, notes, source=FORMULARIO. Submit to collection.preview for review and Excel; never apply automatically.' }, sent: false, saved: false });
}

function collectionPreview(week, shop, rows, extra = {}) {
  return { artifactPurpose: 'collection', title: `Recogida de disponibilidad · ${week}`, semana: week, establecimientoId: shop, status: 'esborrany', rows,
    previewHash: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    note: 'Recogida de datos, no horario. SIN_INDICAR no equivale a disponibilidad. Revisar identidad, semana y peticiones antes de aplicarlas. No se ha enviado ni guardado ningún cambio.', ...extra };
}

export function collectionResponsePreview(week, shop, employees, responses) {
  validateScope(week, shop);
  if (!Array.isArray(responses) || responses.length > employees.length) throw Object.assign(new Error('Respuestas no válidas.'), { status: 400 });
  const seen = new Set();
  for (const r of responses) {
    if (!exact(r, ['employeeId', 'week', 'days', 'notes', 'source']) || !employees.some(e => e.id === r.employeeId) || seen.has(r.employeeId) || r.week !== week ||
        !exact(r.days, COLLECTION_DAYS) || !COLLECTION_DAYS.every(d => COLLECTION_VALUES.includes(r.days[d])) ||
        !['WHATSAPP', 'FORMULARIO'].includes(r.source) || typeof r.notes !== 'string' || r.notes.length > 2000) throw Object.assign(new Error('Respuesta incompleta, duplicada o ajena a la tienda/semana.'), { status: 400 });
    seen.add(r.employeeId);
  }
  const rows = [COLLECTION_HEADERS, ...employees.map(e => {
    const r = responses.find(r => r.employeeId === e.id);
    return [e.id, `${e.nombre} ${e.apellidos || ''}`.trim(), shop, week, r?.source || '',
      !r ? 'PENDIENTE' : COLLECTION_DAYS.some(d => r.days[d] === 'SIN_INDICAR') ? 'INCOMPLETA' : 'POR_REVISAR',
      ...COLLECTION_DAYS.map(d => r?.days[d] || 'SIN_INDICAR'), r?.notes || ''];
  })];
  return collectionPreview(week, shop, rows, { sent: false, saved: false, verifiedIdentity: false });
}

async function capture(handler, req) {
  let status = 200, result;
  await handler(req, { status(code) { status = code; return this; }, json(value) { result = value; return this; } });
  if (status !== 200 || !Array.isArray(result)) throw Object.assign(new Error('No se ha podido leer la recogida autorizada.'), { status });
  return result;
}
export async function collectionTemplateHandler(req, res) {
  validateScope(req.query.semana, Number(req.query.establecimiento));
  return res.json(collectionTemplate(req.query.semana, Number(req.query.establecimiento), await capture(getEmployees, req)));
}
export async function collectionResponseHandler(req, res) {
  if (!exact(req.body, ['establecimientoId', 'semana', 'responses'])) return res.status(400).json({ error: 'Datos de recogida no válidos.' });
  const { establecimientoId, semana, responses } = req.body;
  validateScope(semana, establecimientoId);
  const scoped = { ...req, query: { establecimiento: String(establecimientoId), semana } };
  const employees = await capture(getEmployees, scoped);
  return res.json(collectionResponsePreview(semana, establecimientoId, employees, responses));
}
export async function collectionExportHandler(req, res) {
  const week = req.query.semana, shop = Number(req.query.establecimiento);
  validateScope(week, shop);
  const employees = await capture(getEmployees, req);
  const preferences = await prisma.shiftPreference.findMany({ where: { semana: week, activa: true, empleadoId: { in: employees.map(e => e.id) } }, orderBy: { updatedAt: 'desc' } });
  const rows = [COLLECTION_HEADERS, ...employees.map(e => {
    const p = preferences.find(p => p.empleadoId === e.id);
    return [e.id, `${e.nombre} ${e.apellidos || ''}`.trim(), shop, week, p?.recogidoVia || '', p ? 'RECIBIDA_POR_REVISAR' : 'PENDIENTE',
      ...COLLECTION_DAYS.map(d => !p ? 'SIN_INDICAR' : p.diasNoDisponible.includes(d) ? 'NO_DISPONIBLE' : (p.turnosPorDia?.[d] || 'SIN_INDICAR')),
      p?.notasAdicionales || ''];
  })];
  return res.json(collectionPreview(week, shop, rows, { saved: false, sent: false }));
}
