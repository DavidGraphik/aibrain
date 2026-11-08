import { ruleForDay } from '../utils/ruleForDay.js';
import { storePublishedPdf, readPublishedPdf, saveState, loadState } from '../integration/durable-state.js';
import { prisma } from '../services/prisma.js';
import { shiftHours, REDUCED_DAY_FIELDS } from '../utils/shiftHours.js';
import { dayWithinAbsence } from '../utils/absenceDays.js';
import { peticioDeLaCasella } from '../services/peticions.js';
import { idiomaValid, IDIOMA_PER_DEFECTE } from '../utils/etiquetes.js';
import { missatges } from '../utils/missatges.js';
import { DIAS_SEMANA, weeklyHourTarget, normalOpenDays } from '../utils/weeklyTarget.js';
import { weekBounds, weekDay, weekLabel } from '../utils/isoWeek.js';
import { idNumeric } from '../utils/ids.js';
import { potAccedirABotiga } from '../utils/permisos.js';
import { checkEmployeeConditions, parseConditions } from '../services/conditionCheck.js';
import { revisaAlternanca, ultimDissabteTreballat } from '../services/saturdayRotation.js';
import { generateAISchedule, computeFairnessScores, getEditPatterns } from '../services/aiScheduler.js';
import { sendWhatsappMedia } from '../services/whatsapp.js';
import { explicaErrorWhatsapp } from '../utils/whatsappErrors.js';

// Hours per shift type


// ─────────────────────────────────────────────
// GET schedules for a week + establishment
// ─────────────────────────────────────────────
/**
 * La preferència vigent de cada persona per a una setmana.
 *
 * Res al model garanteix que només n'hi hagi una d'activa per persona i
 * setmana, i qui les crea mira si n'hi ha i després crea o actualitza, en dos
 * passos. Si algun dia se'n colen dues — dos missatges seguits, o WhatsApp i
 * full de paper alhora — sense ordenar-les la marca de les caselles dependria
 * de l'ordre en què Postgres les torni. Guanya la més recent.
 */
async function preferenciesDe(semana, empleadoIds) {
  const prefs = await prisma.shiftPreference.findMany({
    where: { semana, activa: true, empleadoId: { in: empleadoIds } },
    select: { empleadoId: true, diasNoDisponible: true, turnosPorDia: true, activa: true },
    orderBy: { updatedAt: 'desc' },
  });
  const mapa = {};
  for (const p of prefs) if (!(p.empleadoId in mapa)) mapa[p.empleadoId] = p;
  return mapa;
}

/** Hi afegeix `peticio`, com fa getSchedules. */
async function ambPeticio(schedule) {
  const mapa = await preferenciesDe(schedule.semana, [schedule.empleadoId]);
  const motiu = peticioDeLaCasella({ dia: schedule.dia, turno: schedule.turno, prefs: mapa[schedule.empleadoId] });
  return motiu ? { ...schedule, peticio: motiu } : { ...schedule, peticio: null };
}

export async function getSchedules(req, res) {
  const { semana, establecimiento } = req.query;
  if (!semana || !establecimiento) {
    return res.status(400).json({ error: 'Parámetros semana y establecimiento requeridos' });
  }

  const schedules = await prisma.schedule.findMany({
    where: { semana, establecimientoId: parseInt(establecimiento) },
    include: {
      empleado: {
        // The frontend grid and the PDF recompute hours with their own copy of
        // shiftHours, so they need the reduced-day columns too — without them a
        // 4-hour morning is displayed and printed as a 7-hour one.
        select: { id: true, nombre: true, apellidos: true, funcion: true, maxHorasSemana: true, ...REDUCED_DAY_FIELDS },
      },
    },
    orderBy: [{ dia: 'asc' }],
  });

  // Annotate LIBRE days that are actually an approved absence (baja/vacaciones)
  // so the UI and the PDF can show B / V instead of F.
  const { monday: weekMonday, sunday: weekSunday } = weekBounds(semana);

  const absences = await prisma.absence.findMany({
    where: {
      estado: 'APROBADO',
      empleadoId: { not: null },
      tipo: { in: ['VACACIONES', 'BAJA_MEDICA'] },
      fechaInicio: { lte: weekSunday },
      fechaFin: { gte: weekMonday },
    },
    select: { empleadoId: true, tipo: true, fechaInicio: true, fechaFin: true },
  });

  if (absences.length > 0) {
    const DIAS_IDX = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
    const absMap = {}; // empleadoId → { LUNES: 'BAJA_MEDICA', ... }
    for (const a of absences) {
      for (let i = 0; i < 7; i++) {
        const day = new Date(weekMonday);
        day.setDate(weekMonday.getDate() + i);
        if (dayWithinAbsence(day, a.fechaInicio, a.fechaFin)) {
          if (!absMap[a.empleadoId]) absMap[a.empleadoId] = {};
          absMap[a.empleadoId][DIAS_IDX[i]] = a.tipo;
        }
      }
    }
    for (const s of schedules) {
      const tipo = absMap[s.empleadoId]?.[s.dia];
      if (tipo && s.turno === 'LIBRE') s.ausencia = tipo;
    }
  }

  // Marcar les caselles que hi són perquè algú les va demanar, perquè no es
  // desfacin sense voler retocant la setmana.
  const prefMap = await preferenciesDe(semana, [...new Set(schedules.map((s) => s.empleadoId))]);
  for (const s of schedules) {
    const motiu = peticioDeLaCasella({ dia: s.dia, turno: s.turno, prefs: prefMap[s.empleadoId] });
    if (motiu) s.peticio = motiu;
  }

  return res.json(schedules);
}

// ─────────────────────────────────────────────
// GET hours worked by employees in OTHER establishments for a given week
// Returns: { empleadoId: { horas: number, detalles: [{ establecimiento, dia, turno }] } }
// ─────────────────────────────────────────────
export async function getOtherEstablishmentHours(req, res) {
  const { semana, establecimiento } = req.query;
  if (!semana || !establecimiento) {
    return res.status(400).json({ error: 'Parámetros semana y establecimiento requeridos' });
  }
  const estId = parseInt(establecimiento);

  const schedules = await prisma.schedule.findMany({
    where: {
      semana,
      establecimientoId: { not: estId },
      // Cross-shop workload is relevant only for this shop's own/shared staff.
      ...(req.user.rol === 'MANAGER_LOCAL' ? { empleado: { OR: [
        { establecimientoId: estId },
        { establecimientosPermitidos: { some: { establishmentId: estId } } },
      ] } } : {}),
    },
    select: {
      empleadoId: true,
      dia: true,
      turno: true,
      // Needed to price the shift: a reduced-day employee's shift is not 7h.
      empleado: { select: { horasPorTurno: true } },
      establecimiento: { select: { id: true, nombre: true } },
    },
  });

  const result = {};
  for (const s of schedules) {
    if (!result[s.empleadoId]) result[s.empleadoId] = { horas: 0, detalles: [] };
    result[s.empleadoId].horas += shiftHours(s.empleado, s.turno);
    result[s.empleadoId].detalles.push({
      establecimiento: s.establecimiento.nombre,
      establecimientoId: s.establecimiento.id,
      dia: s.dia,
      turno: s.turno,
    });
  }

  return res.json(result);
}

// ─────────────────────────────────────────────
// Is the establishment CLOSED on this day of the given week?
// (weekly closed days + festivos when it closes on holidays)
// ─────────────────────────────────────────────
async function isClosedDay(establecimientoId, semana, dia) {
  const DIAS_IDX = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
  const est = await prisma.establishment.findUnique({
    where: { id: establecimientoId },
    select: { diasApertura: true, cierraFestivos: true },
  });
  if (!est) return false;

  if (est.diasApertura) {
    try {
      const open = JSON.parse(est.diasApertura);
      if (Array.isArray(open) && !open.includes(dia)) return true;
    } catch { /* invalid JSON → treat as open */ }
  }

  if (est.cierraFestivos !== false) {
    const { monday } = weekBounds(semana);
    const idx = DIAS_IDX.indexOf(dia);
    if (idx >= 0) {
      const day = weekDay(monday, idx);
      // Widened by a day either side and then compared as calendar dates:
      // asking the database to compare a local-midnight Date against a
      // UTC-midnight column drops the holiday itself in any timezone east of
      // UTC. See utils/absenceDays.js — it exists for exactly this.
      const abans = new Date(day); abans.setDate(abans.getDate() - 1);
      const despres = new Date(day); despres.setDate(despres.getDate() + 2);
      const festivos = await prisma.absence.findMany({
        where: {
          establecimientoId,
          tipo: 'FESTIVO',
          estado: 'APROBADO',
          fechaInicio: { lte: despres },
          fechaFin: { gte: abans },
        },
        select: { fechaInicio: true, fechaFin: true },
      });
      if (festivos.some((f) => dayWithinAbsence(day, f.fechaInicio, f.fechaFin))) return true;
    }
  }
  return false;
}

/**
 * Every day the shop is shut that week — weekly closure and public holidays —
 * in two queries rather than seven days of two.
 */
async function diesTancatsDe(semana, establecimientoId) {
  const DIAS_IDX = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
  const tancats = new Set();

  const est = await prisma.establishment.findUnique({
    where: { id: establecimientoId },
    select: { diasApertura: true, cierraFestivos: true },
  });
  if (!est) return tancats;

  if (est.diasApertura) {
    try {
      const open = JSON.parse(est.diasApertura);
      if (Array.isArray(open)) for (const d of DIAS_IDX) if (!open.includes(d)) tancats.add(d);
    } catch { /* invalid JSON → treat as open */ }
  }

  if (est.cierraFestivos !== false) {
    const { monday, sunday } = weekBounds(semana);
    const abans = new Date(monday); abans.setDate(abans.getDate() - 1);
    const despres = new Date(sunday); despres.setDate(despres.getDate() + 2);
    const festivos = await prisma.absence.findMany({
      where: {
        establecimientoId, tipo: 'FESTIVO', estado: 'APROBADO',
        fechaInicio: { lte: despres }, fechaFin: { gte: abans },
      },
      select: { fechaInicio: true, fechaFin: true },
    });
    for (let i = 0; i < 7; i++) {
      const day = weekDay(monday, i);
      if (festivos.some((f) => dayWithinAbsence(day, f.fechaInicio, f.fechaFin))) tancats.add(DIAS_IDX[i]);
    }
  }
  return tancats;
}

// ─────────────────────────────────────────────
// Is this person off sick or on holiday that day?
//
// The generator has known about absences from the start — it forces LIBRE on
// them, twice — but nothing stopped a manager assigning a shift by hand
// afterwards. Nobody would do it deliberately; you do it by clicking the wrong
// row on a grid of sixteen people, and the schedule then says somebody signed
// off sick is working Tuesday morning.
//
// Approved absences only: a request still pending is not yet a reason to
// refuse anything.
// ─────────────────────────────────────────────
const NOM_ABSENCIA = {
  BAJA_MEDICA: 'de baixa mèdica',
  VACACIONES: 'de vacances',
  FESTIVO: 'de festiu',
};

async function absenciaDelDia(empleadoId, semana, dia) {
  const DIAS_IDX = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
  const idx = DIAS_IDX.indexOf(dia);
  if (idx < 0 || !empleadoId) return null;

  const { monday } = weekBounds(semana);
  const day = weekDay(monday, idx);
  // Widened by a day either side and compared as calendar dates: the bounds
  // are stored at UTC midnight and the day is built in local time.
  const abans = new Date(day); abans.setDate(abans.getDate() - 1);
  const despres = new Date(day); despres.setDate(despres.getDate() + 2);

  const candidates = await prisma.absence.findMany({
    where: {
      empleadoId,
      estado: 'APROBADO',
      tipo: { in: ['BAJA_MEDICA', 'VACACIONES'] },
      fechaInicio: { lte: despres },
      fechaFin: { gte: abans },
    },
    select: { tipo: true, fechaInicio: true, fechaFin: true },
  });
  return candidates.find((a) => dayWithinAbsence(day, a.fechaInicio, a.fechaFin)) || null;
}

// ─────────────────────────────────────────────
// CREATE a single shift
// ─────────────────────────────────────────────
export async function createShift(req, res) {
  const { empleadoId, establecimientoId, semana, dia, turno, horaEntrada, horaDescanso } = req.body;
  if (!empleadoId || !establecimientoId || !semana || !dia || !turno) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }

  // The establishment is closed that day → no shift can be assigned
  if (turno !== 'LIBRE' && await isClosedDay(parseInt(establecimientoId), semana, dia)) {
    return res.status(400).json({ error: 'El establecimiento está cerrado ese día (cierre semanal o festivo). Solo se puede asignar LIBRE.' });
  }

  if (turno !== 'LIBRE') {
    const absencia = await absenciaDelDia(parseInt(empleadoId), semana, dia);
    if (absencia) {
      return res.status(400).json({
        error: `Aquest treballador està ${NOM_ABSENCIA[absencia.tipo] || 'absent'} aquell dia. Només se li pot assignar LIBRE.`,
      });
    }
  }

  // Check if shift already exists for this employee + day
  const existing = await prisma.schedule.findFirst({
    where: { empleadoId, semana, dia },
  });
  if (existing) {
    return res.status(409).json({ error: 'Ya existe un turno para este empleado en este día' });
  }

  const schedule = await prisma.schedule.create({
    data: {
      empleadoId,
      establecimientoId,
      semana,
      dia,
      turno,
      horaEntrada: horaEntrada || null,
      // L'edició (PUT) ja la desava; l'alta no. Una casella creada de nou amb
      // un PARTIDO perdia l'hora del descans en silenci.
      horaDescanso: horaDescanso || null,
    },
    include: {
      empleado: { select: { id: true, nombre: true, apellidos: true, funcion: true, maxHorasSemana: true } },
    },
  });

  // Run conflict check after creating
  //
  // Pel dia i pel nivell de setmana, com fa reCheckAllConflicts, i no per
  // `conflicts.length`. La llista sencera també porta les condicions que ningú
  // sap comprovar i les que cedeixen per una petició concedida: marcar la
  // casella per aquestes desava `conflicto: true` a la base de dades i deixava
  // l'anell vermell posat fins que alguna altra cosa la recalculés.
  const conflicts = await checkConflicts(empleadoId, semana, establecimientoId);
  const dayMsg = (conflicts.perDay || {})[dia] || null;
  const weekMsg = conflicts.weekLevel && turno !== 'LIBRE' ? conflicts.weekLevel : null;
  const notes = [dayMsg, weekMsg].filter(Boolean);
  if (notes.length > 0) {
    await prisma.schedule.update({
      where: { id: schedule.id },
      data: { conflicto: true, notaConflicto: notes.join('; ') },
    });
    schedule.conflicto = true;
    schedule.notaConflicto = notes.join('; ');
  }

  return res.status(201).json(await ambPeticio(schedule));
}

// ─────────────────────────────────────────────
// UPDATE a shift (manual edit by manager)
// ─────────────────────────────────────────────
export async function updateShift(req, res) {
  const id = parseInt(req.params.id);
  const { turno, horaEntrada, horaDescanso, conflicto, notaConflicto } = req.body;

  // Fetch the current shift BEFORE updating (to log the edit)
  const existing = await prisma.schedule.findUnique({ where: { id } });

  // Closed day → only LIBRE is allowed, even for a manager
  if (existing && turno !== undefined && turno !== 'LIBRE'
      && await isClosedDay(existing.establecimientoId, existing.semana, existing.dia)) {
    return res.status(400).json({ error: 'El establecimiento está cerrado ese día (cierre semanal o festivo). Solo se puede asignar LIBRE.' });
  }

  // Off sick or on holiday → the same, and for the same reason: the engine
  // already refuses to put them there, and a manual edit should not be the one
  // hole in the wall.
  if (existing && turno !== undefined && turno !== 'LIBRE') {
    const absencia = await absenciaDelDia(existing.empleadoId, existing.semana, existing.dia);
    if (absencia) {
      return res.status(400).json({
        error: `Aquest treballador està ${NOM_ABSENCIA[absencia.tipo] || 'absent'} aquell dia. Només se li pot assignar LIBRE.`,
      });
    }
  }

  // Una hora de descans només vol dir alguna cosa en un DIA. Si el torn que
  // queda no ho és, s'esborra encara que la petició no en digui res: si no,
  // canviar un DIA a matí deixava l'hora del descans escrita a la casella, i el
  // dia que algú la tornés a passar a DIA reapareixeria una hora que ningú
  // havia posat.
  const tornFinal = turno !== undefined ? turno : existing?.turno;
  const descans = tornFinal === 'PARTIDO' ? horaDescanso : null;

  const schedule = await prisma.schedule.update({
    where: { id },
    data: {
      ...(turno !== undefined && { turno }),
      ...(horaEntrada !== undefined && { horaEntrada }),
      // `|| null` com a l'alta: així el mateix cas hi arriba igual pels dos
      // camins, en comptes de desar-hi un text buit per un i null per l'altre.
      ...((horaDescanso !== undefined || tornFinal !== 'PARTIDO') && { horaDescanso: descans || null }),
      ...(conflicto !== undefined && { conflicto }),
      ...(notaConflicto !== undefined && { notaConflicto }),
      ajustadoPorManager: true,
    },
    include: {
      empleado: { select: { id: true, nombre: true, apellidos: true, funcion: true, maxHorasSemana: true } },
    },
  });

  // Log the edit if the shift type actually changed
  if (existing && turno !== undefined && existing.turno !== turno) {
    await prisma.scheduleEdit.create({
      data: {
        empleadoId: existing.empleadoId,
        establecimientoId: existing.establecimientoId,
        semana: existing.semana,
        dia: existing.dia,
        turnoAnterior: existing.turno,
        turnoNuevo: turno,
        fueGeneradoPorIa: existing.generadoPorIa,
        editadoPorId: req.user?.id || null,
      },
    });
  }

  // Re-run conflict check after update
  await reCheckAllConflicts(schedule.empleadoId, schedule.semana, schedule.establecimientoId);

  return res.json(await ambPeticio(schedule));
}

// ─────────────────────────────────────────────
// PUBLISH schedule for a week
// ─────────────────────────────────────────────
// Temporary store for published PDFs so WhatsApp can fetch them by URL.
// Twilio downloads the media within seconds; entries expire after 1 hour.
const storePdf = storePublishedPdf;

// Public (unauthenticated, unguessable token) so WhatsApp/Twilio can fetch it.
export function getPublishedPdf(req, res) {
  const entry = readPublishedPdf(req.params.token);
  if (!entry || entry.expiresAt < Date.now()) {
    return res.status(404).json({ error: 'PDF no disponible o caducado' });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${entry.filename}"`);
  return res.send(entry.buffer);
}

export async function publishSchedule(req, res) {
  const { semana, establecimientoId } = req.body;
  if (!semana || !establecimientoId) {
    return res.status(400).json({ error: 'semana y establecimientoId requeridos' });
  }
  const estId = parseInt(establecimientoId);

  await prisma.schedule.updateMany({
    where: { semana, establecimientoId: estId },
    data: { publicado: true },
  });

  // Send the schedule PDF to the shop manager (encargado) by WhatsApp.
  // Only the manager receives it — employees are not messaged.
  let notificado = null;
  let avisoEnvio = null;
  let detalleEnvio = null;
  try {
    const est = await prisma.establishment.findUnique({
      where: { id: estId },
      select: { nombre: true, managerLocal: { select: { nombre: true, telefonoWhatsapp: true } } },
    });
    const tel = est?.managerLocal?.telefonoWhatsapp;

    if (!tel) {
      avisoEnvio = 'sin_telefono';
    } else if (!req.file) {
      avisoEnvio = 'sin_pdf';
    } else {
      const filename = `horario_${(est.nombre || 'establecimiento').replace(/\s+/g, '_')}_${semana}.pdf`;
      const token = storePdf(req.file.buffer, filename);
      const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
      const mediaUrl = `${base}/api/horaria-events/media/${token}`;
      const texto = `Bon dia${est.managerLocal.nombre ? ` ${est.managerLocal.nombre}` : ''}, aquí tens l'horari de ${est.nombre} per a la setmana vinent.`;
      await sendWhatsappMedia(tel, {
        texto, mediaUrl, filename,
        // Fill {{1}} {{2}} {{3}} of the approved template; ignored without one.
        bodyParams: [(est.managerLocal.nombre || '').trim(), est.nombre, weekLabel(semana)],
      });
      notificado = est.managerLocal.nombre;
    }
  } catch (err) {
    // Publishing must not fail because the notification could not be sent
    console.error('[publish] no se pudo notificar al encargado:', err.message);
    avisoEnvio = 'error_envio';
    detalleEnvio = explicaErrorWhatsapp(err.message);
  }

  return res.json({ mensaje: 'Horario publicado correctamente', notificado, avisoEnvio, detalleEnvio });
}

// AI generation
export async function generateSchedule(req, res) {
  const { establecimientoId, semana, quality } = req.body;
  if (!establecimientoId || !semana) {
    return res.status(400).json({ error: 'establecimientoId y semana son obligatorios' });
  }

  try {
    const result = await generateAISchedule({
      establecimientoId: parseInt(establecimientoId),
      semana,
      quality: quality || 'standard',
    });
    return res.json(result);
  } catch (err) {
    console.error('Error generando horario con IA:', err);
    return res.status(500).json({ error: err.message || 'Error al generar el horario' });
  }
}

// ─────────────────────────────────────────────
// ASYNC GENERATION (background job + polling)
// AI generation takes 1-3 minutes — longer than browser/proxy timeouts. The
// frontend starts a job here (returns immediately) and polls its status.
// In-memory store is fine: single server instance, jobs live a few minutes.
// ─────────────────────────────────────────────
const generationJobs = new Map();
if (process.env.HORARIA_STATE_ROOT) {
  for (const [id, job] of loadState('generation-jobs.json') || []) {
    if (job.status === 'running') { job.status = 'error'; job.error = 'El servei s’ha reiniciat durant la generació. Revisa l’horari desat abans de tornar a generar.'; }
    generationJobs.set(id, job);
  }
}
function persistJobs() { if (process.env.HORARIA_STATE_ROOT) saveState('generation-jobs.json', [...generationJobs]); }
export function hasRunningGeneration(estId, week) { return [...generationJobs.values()].some(job => job.status === 'running' && job.establecimientoId === estId && job.semana === week); }
const JOB_TTL_MS = 30 * 60 * 1000;

function cleanOldJobs() {
  const now = Date.now();
  for (const [id, job] of generationJobs) {
    if (now - job.startedAt > JOB_TTL_MS) generationJobs.delete(id);
  }
}

export async function generateScheduleAsync(req, res) {
  const { establecimientoId, semana, quality } = req.body;
  if (!establecimientoId || !semana) {
    return res.status(400).json({ error: 'establecimientoId y semana son obligatorios' });
  }
  const estId = parseInt(establecimientoId);
  cleanOldJobs();

  // If a job for this establishment+week is already running, reuse it
  // (prevents double cost from double-clicks or a reloaded page).
  for (const [id, job] of generationJobs) {
    if (job.status === 'running' && job.establecimientoId === estId && job.semana === semana) {
      return res.json({ jobId: id, reused: true });
    }
  }

  const jobId = `${estId}-${semana}-${Date.now().toString(36)}`;
  const job = { status: 'running', establecimientoId: estId, semana, startedAt: Date.now() };
  generationJobs.set(jobId, job);
  persistJobs();

  // Fire and forget — the job object is updated when the generation settles.
  generateAISchedule({ establecimientoId: estId, semana, quality: quality || 'standard' })
    .then((result) => {
      job.status = 'done';
      job.resumen = result.resumen;
      job.conflictos = result.conflictos;
      job.informeCanvis = result.informeCanvis || [];
      job.turnos = result.schedules?.length || 0;
      persistJobs();
    })
    .catch((err) => {
      console.error('Error generando horario (async):', err);
      job.status = 'error';
      job.error = err.message || 'Error al generar el horario';
      persistJobs();
    });

  return res.status(202).json({ jobId });
}

// GET /schedules/report?semana=&establecimiento= → stored generation report
export async function getGenerationReport(req, res) {
  const { semana, establecimiento } = req.query;
  if (!semana || !establecimiento) return res.status(400).json({ error: 'semana y establecimiento requeridos' });
  const report = await prisma.horarioInforme.findUnique({
    where: { establecimientoId_semana: { establecimientoId: parseInt(establecimiento), semana } },
  });
  if (!report) return res.json({ informe: null });
  const parse = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
  return res.json({
    informe: {
      resumen: report.resumen || '',
      conflictos: parse(report.conflictos),
      informeCanvis: parse(report.informeCanvis),
      createdAt: report.createdAt,
    },
  });
}

export function generateScheduleStatus(req, res) {
  const job = generationJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Trabajo no encontrado (puede haber expirado)' });
  if (!potAccedirABotiga(req.user, job.establecimientoId)) return res.status(403).json({ error: 'Sin acceso a esta generación' });
  const base = { status: job.status, semana: job.semana, segundos: Math.round((Date.now() - job.startedAt) / 1000) };
  if (job.status === 'done') return res.json({ ...base, resumen: job.resumen, conflictos: job.conflictos, informeCanvis: job.informeCanvis, turnos: job.turnos });
  if (job.status === 'error') return res.json({ ...base, error: job.error });
  return res.json(base);
}

// ─────────────────────────────────────────────
// CONFLICT DETECTION
// ─────────────────────────────────────────────

// One row per teammate, with their week, in the shape the condition checker
// wants.
function agrupaPerPersona(filas) {
  const per = new Map();
  for (const f of filas) {
    const clau = `${f.empleado?.nombre || ''}|${f.empleado?.apellidos || ''}`;
    if (!per.has(clau)) per.set(clau, { empleado: f.empleado, dias: [] });
    per.get(clau).dias.push({ dia: f.dia, turno: f.turno });
  }
  return [...per.values()];
}

// Check conflicts for one employee for the week. Read-only — the callers decide
// what to persist — and exported so it can be run against a real week without
// writing anything.
/**
 * Everything wrong with one person's week, from data already in hand.
 *
 * Pulled out of the loader so the same reasoning can serve one employee or a
 * whole shop. The front page used to ask for each person in turn — sixteen
 * round trips of six queries each, ninety-six crossings of the Atlantic to
 * count how many people had a broken condition — because the only way in was
 * a function that fetched its own data.
 */
function conflictesDe({
  employee, weekShifts, preferences, diasHabituales, companys,
  cerrados = new Set(), diesAbsent = new Set(), intensidad = 100, horesAltres = 0,
  idioma = IDIOMA_PER_DEFECTE,
}) {
  const conflicts = [];

  // 1. Hours, against the target for THIS week rather than the bare contract.
  //
  // The two used to disagree. The screen measured against the adjusted target
  // and the server against the contract, so in a week with a bank holiday in
  // it somebody nine hours over target was two hours over contract and only
  // one of them said anything. It is the same shape as the bug that once cost
  // Nuria Bachs her day off: two places computing what a week is worth.
  const TOLERANCIA = 8;
  const M = missatges(idioma);
  const condHores = parseConditions(employee.condicionesFijas);
  let disp = null;
  try { disp = employee.disponibilidad ? JSON.parse(employee.disponibilidad) : null; }
  catch { disp = null; }

  const bloquejatSempre = (d) => !!(disp?.[d] && disp[d].M === false && disp[d].T === false);
  const demanatsLliures = new Set((preferences?.diasNoDisponible || []).map((d) => String(d).toUpperCase()));

  const diasBloqueadosSiempre = DIAS_SEMANA.filter((d) => !cerrados.has(d) && bloquejatSempre(d)).length;
  const diasNoDisponibles = DIAS_SEMANA.filter((d) => {
    if (cerrados.has(d) || bloquejatSempre(d)) return false;
    return diesAbsent.has(d) || demanatsLliures.has(d);
  }).length;

  const { objetivo, diasDisponibles, ajustado } = weeklyHourTarget({
    contractHours: employee.maxHorasSemana,
    intensidad,
    diasAbiertos: DIAS_SEMANA.filter((d) => !cerrados.has(d)).length || 7,
    diasNormales: diasHabituales.length || 7,
    diasNoDisponibles,
    diasBloqueadosSiempre,
    diasLibresPactados: condHores.minDiasLibres || 0,
  });

  const propies = weekShifts.reduce((sum, s) => sum + shiftHours(employee, s.turno), 0);
  const totalHours = propies + horesAltres;
  const detall = ajustado
    ? M.objectiuAjustat(objetivo, diasDisponibles, diasHabituales.length)
    : intensidad === 100 ? `${objetivo}h` : M.objectiuIntensitat(objetivo, intensidad, employee.maxHorasSemana);
  const extra = horesAltres > 0 ? M.horesAltres(propies, horesAltres) : '';

  let massesHores = null;
  if (totalHours > objetivo + TOLERANCIA) {
    massesHores = M.massesHores(totalHours, extra, detall);
  } else if (totalHours > 0 && totalHours < objetivo - TOLERANCIA) {
    massesHores = M.poquesHores(totalHours, extra, detall);
  }
  if (massesHores) conflicts.push(massesHores);
  conflicts.hores = { fetes: totalHours, objetivo, diasDisponibles, ajustado, intensidad };

  // 2. Check unavailable days from preferences (attributed to that specific day)
  const perDay = {}; // dia → mensaje
  if (preferences && preferences.diasNoDisponible?.length > 0) {
    for (const shift of weekShifts) {
      if (shift.turno !== 'LIBRE' && preferences.diasNoDisponible.includes(shift.dia)) {
        const msg = M.noDisponible(M.D(shift.dia));
        conflicts.push(msg);
        perDay[shift.dia] = msg;
      }
    }
  }

  // 3. Fixed conditions. These are prose the general manager wrote for this one
  // person, and they were the only constraint nothing ever verified: the AI is
  // asked to honour them and the repair passes afterwards know nothing of them.
  // Reporting is all this does — it never moves a shift — so a sentence read
  // wrongly costs a missing warning rather than a broken week.
  // Els dies que aquella persona va demanar: els que va dir que no podia
  // (`demanatsLliures`, calculat a dalt) i aquells on va demanar un torn
  // concret. Una condició que cedeix davant d'un d'aquests no és un
  // incompliment — és la norma de la casa funcionant.
  let perDiaDemanat = preferences?.turnosPorDia;
  if (typeof perDiaDemanat === 'string') {
    try { perDiaDemanat = JSON.parse(perDiaDemanat); } catch { perDiaDemanat = null; }
  }
  const diesDemanats = [...demanatsLliures, ...Object.keys(perDiaDemanat || {}).map((d) => String(d).toUpperCase())];

  const { problemas: condProblemas, informatius: condInformatius, cond } = checkEmployeeConditions({
    empleado: employee,
    dias: weekShifts.map((s) => ({ dia: s.dia, turno: s.turno })),
    diasHabituales,
    companys,
    idioma,
    diesDemanats,
  });
  for (const p of condProblemas) conflicts.push(M.condicioFixa(p));
  for (const p of condInformatius) conflicts.push(p);
  // A condition nobody can check is not a condition that passed. Before this,
  // these were computed and then read by no one, so "cap incompliment" quietly
  // meant "cap dels que sé mirar".
  const sinComprobar = cond.noInterpretadas || [];
  for (const f of sinComprobar) {
    conflicts.push(M.condicioSenseComprovar(f));
  }

  // `conflicts` keeps the week-level list (used by the UI panel); `perDay` says
  // which specific day each problem belongs to, so we don't flag the whole week.
  conflicts.perDay = perDay;
  // Kept apart as well as in the list: a breach and a condition nobody can
  // check are both worth showing, but they are not the same news.
  conflicts.sinComprobar = sinComprobar;
  // Apart també: es veuen, però no compten com a incompliment.
  conflicts.perPeticio = condInformatius;
  const nivelSemana = [];
  if (massesHores) nivelSemana.push(massesHores);
  for (const p of condProblemas) nivelSemana.push(M.condicioFixa(p));
  conflicts.weekLevel = nivelSemana.length > 0 ? nivelSemana.join('; ') : null;
  return conflicts;
}

/**
 * The days this shop opens in an ORDINARY week. Sunday is out because it never
 * opens, so it was never a day off anybody was granted; a day lost to an
 * exceptional public holiday stays in, and does serve as the weekly day off.
 */
function diesHabitualsDe(establecimiento) {
  try {
    const cfg = establecimiento?.diasApertura ? JSON.parse(establecimiento.diasApertura) : null;
    if (Array.isArray(cfg) && cfg.length > 0) return cfg;
  } catch { /* sin configurar → toda la semana */ }
  return DIAS_SEMANA;
}

export async function checkConflicts(empleadoId, semana, establecimientoId) {
  const [employee, weekShifts, preferences, establecimiento, equipo, cerrados, extra] = await Promise.all([
    prisma.employee.findUnique({ where: { id: empleadoId } }),
    prisma.schedule.findMany({ where: { empleadoId, semana } }),
    // Per preferenciesDe i no per findFirst: ordena i es queda amb la més
    // recent. Un findFirst sense ordre tria la que Postgres torni primer.
    preferenciesDe(semana, [empleadoId]).then((m) => m[empleadoId] || null),
    prisma.establishment.findUnique({
      where: { id: establecimientoId },
      select: { diasApertura: true, cierraFestivos: true },
    }),
    // Conditions that name another person — "els mateixos matins que Nuria
    // Bachs" — cannot be checked from one person's row alone.
    prisma.schedule.findMany({
      where: { semana, establecimientoId, empleadoId: { not: empleadoId } },
      select: { dia: true, turno: true, empleado: { select: { nombre: true, apellidos: true } } },
    }),
    diesTancatsDe(semana, establecimientoId),
    dadesHoraries(semana, establecimientoId, [empleadoId]),
  ]);

  if (!employee) return [];

  return conflictesDe({
    employee,
    weekShifts,
    preferences,
    diasHabituales: diesHabitualsDe(establecimiento),
    companys: agrupaPerPersona(equipo),
    cerrados,
    diesAbsent: extra.absencies.get(empleadoId) || new Set(),
    intensidad: extra.intensidad,
    horesAltres: extra.altres.get(empleadoId) || 0,
  });
}

/**
 * The three things the hour target needs that a week's shifts do not carry:
 * who is absent which day, the week's intensity setting, and the hours these
 * people work in other shops.
 */
async function dadesHoraries(semana, establecimientoId, empleadoIds) {
  const DIAS_IDX = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
  const { monday, sunday } = weekBounds(semana);

  const [absences, intensitat, altres] = await Promise.all([
    prisma.absence.findMany({
      where: {
        estado: 'APROBADO', empleadoId: { in: empleadoIds },
        tipo: { in: ['VACACIONES', 'BAJA_MEDICA'] },
        fechaInicio: { lte: sunday }, fechaFin: { gte: monday },
      },
      select: { empleadoId: true, fechaInicio: true, fechaFin: true },
    }),
    prisma.semanaIntensidad.findFirst({ where: { semana, establecimientoId }, select: { porcentaje: true } }),
    prisma.schedule.findMany({
      where: { semana, empleadoId: { in: empleadoIds }, establecimientoId: { not: establecimientoId } },
      select: { empleadoId: true, turno: true, empleado: { select: { horasPorTurno: true } } },
    }),
  ]);

  const absencies = new Map();
  for (const a of absences) {
    if (!absencies.has(a.empleadoId)) absencies.set(a.empleadoId, new Set());
    for (let i = 0; i < 7; i++) {
      const day = weekDay(monday, i);
      if (dayWithinAbsence(day, a.fechaInicio, a.fechaFin)) absencies.get(a.empleadoId).add(DIAS_IDX[i]);
    }
  }

  const horesAltres = new Map();
  for (const s of altres) {
    horesAltres.set(s.empleadoId, (horesAltres.get(s.empleadoId) || 0) + shiftHours(s.empleado, s.turno));
  }

  return { absencies, intensidad: intensitat?.porcentaje ?? 100, altres: horesAltres };
}

/**
 * The same answer for everybody in the shop, in four queries instead of six
 * per person. Returns a Map of employeeId → conflicts.
 */
export async function conflictesDeLaSetmana(semana, establecimientoId, idioma = IDIOMA_PER_DEFECTE) {
  const [torns, establecimiento] = await Promise.all([
    prisma.schedule.findMany({
      where: { semana, establecimientoId },
      select: {
        empleadoId: true, dia: true, turno: true,
        empleado: { select: { id: true, nombre: true, apellidos: true, maxHorasSemana: true, condicionesFijas: true, disponibilidad: true, ...REDUCED_DAY_FIELDS } },
      },
    }),
    prisma.establishment.findUnique({
      where: { id: establecimientoId },
      select: { diasApertura: true, cierraFestivos: true },
    }),
  ]);

  const diasHabituales = diesHabitualsDe(establecimiento);
  const ids = [...new Set(torns.map((t) => t.empleadoId))];
  // Abans aquesta consulta demanava només `diasNoDisponible`, o sigui que en
  // aquest camí els torns demanats per dia eren invisibles i el camí d'una sola
  // persona i el de tota la botiga contestaven coses diferents. Ara els dos
  // passen per preferenciesDe.
  const [cerrados, extra, prefs] = await Promise.all([
    diesTancatsDe(semana, establecimientoId),
    dadesHoraries(semana, establecimientoId, ids),
    preferenciesDe(semana, ids),
  ]);
  const prefPer = new Map(Object.entries(prefs).map(([id, p]) => [Number(id), p]));

  const perPersona = new Map();
  for (const t of torns) {
    if (!perPersona.has(t.empleadoId)) perPersona.set(t.empleadoId, { empleado: t.empleado, dias: [] });
    perPersona.get(t.empleadoId).dias.push({ dia: t.dia, turno: t.turno });
  }
  const tots = [...perPersona.entries()];

  const resultat = new Map();
  for (const [id, { empleado, dias }] of tots) {
    resultat.set(id, conflictesDe({
      employee: empleado,
      weekShifts: dias,
      preferences: prefPer.get(id) || null,
      diasHabituales,
      companys: tots.filter(([altre]) => altre !== id).map(([, v]) => ({ empleado: v.empleado, dias: v.dias })),
      cerrados,
      diesAbsent: extra.absencies.get(id) || new Set(),
      intensidad: extra.intensidad,
      horesAltres: extra.altres.get(id) || 0,
      idioma,
    }));
  }
  return resultat;
}

// Re-check all employees for the whole week/establishment (after any edit)
export async function reCheckAllConflicts(empleadoId, semana, establecimientoId) {
  const conflicts = await checkConflicts(empleadoId, semana, establecimientoId);
  const weekShifts = await prisma.schedule.findMany({ where: { empleadoId, semana } });

  // Flag ONLY the days that actually have a problem. A week-level issue (too many
  // hours) is attached to the worked days, never to LIBRE days.
  const perDay = conflicts.perDay || {};
  const weekLevel = conflicts.weekLevel || null;
  for (const shift of weekShifts) {
    const dayMsg = perDay[shift.dia] || null;
    const applyWeek = weekLevel && shift.turno !== 'LIBRE' ? weekLevel : null;
    const notas = [dayMsg, applyWeek].filter(Boolean);
    await prisma.schedule.update({
      where: { id: shift.id },
      data: {
        conflicto: notas.length > 0,
        notaConflicto: notas.length > 0 ? notas.join('; ') : null,
      },
    });
  }
}

// Check establishment-level conflicts (min staff per function per shift)
/**
 * Everything wrong with each person's week, for the panel: hours against the
 * target, days they said they could not work, and their fixed conditions.
 *
 * It used to be computed twice — the conditions here and the hours in the
 * browser, each with its own idea of what the week was worth. Now the screen
 * displays what the server decided.
 */
async function revisaPersones(semana, establecimientoId, idioma) {
  const M = missatges(idioma);
  const perPersona = await conflictesDeLaSetmana(semana, establecimientoId, idioma);
  const noms = new Map();
  const rows = await prisma.schedule.findMany({
    where: { semana, establecimientoId },
    select: { empleadoId: true, empleado: { select: { nombre: true, apellidos: true } } },
    distinct: ['empleadoId'],
  });
  for (const r of rows) noms.set(r.empleadoId, `${r.empleado?.nombre || ''} ${r.empleado?.apellidos || ''}`.replace(/\s+/g, ' ').trim());

  const personals = [];
  const condicionesSinComprobar = [];
  const perPeticio = [];
  const hores = [];
  for (const [id, c] of perPersona) {
    const nom = noms.get(id) || `#${id}`;
    const sc = c.sinComprobar || [];
    // The unchecked ones have their own block, so they are not repeated here.
    // Compared against the sentences themselves rather than against a prefix,
    // which would have to be kept in step with the wording in two languages.
    const senseComprovar = new Set(sc.map((f) => M.condicioSenseComprovar(f)));
    // Les condicions que cedeixen per una petició concedida, igual: es veuen
    // al seu lloc, però no al panell vermell ni al comptador de conflictes.
    // Sense això la portada deia «cap incompliment» i la pantalla d'horaris,
    // dos clics més enllà, en comptava dos dels mateixos.
    const perPeticioSet = new Set(c.perPeticio || []);
    for (const m of c) {
      if (senseComprovar.has(m) || perPeticioSet.has(m)) continue;
      personals.push(`${nom}: ${m}`);
    }
    if (sc.length > 0) condicionesSinComprobar.push({ nombre: nom, frases: sc });
    if (perPeticioSet.size > 0) perPeticio.push({ nombre: nom, frases: [...perPeticioSet] });
    if (c.hores) hores.push({ empleadoId: id, nombre: nom, ...c.hores });
  }
  return { personals, condicionesSinComprobar, perPeticio, hores };
}

/**
 * Who is breaking the Saturday rotation this week.
 *
 * Needs the weeks before this one, which is why it does not live with the
 * per-week condition checks: "the next Saturday" means the next one actually
 * worked, so a Saturday the shop was shut carries the turn over instead of
 * losing it.
 */
async function revisaAlternancaDissabtes(schedules, semana, estId, idioma) {
  const aquestDissabte = schedules.filter((s) => s.dia === 'SABADO' && s.turno !== 'LIBRE');
  if (aquestDissabte.length === 0) return [];

  const anteriors = await prisma.schedule.findMany({
    where: {
      establecimientoId: estId,
      dia: 'SABADO',
      semana: { lt: semana },
      empleadoId: { in: aquestDissabte.map((s) => s.empleadoId) },
    },
    select: { empleadoId: true, semana: true, dia: true, turno: true },
  });

  const perPersona = new Map();
  for (const h of anteriors) {
    if (!perPersona.has(h.empleadoId)) perPersona.set(h.empleadoId, []);
    perPersona.get(h.empleadoId).push(h);
  }

  const problemes = [];
  for (const s of aquestDissabte) {
    const ultim = ultimDissabteTreballat(perPersona.get(s.empleadoId), semana);
    const problema = revisaAlternanca({ turnActual: s.turno, ultim, idioma });
    if (!problema) continue;
    const nom = `${s.empleado?.nombre || ''} ${s.empleado?.apellidos || ''}`.replace(/\s+/g, ' ').trim();
    problemes.push(`${nom}: ${problema}`);
  }
  return problemes;
}

/**
 * Qui va canviar què, aquesta setmana i en aquesta botiga.
 *
 * Les dades ja es desaven des del primer dia: el que faltava era poder-les
 * mirar. El dia que algú digui «a mi em van posar tarda i jo havia demanat
 * matí», això és el que ho contesta — amb nom i hora, no de memòria.
 */
export async function historialCanvis(req, res) {
  const { semana, establecimiento } = req.query;
  if (!semana || !establecimiento) {
    return res.status(400).json({ error: 'semana y establecimiento requeridos' });
  }
  const estId = idNumeric(establecimiento);
  if (estId === null) return res.status(400).json({ error: 'establecimiento inválido' });
  if (!potAccedirABotiga(req.user, estId)) return res.status(403).json({ error: 'Sense accés a aquest establiment' });

  const canvis = await prisma.scheduleEdit.findMany({
    where: { semana, establecimientoId: estId },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      id: true, dia: true, turnoAnterior: true, turnoNuevo: true,
      fueGeneradoPorIa: true, createdAt: true,
      empleado: { select: { nombre: true, apellidos: true } },
      editadoPor: { select: { nombre: true, apellidos: true } },
    },
  });

  return res.json(canvis.map((c) => ({
    id: c.id,
    quan: c.createdAt,
    dia: c.dia,
    de: c.turnoAnterior,
    a: c.turnoNuevo,
    eraDeLaIa: c.fueGeneradoPorIa,
    qui: `${c.empleado.nombre} ${c.empleado.apellidos}`.replace(/\s+/g, ' ').trim(),
    // Sense nom vol dir que ho va fer un procés i no una persona.
    perQui: c.editadoPor ? `${c.editadoPor.nombre} ${c.editadoPor.apellidos}`.replace(/\s+/g, ' ').trim() : null,
  })));
}

export async function checkEstablishmentConflicts(req, res) {
  const { semana, establecimiento } = req.query;
  if (!semana || !establecimiento) {
    return res.status(400).json({ error: 'semana y establecimiento requeridos' });
  }

  const estId = parseInt(establecimiento);
  const [schedules, rules, establishment] = await Promise.all([
    prisma.schedule.findMany({
      where: { semana, establecimientoId: estId },
      include: { empleado: { select: { id: true, nombre: true, apellidos: true, funcion: true, condicionesFijas: true, ...REDUCED_DAY_FIELDS } } },
    }),
    prisma.establishmentRules.findMany({ where: { establecimientoId: estId, activa: true } }),
    prisma.establishment.findUnique({
      where: { id: estId },
      select: { diasApertura: true, cierraFestivos: true },
    }),
  ]);

  const condiciones = await revisaPersones(semana, estId, idiomaValid(req.query.lang));
  const alternanca = await revisaAlternancaDissabtes(schedules, semana, estId, idiomaValid(req.query.lang));
  if (rules.length === 0) return res.json({ conflictos: [], ...condiciones, alternanca });

  const conflictos = [];
  const M = missatges(req.query.lang);
  const dias = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];

  // Days the establishment is CLOSED need no coverage: weekly closed days
  // (diasApertura) plus this week's festivos (if it closes on holidays).
  const closedDays = new Set();
  if (establishment?.diasApertura) {
    try {
      const open = JSON.parse(establishment.diasApertura);
      for (const d of dias) if (!open.includes(d)) closedDays.add(d);
    } catch { /* invalid JSON → treat as open every day */ }
  }
  if (establishment?.cierraFestivos !== false) {
    const { monday: weekMonday, sunday: weekSunday } = weekBounds(semana);
    const festivos = await prisma.absence.findMany({
      where: {
        establecimientoId: estId,
        tipo: 'FESTIVO',
        estado: 'APROBADO',
        fechaInicio: { lte: weekSunday },
        fechaFin: { gte: weekMonday },
      },
      select: { fechaInicio: true, fechaFin: true },
    });
    for (const f of festivos) {
      for (let i = 0; i < 7; i++) {
        const day = new Date(weekMonday);
        day.setDate(weekMonday.getDate() + i);
        if (dayWithinAbsence(day, f.fechaInicio, f.fechaFin)) closedDays.add(dias[i]);
      }
    }
  }

  for (const dia of dias) {
    if (closedDays.has(dia)) continue; // closed → no coverage needed
    // Find the most specific rule for this day
    const rule = ruleForDay(rules, dia);
    if (!rule) continue;

    const diaShifts = schedules.filter((s) => s.dia === dia && s.turno !== 'LIBRE');

    const depManana = diaShifts.filter(
      (s) => s.empleado.funcion === 'DEPENDIENTA' && (s.turno === 'MANANA' || s.turno === 'PARTIDO')
    ).length;
    const depTarde = diaShifts.filter(
      (s) => s.empleado.funcion === 'DEPENDIENTA' && (s.turno === 'TARDE' || s.turno === 'PARTIDO')
    ).length;
    const elaManana = diaShifts.filter(
      (s) => s.empleado.funcion === 'ELABORACION' && (s.turno === 'MANANA' || s.turno === 'PARTIDO')
    ).length;
    const elaTarde = diaShifts.filter(
      (s) => s.empleado.funcion === 'ELABORACION' && (s.turno === 'TARDE' || s.turno === 'PARTIDO')
    ).length;

    if (depManana < rule.minDependientasManana)
      conflictos.push(M.faltaGent(M.D(dia), M.dependentes, M.T('MANANA'), depManana, rule.minDependientasManana));
    if (depManana > (rule.maxDependientasManana ?? 99))
      conflictos.push(M.sobraGent(M.D(dia), M.dependentes, M.T('MANANA'), depManana, rule.maxDependientasManana));
    if (depTarde < rule.minDependientasTarde)
      conflictos.push(M.faltaGent(M.D(dia), M.dependentes, M.T('TARDE'), depTarde, rule.minDependientasTarde));
    if (depTarde > (rule.maxDependientasTarde ?? 99))
      conflictos.push(M.sobraGent(M.D(dia), M.dependentes, M.T('TARDE'), depTarde, rule.maxDependientasTarde));
    if (elaManana < rule.minElaboracionManana)
      conflictos.push(M.faltaGent(M.D(dia), M.obrador, M.T('MANANA'), elaManana, rule.minElaboracionManana));
    if (elaManana > (rule.maxElaboracionManana ?? 99))
      conflictos.push(M.sobraGent(M.D(dia), M.obrador, M.T('MANANA'), elaManana, rule.maxElaboracionManana));
    if (elaTarde < rule.minElaboracionTarde)
      conflictos.push(M.faltaGent(M.D(dia), M.obrador, M.T('TARDE'), elaTarde, rule.minElaboracionTarde));
    if (elaTarde > (rule.maxElaboracionTarde ?? 99))
      conflictos.push(M.sobraGent(M.D(dia), M.obrador, M.T('TARDE'), elaTarde, rule.maxElaboracionTarde));
  }

  return res.json({ conflictos, ...condiciones, alternanca });
}

// ─────────────────────────────────────────────
// GET fairness scores for an establishment
// ─────────────────────────────────────────────
export async function getFairness(req, res) {
  const { semana, establecimiento } = req.query;
  if (!semana || !establecimiento) {
    return res.status(400).json({ error: 'Parámetros semana y establecimiento requeridos' });
  }

  const estId = parseInt(establecimiento);
  const employees = await prisma.employee.findMany({
    where: {
      activo: true,
      OR: [
        { establecimientoId: estId },
        { establecimientosPermitidos: { some: { establishmentId: estId } } },
      ],
    },
    select: { id: true, nombre: true, apellidos: true },
  });

  const scores = await computeFairnessScores(estId, semana, employees);
  return res.json(scores);
}

// ─────────────────────────────────────────────
// GET learned edit patterns for an establishment
// ─────────────────────────────────────────────
export async function getLearnedPatterns(req, res) {
  const { establecimiento } = req.query;
  if (!establecimiento) {
    return res.status(400).json({ error: 'Parámetro establecimiento requerido' });
  }

  const estId = parseInt(establecimiento);
  const employees = await prisma.employee.findMany({
    where: {
      activo: true,
      OR: [
        { establecimientoId: estId },
        { establecimientosPermitidos: { some: { establishmentId: estId } } },
      ],
    },
    select: { id: true, nombre: true, apellidos: true },
  });

  const patterns = await getEditPatterns(estId, employees);
  return res.json(patterns);
}

// ─────────────────────────────────────────────
// WEEKLY INTENSITY — % of contracted hours expected this week
// (100 = normal, 115 = peak season, 85 = quiet). Set by the manager.
// ─────────────────────────────────────────────
export async function getWeekIntensity(req, res) {
  const { semana, establecimiento } = req.query;
  if (!semana || !establecimiento) return res.status(400).json({ error: 'semana y establecimiento requeridos' });
  const row = await prisma.semanaIntensidad.findUnique({
    where: { establecimientoId_semana: { establecimientoId: parseInt(establecimiento), semana } },
  });
  return res.json({ porcentaje: row?.porcentaje ?? 100, nota: row?.nota || null });
}

export async function setWeekIntensity(req, res) {
  const { semana, establecimientoId, porcentaje, nota } = req.body;
  if (!semana || !establecimientoId) return res.status(400).json({ error: 'semana y establecimientoId requeridos' });
  const pct = parseInt(porcentaje);
  if (isNaN(pct) || pct < 60 || pct > 130) {
    return res.status(400).json({ error: 'porcentaje debe estar entre 60 y 130' });
  }
  const estId = parseInt(establecimientoId);
  const row = await prisma.semanaIntensidad.upsert({
    where: { establecimientoId_semana: { establecimientoId: estId, semana } },
    update: { porcentaje: pct, nota: nota || null },
    create: { establecimientoId: estId, semana, porcentaje: pct, nota: nota || null },
  });
  return res.json({ porcentaje: row.porcentaje, nota: row.nota });
}

// GET /schedules/closed-days?semana=&establecimiento= → days the shop is closed
export async function getClosedDays(req, res) {
  const { semana, establecimiento } = req.query;
  if (!semana || !establecimiento) return res.status(400).json({ error: 'semana y establecimiento requeridos' });
  return res.json({ dias: [...await diesTancatsDe(semana, parseInt(establecimiento))] });
}
