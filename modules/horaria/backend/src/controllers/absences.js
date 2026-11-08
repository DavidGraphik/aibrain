import { prisma } from '../services/prisma.js';
import { potAccedirABotiga, potTocarPersona, esGeneral } from '../utils/permisos.js';
import { idNumeric } from '../utils/ids.js';
import { findOverlappingAbsence, describeOverlap } from '../utils/absenceOverlap.js';
import { dayWithinAbsence } from '../utils/absenceDays.js';
import { festesLocals, llistaMunicipis } from '../services/festesLocals.js';

// ─────────────────────────────────────────────
// QUI POT VEURE I TOCAR LES ABSÈNCIES
//
// Les vuit rutes d'aquest fitxer portaven `requireAuth` i res més: ni rol ni
// establiment. Qualsevol responsable autenticat podia llegir, modificar o
// esborrar les baixes mèdiques i les vacances de qualsevol treballador de
// qualsevol botiga. Les baixes són dades de salut, categoria especial del RGPD.
//
// Les que porten l'establiment al query o al body es comproven directament. Les
// que van per id (modificar, esborrar) s'han de llegir primer per saber de quina
// botiga són: no hi ha manera de saber-ho sense mirar-ho.
// ─────────────────────────────────────────────

/**
 * El treballador, si aquest usuari hi pot arribar. Si no, contesta ell mateix.
 *
 * Comprovar la botiga que ve al cos de la petició no n'hi ha prou: una
 * encarregada podia posar una botiga seva i l'id d'algú d'una altra, i li
 * creava una baixa mèdica a nom seu. Com que després les absències es llisten
 * per botiga, aquella baixa passava a ser visible per als responsables de la
 * botiga on s'havia colat.
 */
async function treballadorAccessible(req, res, empleadoId) {
  const id = idNumeric(empleadoId);
  if (!id) {
    res.status(400).json({ error: 'empleadoId no és vàlid' });
    return null;
  }
  const emp = await prisma.employee.findUnique({
    where: { id },
    select: {
      id: true, rol: true, establecimientoId: true,
      establecimientosPermitidos: { select: { establishmentId: true } },
    },
  });
  if (!emp) {
    res.status(404).json({ error: 'Empleado no encontrado' });
    return null;
  }
  if (!potTocarPersona(req.user, emp)) {
    res.status(403).json({ error: 'No tens accés a aquest treballador' });
    return null;
  }
  return emp;
}

/** L'absència, si aquest usuari hi pot arribar. Si no, contesta ell mateix. */
async function absenciaAccessible(req, res, id) {
  const num = idNumeric(id);
  if (!num) {
    res.status(400).json({ error: 'id no és vàlid' });
    return null;
  }
  const abs = await prisma.absence.findUnique({
    where: { id: num },
    select: { id: true, establecimientoId: true },
  });
  if (!abs) {
    res.status(404).json({ error: 'Ausencia no encontrada' });
    return null;
  }
  if (!potAccedirABotiga(req.user, abs.establecimientoId)) {
    res.status(403).json({ error: 'No tens accés a aquesta absència' });
    return null;
  }
  return abs;
}

// GET /absences?establecimiento=1&year=2026
export async function getAbsences(req, res) {
  const { establecimiento, year, empleado } = req.query;
  const where = {};

  if (establecimiento) {
    if (!potAccedirABotiga(req.user, establecimiento)) {
      return res.status(403).json({ error: 'No tens accés a aquest establiment' });
    }
    where.establecimientoId = parseInt(establecimiento);
  } else if (!esGeneral(req.user)) {
    // Sense filtre, una encarregada només veu les seves botigues. Abans veia
    // les de tothom, baixes mèdiques incloses.
    where.establecimientoId = { in: req.user.establecimientos || [] };
  }
  if (empleado) where.empleadoId = parseInt(empleado);

  // Filter by year if provided, otherwise current year
  const y = year ? parseInt(year) : new Date().getFullYear();
  where.fechaInicio = { lte: new Date(`${y}-12-31`) };
  where.fechaFin = { gte: new Date(`${y}-01-01`) };

  const absences = await prisma.absence.findMany({
    where,
    include: {
      empleado: { select: { id: true, nombre: true, apellidos: true } },
      establecimiento: { select: { id: true, nombre: true } },
    },
    orderBy: { fechaInicio: 'asc' },
  });

  res.json(absences);
}

// POST /absences
export async function createAbsence(req, res) {
  const { tipo, fechaInicio, fechaFin, empleadoId, establecimientoId, notas, estado } = req.body;

  if (!tipo || !fechaInicio || !fechaFin || !establecimientoId) {
    return res.status(400).json({ error: 'tipo, fechaInicio, fechaFin and establecimientoId are required' });
  }

  // VACACIONES and BAJA_MEDICA need an employee
  if (!potAccedirABotiga(req.user, establecimientoId)) {
    return res.status(403).json({ error: 'No tens accés a aquest establiment' });
  }

  if ((tipo === 'VACACIONES' || tipo === 'BAJA_MEDICA') && !empleadoId) {
    return res.status(400).json({ error: 'empleadoId is required for VACACIONES and BAJA_MEDICA' });
  }
  if (empleadoId && !await treballadorAccessible(req, res, empleadoId)) return;

  // FESTIVO doesn't need an employee
  const data = {
    tipo,
    fechaInicio: new Date(fechaInicio),
    fechaFin: new Date(fechaFin),
    establecimientoId: parseInt(establecimientoId),
    notas: notas || null,
    estado: estado || 'APROBADO',
  };

  if (empleadoId) data.empleadoId = parseInt(empleadoId);

  const solapada = await findOverlappingAbsence({ tipo, empleadoId, establecimientoId, fechaInicio, fechaFin });
  if (solapada) {
    return res.status(409).json({ error: describeOverlap(solapada, tipo), conflictoCon: solapada.id });
  }

  const absence = await prisma.absence.create({
    data,
    include: {
      empleado: { select: { id: true, nombre: true, apellidos: true } },
      establecimiento: { select: { id: true, nombre: true } },
    },
  });

  res.json(absence);
}

// PUT /absences/:id
export async function updateAbsence(req, res) {
  const { id } = req.params;
  if (!await absenciaAccessible(req, res, id)) return;
  const { tipo, fechaInicio, fechaFin, empleadoId, notas, estado } = req.body;

  // Reassignar l'absència a algú d'una altra botiga era la mateixa porta que
  // crear-la-hi de zero.
  if (empleadoId && !await treballadorAccessible(req, res, empleadoId)) return;

  const data = {};
  if (tipo) data.tipo = tipo;
  if (fechaInicio) data.fechaInicio = new Date(fechaInicio);
  if (fechaFin) data.fechaFin = new Date(fechaFin);
  if (empleadoId !== undefined) data.empleadoId = empleadoId ? parseInt(empleadoId) : null;
  if (notas !== undefined) data.notas = notas;
  if (estado) data.estado = estado;

  const absence = await prisma.absence.update({
    where: { id: parseInt(id) },
    data,
    include: {
      empleado: { select: { id: true, nombre: true, apellidos: true } },
      establecimiento: { select: { id: true, nombre: true } },
    },
  });

  res.json(absence);
}

// DELETE /absences/:id
export async function deleteAbsence(req, res) {
  const { id } = req.params;
  if (!await absenciaAccessible(req, res, id)) return;
  await prisma.absence.delete({ where: { id: parseInt(id) } });
  res.json({ ok: true });
}

// GET /absences/week?establecimiento=1&semana=2026-W16
// Returns which employees are absent on which days of the given week
export async function getAbsencesForWeek(req, res) {
  const { establecimiento, semana } = req.query;
  if (!establecimiento || !semana) {
    return res.status(400).json({ error: 'establecimiento and semana are required' });
  }

  const estId = parseInt(establecimiento);
  if (!potAccedirABotiga(req.user, estId)) {
    return res.status(403).json({ error: 'No tens accés a aquest establiment' });
  }

  // Calculate the Monday and Sunday of the ISO week
  const [year, week] = semana.split('-W').map(Number);
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = (jan4.getDay() + 6) % 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  // Fetch all absences that overlap this week
  const absences = await prisma.absence.findMany({
    where: {
      establecimientoId: estId,
      estado: 'APROBADO',
      fechaInicio: { lte: sunday },
      fechaFin: { gte: monday },
    },
    include: {
      empleado: { select: { id: true, nombre: true, apellidos: true } },
    },
  });

  // Build a map: empleadoId → [{ dia, tipo }]
  const DIAS = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
  const result = {};

  for (const absence of absences) {
    // For each day of the week, check if it falls within the absence range
    for (let i = 0; i < 7; i++) {
      const day = new Date(monday);
      day.setDate(monday.getDate() + i);

      if (dayWithinAbsence(day, absence.fechaInicio, absence.fechaFin)) {
        if (absence.tipo === 'FESTIVO') {
          // FESTIVO applies to all employees — mark with special key
          if (!result['FESTIVO']) result['FESTIVO'] = [];
          if (!result['FESTIVO'].find((d) => d.dia === DIAS[i])) {
            result['FESTIVO'].push({ dia: DIAS[i], tipo: 'FESTIVO', notas: absence.notas });
          }
        } else if (absence.empleadoId) {
          const empId = absence.empleadoId;
          if (!result[empId]) result[empId] = [];
          result[empId].push({
            dia: DIAS[i],
            tipo: absence.tipo,
            nombre: `${absence.empleado.nombre} ${absence.empleado.apellidos}`,
          });
        }
      }
    }
  }

  res.json(result);
}

// GET /absences/balance?establecimiento=1&year=2026
// Returns vacation days used per employee this year
export async function getVacationBalance(req, res) {
  const { establecimiento, year } = req.query;
  const y = year ? parseInt(year) : new Date().getFullYear();
  const estId = parseInt(establecimiento);
  if (!potAccedirABotiga(req.user, estId)) {
    return res.status(403).json({ error: 'No tens accés a aquest establiment' });
  }

  const absences = await prisma.absence.findMany({
    where: {
      establecimientoId: estId,
      tipo: 'VACACIONES',
      estado: 'APROBADO',
      fechaInicio: { lte: new Date(`${y}-12-31`) },
      fechaFin: { gte: new Date(`${y}-01-01`) },
    },
    include: {
      empleado: { select: { id: true, nombre: true, apellidos: true } },
    },
  });

  // Count business days (Mon-Sat) for each absence period
  const balance = {};
  for (const a of absences) {
    if (!a.empleadoId) continue;
    const empId = a.empleadoId;
    if (!balance[empId]) {
      balance[empId] = {
        empleadoId: empId,
        nombre: `${a.empleado.nombre} ${a.empleado.apellidos}`,
        diasUsados: 0,
      };
    }

    // Count days within the year
    const start = new Date(Math.max(a.fechaInicio.getTime(), new Date(`${y}-01-01`).getTime()));
    const end = new Date(Math.min(a.fechaFin.getTime(), new Date(`${y}-12-31`).getTime()));

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dow = d.getDay();
      if (dow !== 0) { // Count Mon-Sat (exclude Sunday only)
        balance[empId].diasUsados++;
      }
    }
  }

  res.json(Object.values(balance));
}

// ─────────────────────────────────────────────
// POST /absences/import-holidays { establecimientoId, year }
// Imports national + regional holidays (free Nager.Date API) and the town's own
// two (the Generalitat's open calendar) as FESTIVO absences for the shop.
// ─────────────────────────────────────────────
export async function importHolidays(req, res) {
  const { establecimientoId, year } = req.body;
  if (!establecimientoId) return res.status(400).json({ error: 'establecimientoId requerido' });
  if (!potAccedirABotiga(req.user, establecimientoId)) {
    return res.status(403).json({ error: 'No tens accés a aquest establiment' });
  }
  const y = parseInt(year) || new Date().getFullYear();

  const est = await prisma.establishment.findUnique({
    where: { id: parseInt(establecimientoId) },
    select: { id: true, nombre: true, comunidadAutonoma: true, municipiCodi: true, municipiNom: true },
  });
  if (!est) return res.status(404).json({ error: 'Establecimiento no encontrado' });
  if (!est.comunidadAutonoma) {
    return res.status(400).json({ error: 'El establecimiento no tiene comunidad autónoma configurada. Edítalo y selecciona una.' });
  }

  // Fetch holidays for Spain from Nager.Date (free, no API key)
  let holidays;
  try {
    const resp = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${y}/ES`);
    if (!resp.ok) throw new Error(`API respondió ${resp.status}`);
    holidays = await resp.json();
  } catch (err) {
    return res.status(502).json({ error: `No se pudo obtener los festivos: ${err.message}` });
  }

  // Keep national holidays (global) + those of this establishment's community
  const applicable = holidays.filter(
    (h) => h.global || (Array.isArray(h.counties) && h.counties.includes(est.comunidadAutonoma))
  );

  // …and the town's own two, which are the ones that actually catch a shop out:
  // nothing national says Girona shuts for Sant Narcís. A failure here is not
  // worth losing the national ones over, so it is reported alongside them.
  let avisoLocal = null;
  if (est.municipiCodi) {
    try {
      const locales = await festesLocals(est.municipiCodi, y);
      if (locales.length === 0) {
        avisoLocal = `El calendari oficial encara no publica les festes locals de ${est.municipiNom || 'el municipi'} per al ${y}.`;
      }
      for (const l of locales) {
        applicable.push({ date: l.fecha, localName: `${l.nombre} · ${l.municipi || est.municipiNom}`, name: l.nombre });
      }
    } catch (err) {
      avisoLocal = `No s'han pogut consultar les festes locals: ${err.message}`;
    }
  } else {
    avisoLocal = 'Aquest establiment no té municipi. Edita\'l i tria\'l per importar també les dues festes locals.';
  }

  // Skip dates that already have a FESTIVO for this establishment
  const yearStart = new Date(`${y}-01-01`);
  const yearEnd = new Date(`${y}-12-31`);
  const existing = await prisma.absence.findMany({
    where: { establecimientoId: est.id, tipo: 'FESTIVO', fechaInicio: { gte: yearStart, lte: yearEnd } },
    select: { fechaInicio: true },
  });
  const existingDates = new Set(existing.map((a) => a.fechaInicio.toISOString().slice(0, 10)));

  const created = [];
  const skipped = [];
  for (const h of applicable) {
    if (existingDates.has(h.date)) { skipped.push(h.date); continue; }
    await prisma.absence.create({
      data: {
        tipo: 'FESTIVO',
        fechaInicio: new Date(h.date),
        fechaFin: new Date(h.date),
        establecimientoId: est.id,
        estado: 'APROBADO',
        notas: h.localName || h.name,
      },
    });
    created.push({ fecha: h.date, nombre: h.localName || h.name });
  }

  return res.json({
    establecimiento: est.nombre,
    year: y,
    importados: created.length,
    omitidos: skipped.length,
    festivos: created,
    aviso: avisoLocal,
  });
}

// ─────────────────────────────────────────────
// GET /absences/municipis?year=2026
// The official list of Catalan municipalities and nuclei, for the picker on the
// shop's form. It cannot be derived from the shop's name — S'Agaró is not a
// municipality, it belongs to Castell-Platja d'Aro — so it is chosen once.
// ─────────────────────────────────────────────
export async function getMunicipis(req, res) {
  const y = parseInt(req.query.year) || new Date().getFullYear();
  try {
    return res.json(await llistaMunicipis(y));
  } catch (err) {
    return res.status(502).json({ error: `No s'ha pogut consultar el calendari oficial: ${err.message}` });
  }
}
