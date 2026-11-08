import { createHash } from 'node:crypto';
import { generateAISchedule } from '../services/aiScheduler.js';
import { scheduleRows } from './preview.js';
import { excelSchedule } from './excel-schedule.js';
import { validateDraftCoverage } from '../services/draft-scenario.js';

export async function draftHandler(req, res) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['establecimientoId', 'semana', 'quality', 'requests', 'coverage'].includes(k)) ||
      !Number.isSafeInteger(body.establecimientoId) || body.establecimientoId < 1 ||
      !/^\d{4}-W\d{2}$/.test(body.semana || '') || !['standard', 'high', undefined].includes(body.quality)) {
    return res.status(400).json({ error: 'Indica una tienda, semana y peticiones válidas.' });
  }
  try { validateDraftCoverage(body.coverage); } catch (error) { return res.status(400).json({ error: error.message }); }
  const [year, week] = body.semana.split('-W').map(Number);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const thursday = new Date(jan4.getTime() + (3 - (jan4.getUTCDay() + 6) % 7 + (week - 1) * 7) * 86400000);
  if (year < 1900 || year > 9999 || week < 1 || week > 53 || thursday.getUTCFullYear() !== year) return res.status(400).json({ error: 'Semana ISO no válida.' });
  const result = await generateAISchedule({ ...body, draftOnly: true });
  const { schedules, establishment, roster, review } = result;
  const excel = excelSchedule(schedules, establishment, roster, body.semana);
  const rows = scheduleRows(schedules, establishment, roster);
  return res.json({ title: `${establishment.nombre} · ${body.semana}`, semana: body.semana,
    establecimientoId: body.establecimientoId, status: 'esborrany', draftOnly: true,
    shiftCount: schedules.length, rows, excelSchedule: excel,
    previewHash: createHash('sha256').update(JSON.stringify({ excel, review })).digest('hex'),
    conflicts: review.conflicts, review, modelSummary: result.modelSummary, modelConflicts: result.modelConflicts,
    excelCalculationWarnings: ['La plantilla conserva errores de referencia originales; no se han importado saldos históricos.'],
    note: 'Propuesta sin guardar ni publicar. M: mañana; T: tarde; D: partido; F: libre; V: vacaciones; B: baja.' });
}
