import { createHash } from 'node:crypto';
import { jsPDF } from 'jspdf';
import { getSchedules, checkEstablishmentConflicts, publishSchedule, hasRunningGeneration } from '../controllers/schedules.js';
import { getAll as getEmployees } from '../controllers/employees.js';
import { prisma } from '../services/prisma.js';
import { shiftHours, entradaPara, salidaPara, descansoPara } from '../utils/shiftHours.js';
import { requireDelivery } from './providers.js';
import { excelSchedule } from './excel-schedule.js';

const DAYS = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
const LABELS = { MANANA: 'Mañana', TARDE: 'Tarde', PARTIDO: 'Partido', LIBRE: 'Libre' };
async function capture(handler, req) {
  let code = 200, value;
  await handler(req, { status(n) { code = n; return this; }, json(data) { value = data; return this; } });
  if (code !== 200) throw Object.assign(new Error('No se ha podido leer la semana.'), { status: code });
  return value;
}
export function scheduleRows(schedules, establishment, roster = []) {
  const people = new Map(roster.map(employee => [employee.id, { employee, days: new Map(), hours: 0 }]));
  for (const shift of schedules) {
    if (!people.has(shift.empleadoId)) people.set(shift.empleadoId, { employee: shift.empleado, days: new Map(), hours: 0 });
    const person = people.get(shift.empleadoId);
    const start = shift.horaEntrada || entradaPara(shift.empleado, shift.turno);
    const end = salidaPara(shift.empleado, shift.turno, establishment, start);
    const label = shift.ausencia === 'VACACIONES' ? 'Vacaciones' : shift.ausencia === 'BAJA_MEDICA' ? 'Baja' : LABELS[shift.turno] || shift.turno;
    const cell = `${label}${start && shift.turno !== 'LIBRE' ? ` ${start}${end ? `–${end}` : ''}` : ''}${shift.turno === 'PARTIDO' ? ` · pausa ${shift.horaDescanso || descansoPara(shift.turno, establishment)}` : ''}${shift.peticio ? ' *' : ''}`;
    person.days.set(shift.dia, [...(person.days.get(shift.dia) || []), cell]);
    person.hours += shiftHours(shift.empleado, shift.turno);
  }
  return [['Persona', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom', 'Horas'], ...[...people.values()].sort((a, b) => a.employee.nombre.localeCompare(b.employee.nombre)).map(p => [
    `${p.employee.nombre} ${p.employee.apellidos || ''}`.trim(), ...DAYS.map(day => p.days.get(day)?.join(' / ') || 'Sin asignar'), p.hours,
  ])];
}
export async function weekPreview(req) {
  const { semana, establecimiento } = req.query;
  if (!/^\d{4}-W\d{2}$/.test(semana || '') || !/^[1-9]\d*$/.test(String(establecimiento || ''))) throw Object.assign(new Error('Indica semana y tienda.'), { status: 400 });
  const schedules = await capture(getSchedules, req);
  const establishment = await prisma.establishment.findUnique({ where: { id: Number(establecimiento) } });
  if (!establishment) throw Object.assign(new Error('Tienda no disponible.'), { status: 404 });
  const conflicts = await capture(checkEstablishmentConflicts, req);
  const roster = await capture(getEmployees, req);
  const rows = scheduleRows(schedules, establishment, roster);
  const excel = excelSchedule(schedules, establishment, roster, semana);
  const title = `${establishment.nombre} · ${semana}`;
  const previewHash = createHash('sha256').update(JSON.stringify({ rows, excel, conflicts, schedules: [...schedules].sort((a, b) => a.id - b.id) })).digest('hex');
  return { title, semana, establecimientoId: establishment.id, shiftCount: schedules.length, status: schedules.length && schedules.every(s => s.publicado) ? 'publicat' : 'esborrany', rows, excelSchedule: excel, excelCalculationWarnings: ['El modelo Excel original conserva referencias rotas preexistentes. No equivale a una validación de sus cálculos.', 'No se han importado los saldos históricos de personal, acuerdos mensuales y vacaciones. Los ceros de los auxiliares vacíos no son saldos verificados.'], conflicts, previewHash, note: '* Petición de la persona. Sin asignar no equivale a día libre.', generatedAt: new Date().toISOString() };
}
export function previewPdf(preview) {
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  pdf.setFontSize(15); pdf.text(preview.title.replace('·', '-'), 12, 15);
  pdf.setFontSize(9); pdf.text(`${preview.status === 'publicat' ? 'Publicado' : 'Borrador'} - ${preview.note}`, 12, 23);
  const widths = [46, 30, 30, 30, 30, 30, 30, 30, 17];
  const scale = 273 / widths.reduce((a, b) => a + b, 0);
  let y = 30;
  for (const [index, row] of preview.rows.entries()) {
    const lines = row.map((cell, col) => pdf.splitTextToSize(String(cell).replaceAll('–', '-'), widths[col] * scale - 3));
    const height = Math.max(10, ...lines.map(l => l.length * 4 + 4));
    if (y + height > 194) { pdf.addPage(); y = 15; }
    pdf.setFillColor(index === 0 ? 230 : index % 2 ? 249 : 255); pdf.rect(12, y, 273, height, 'F');
    let x = 12;
    lines.forEach((line, col) => { pdf.text(line, x + 1.5, y + 4); x += widths[col] * scale; });
    y += height;
  }
  return Buffer.from(pdf.output('arraybuffer'));
}
export async function previewHandler(req, res) { res.json(await weekPreview(req)); }
export async function publishHandler(req, res) {
  requireDelivery();
  if (hasRunningGeneration(Number(req.body.establecimientoId), req.body.semana)) return res.status(409).json({ error: "Espera a que termine la generación antes de publicar." });
  const preview = await weekPreview({ ...req, query: { semana: req.body.semana, establecimiento: String(req.body.establecimientoId) } });
  if (!preview.shiftCount || preview.previewHash !== req.body.previewHash) return res.status(409).json({ error: 'El horario ha cambiado o está vacío. Revisa una nueva vista previa antes de publicar.' });
  req.file = { buffer: previewPdf({ ...preview, status: 'publicat' }) };
  return publishSchedule(req, res);
}
