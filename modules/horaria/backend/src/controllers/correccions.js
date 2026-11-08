import { prisma } from '../services/prisma.js';
import { edicionsNetes, moviments } from '../services/edicionsNetes.js';
import { ajust } from '../utils/ajustos.js';

// ─────────────────────────────────────────────
// WHY THE MANAGER CHANGED WHAT WE GENERATED
//
// One and a half corrections a week. Waiting for a pattern to repeat often
// enough to be trustworthy means waiting years — and the same correction can
// mean four different things, three of which must NOT be learned:
//
//   PREFERENCIA  she prefers it that way        → a taste, worth learning
//   DIA_FEINA    that day is too busy           → a shop rule, worth learning
//   PETICION     the employee had asked for it  → WE IGNORED A REQUEST. A bug
//   COBERTURA    there was nobody else          → the minimums do not add up
//
// Imitating the last two teaches the system to reproduce our own mistakes.
// ─────────────────────────────────────────────

export const MOTIUS = ['PREFERENCIA', 'DIA_FEINA', 'PETICION', 'COBERTURA', 'ALTRE'];

/** A stable identity for one correction, so a reason can be matched to it. */
function clau(d) {
  return d.tipus === 'MOU_FESTA'
    ? `MOU_FESTA|${d.empleadoId}|${d.de}|${d.a}`
    : `CANVIA_TORN|${d.empleadoId}|${d.dia}|${d.deIa}|${d.aManager}`;
}

export async function getCorrecciones(req, res) {
  const { establecimiento, semana } = req.query;
  if (!establecimiento || !semana) {
    return res.status(400).json({ error: 'establecimiento y semana requeridos' });
  }
  const estId = parseInt(establecimiento);

  // Turned off from the settings panel once there is nothing left to learn:
  // asking every week stops being useful and becomes one more thing to click
  // past. Answered here rather than hidden in the screen, so nothing is
  // computed for a panel that is not going to be shown.
  if (!(await ajust('demanarMotiuCanvis', estId))) {
    return res.json({ semana, correcciones: [], motivos: MOTIUS, activo: false });
  }

  const [files, motius, empleados] = await Promise.all([
    prisma.schedule.findMany({
      where: { establecimientoId: estId, semana, generadoPorIa: true, turnoIa: { not: null } },
      select: { empleadoId: true, semana: true, dia: true, turno: true, turnoIa: true, generadoPorIa: true },
    }),
    prisma.correccionMotivo.findMany({ where: { establecimientoId: estId, semana } }),
    prisma.employee.findMany({
      where: { establecimientoId: estId },
      select: { id: true, nombre: true, apellidos: true },
    }),
  ]);

  const nom = Object.fromEntries(empleados.map((e) => [e.id, `${e.nombre} ${e.apellidos}`]));
  const jaExplicat = new Set(motius.map((m) => (
    m.tipo === 'MOU_FESTA'
      ? `MOU_FESTA|${m.empleadoId}|${m.diaOrigen}|${m.dia}`
      : `CANVIA_TORN|${m.empleadoId}|${m.dia}|${m.turnoIa}|${m.turnoManager}`
  )));

  const decisions = moviments(edicionsNetes(files)).map((d) => ({
    ...d,
    empleado: nom[d.empleadoId] || `#${d.empleadoId}`,
    clau: clau(d),
    explicat: jaExplicat.has(clau(d)),
  }));

  return res.json({ semana, correcciones: decisions, motivos: MOTIUS, activo: true });
}

export async function saveCorreccionMotivo(req, res) {
  const { establecimientoId, semana, correcciones } = req.body;
  if (!establecimientoId || !semana || !Array.isArray(correcciones)) {
    return res.status(400).json({ error: 'establecimientoId, semana y correcciones requeridos' });
  }

  const dolents = correcciones.filter((c) => !MOTIUS.includes(c.motivo));
  if (dolents.length > 0) {
    return res.status(400).json({ error: `motivo no válido: ${dolents.map((d) => d.motivo).join(', ')}` });
  }

  const creats = [];
  for (const c of correcciones) {
    creats.push(await prisma.correccionMotivo.create({
      data: {
        semana,
        establecimientoId: parseInt(establecimientoId),
        empleadoId: c.empleadoId,
        tipo: c.tipus,
        dia: c.tipus === 'MOU_FESTA' ? c.a : c.dia,
        diaOrigen: c.tipus === 'MOU_FESTA' ? c.de : null,
        turnoIa: c.deIa || null,
        turnoManager: c.aManager || null,
        motivo: c.motivo,
        nota: c.nota || null,
        registradoPorId: req.user?.id || null,
      },
    }));
  }

  // A request we failed to honour is not something to learn from — it is
  // something to fix. Surfaced separately so it does not sit quietly in a
  // table nobody reads.
  const errors = creats.filter((c) => c.motivo === 'PETICION' || c.motivo === 'COBERTURA');
  if (errors.length > 0) {
    console.warn(`[Correccions] ${semana}: ${errors.length} correccions que NO són preferències — ${errors.map((e) => `${e.motivo} (empleat ${e.empleadoId}, ${e.dia})`).join('; ')}`);
  }

  return res.json({ guardados: creats.length, aRevisar: errors.length });
}
