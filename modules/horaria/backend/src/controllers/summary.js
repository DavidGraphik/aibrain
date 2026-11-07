import { prisma } from '../services/prisma.js';
import { getConversationStatus, computeDeadline, getNextWeek } from '../services/whatsapp.js';
import { conflictesDeLaSetmana } from './schedules.js';
import { edicionsNetes, moviments } from '../services/edicionsNetes.js';

// ─────────────────────────────────────────────
// WHAT IS LEFT TO DO THIS WEEK
//
// Running a week meant three pages: WhatsApp to see whether the broadcast went
// out and who had replied, absences for a sick note, schedules to generate and
// publish. Nowhere said what state the week was actually in — you found out by
// visiting each screen and remembering what you saw.
//
// Everything here is already computed somewhere; none of it was ever shown
// together. Coverage conflicts are deliberately NOT included: the schedules
// endpoint already answers that, and a second implementation of the same
// question is how two parts of this app came to disagree about an hour target.
// ─────────────────────────────────────────────
export async function getWeekSummary(req, res) {
  const { establecimiento, semana } = req.query;
  if (!establecimiento) {
    return res.status(400).json({ error: 'Parámetro establecimiento requerido' });
  }
  const estId = parseInt(establecimiento);
  const week = semana || getNextWeek();

  const establishment = await prisma.establishment.findUnique({
    where: { id: estId },
    select: { id: true, nombre: true },
  });
  if (!establishment) return res.status(404).json({ error: 'Establecimiento no encontrado' });

  const [estado, turnos, fulls] = await Promise.all([
    getConversationStatus(estId, week),
    prisma.schedule.findMany({
      where: { establecimientoId: estId, semana: week },
      select: { publicado: true, empleadoId: true },
    }),
    prisma.paperSheet.count({ where: { establecimientoId: estId, semana: week } }),
  ]);

  // A broadcast leaves a conversation behind for that week, so somebody having
  // been contacted at all is what says it went out.
  const contactados = (estado.empleados || []).filter((e) => e.estado !== 'SIN_CONTACTAR').length;

  const limite = await computeDeadline(week);
  const trabajados = turnos.filter((t) => t.publicado !== undefined);

  // Fixed conditions, through the same checker the grid and every manual edit
  // use — one source for the answer, not a second opinion.
  // One pass for the whole shop. Asking person by person meant sixteen round
  // trips of six queries each just to count how many had a broken condition,
  // and every one of them crosses the Atlantic.
  const perPersona = await conflictesDeLaSetmana(week, estId);
  let incumplimientos = 0;
  let sinComprobar = 0;
  for (const c of perPersona.values()) {
    const noComprovades = (c.sinComprobar || []).length + (c.perPeticio || []).length;
    // A condition nobody knows how to check is not a condition that passed.
    // Counting the two together would put us back where we started: a green
    // tick that means "cap dels que sé mirar".
    //
    // Una condició que cedeix davant d'una petició concedida sí que es
    // descompta: les peticions manen per damunt de les condicions fixes, o
    // sigui que això no és un error sinó la norma funcionant.
    if (c.length > noComprovades) incumplimientos++;
    if (noComprovades > 0) sinComprobar++;
  }

  // How far the generation landed from what the manager actually wanted, week
  // by week. Without a number there is no way to tell whether anything we do
  // to the engine helps: five weeks of use had produced a learning system that
  // never fired once, and nobody could have noticed.
  const historic = await prisma.schedule.findMany({
    where: { establecimientoId: estId, generadoPorIa: true, turnoIa: { not: null } },
    select: { empleadoId: true, semana: true, dia: true, turno: true, turnoIa: true, generadoPorIa: true },
  });
  const decisionsPerSetmana = {};
  for (const s of historic) (decisionsPerSetmana[s.semana] ||= []).push(s);
  const correccions = Object.entries(decisionsPerSetmana)
    .map(([sem, files]) => ({
      semana: sem,
      // Decisions, not cells: moving a day off is one correction, not two.
      correcciones: moviments(edicionsNetes(files)).length,
      turnos: files.length,
    }))
    .sort((a, b) => a.semana.localeCompare(b.semana));

  return res.json({
    establecimiento: establishment,
    semana: week,
    broadcast: {
      enviado: contactados > 0,
      contactados,
    },
    preferencias: estado.resumen || {
      total: 0, conWhatsapp: 0, completados: 0, enProgreso: 0, pendientes: 0,
    },
    limite: {
      fecha: limite ? limite.toISOString() : null,
      pasado: limite ? Date.now() > limite.getTime() : false,
    },
    horario: {
      generado: trabajados.length > 0,
      turnos: trabajados.length,
      publicado: turnos.some((t) => t.publicado),
    },
    condiciones: { incumplimientos, sinComprobar },
    correcciones: {
      estaSemana: correccions.find((c) => c.semana === week)?.correcciones ?? null,
      historial: correccions.slice(-8),
    },
    hojas: fulls,
  });
}
