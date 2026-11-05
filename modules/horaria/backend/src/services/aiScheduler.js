import { ruleForDay as getRuleForDay } from '../utils/ruleForDay.js';
import { createAiClient } from '../integration/providers.js';
import { shiftHours, jornadaReducida, entradaPara, descansoPara, REDUCED_DAY_FIELDS } from '../utils/shiftHours.js';
import { weeklyHourTarget, normalOpenDays } from '../utils/weeklyTarget.js';
import { parseConditions, contarTurnos, turnoPermitido, turnoRestringido, checkEmployeeConditions } from './conditionCheck.js';
import { alternancaCompleix, ultimDissabteTreballat } from './saturdayRotation.js';
import { dayWithinAbsence } from '../utils/absenceDays.js';
import { jsonrepair } from 'jsonrepair';
import { prisma } from './prisma.js';
import { revisaInforme } from './reportCheck.js';
import { ocupacioAltresBotigues } from './altresBotigues.js';
import { edicionsNetes, moviments, NOMS_DIA as DIA_CA } from './edicionsNetes.js';
import { aplicaAUnaPersona, sincronitzaMatins } from './passadesCondicions.js';
import { applyDraftCoverage, applyDraftRequests, reviewDraft } from './draft-scenario.js';
import { enforceFinalScheduleBounds, remainingWeeklyHours } from './final-schedule-bounds.js';

const client = createAiClient();

const DIAS = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];


// Structured-output tool. Forcing the model to answer through this tool means it
// emits ONLY the schedule object — no analysis prose — which cuts output tokens
// (cost + latency) drastically and guarantees valid, parseable JSON.
const SCHEDULE_TOOL = {
  name: 'guardar_horario',
  description: 'Guarda el horario semanal generado para el establecimiento.',
  input_schema: {
    type: 'object',
    properties: {
      horario: {
        type: 'array',
        description: 'Un objeto por empleado con sus turnos de la semana.',
        items: {
          type: 'object',
          properties: {
            empleadoId: { type: 'integer' },
            dias: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  dia: { type: 'string', enum: DIAS },
                  turno: { type: 'string', enum: ['MANANA', 'TARDE', 'PARTIDO', 'LIBRE'] },
                  horaDescanso: { type: ['string', 'null'], description: 'Solo para PARTIDO; si no, null.' },
                  conflicto: { type: 'boolean' },
                  notaConflicto: { type: ['string', 'null'] },
                },
                required: ['dia', 'turno'],
              },
            },
          },
          required: ['empleadoId', 'dias'],
        },
      },
      conflictos: { type: 'array', items: { type: 'string' } },
      resumen: { type: 'string' },
      informeCanvis: {
        type: 'array',
        description: 'Solo cambios NOTABLES que el manager debería revisar (no todos los empleados). Vacío si no hay nada destacable. Incluye cuando: una preferencia del trabajador no se ha podido respetar, se ha aplicado una regla que le afecta, o se ha tomado una decisión discutible por cobertura.',
        items: {
          type: 'object',
          properties: {
            empleadoId: { type: 'integer' },
            peticion: { type: 'string', description: 'Qué pidió o prefería el trabajador (o "—" si no pidió nada).' },
            cambio: { type: 'string', description: 'Qué se ha decidido finalmente para él/ella.' },
            motivo: { type: 'string', description: 'Por qué se tomó esa decisión.' },
          },
          required: ['empleadoId', 'cambio', 'motivo'],
        },
      },
    },
    required: ['horario', 'conflictos', 'resumen'],
  },
};
// Standard shift entry times (manager can adjust any shift afterwards in the app).
const DEFAULT_ENTRADA = { MANANA: '07:30', TARDE: '14:45', PARTIDO: '07:30' };
function defaultEntrada(turno) {
  return DEFAULT_ENTRADA[turno] || null;
}

// Extract the schedule JSON object from the model's response, even when the model
// adds reasoning/prose or markdown fences around it. Finds the object that holds
// "horario" and brace-matches (respecting strings) to its close. Returns the JSON
// substring (possibly truncated — the caller's repair step closes open brackets).
function extractScheduleJson(text) {
  if (!text) return null;
  const key = text.indexOf('"horario"');
  // Opening brace of the object containing "horario" (or first brace as fallback)
  let start = key !== -1 ? text.lastIndexOf('{', key) : text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return text.slice(start); // truncated — return what we have, repair will close it
}

// ─────────────────────────────────────────────
// FAIRNESS SCORING — analyzes last 8 weeks of schedule history
// Returns per-employee fairness metrics
// ─────────────────────────────────────────────
export async function computeFairnessScores(establecimientoId, currentSemana, employees) {
  // Get last 8 weeks of schedules for this establishment
  const [year, week] = currentSemana.split('-W').map(Number);
  const pastWeeks = [];
  for (let i = 1; i <= 8; i++) {
    let w = week - i;
    let y = year;
    if (w <= 0) { w += 52; y -= 1; }
    pastWeeks.push(`${y}-W${String(w).padStart(2, '0')}`);
  }

  const employeeIds = employees.map((e) => e.id);
  const history = await prisma.schedule.findMany({
    where: {
      establecimientoId,
      semana: { in: pastWeeks },
      empleadoId: { in: employeeIds },
    },
    select: { empleadoId: true, dia: true, turno: true, semana: true },
  });

  const weeksAnalyzed = [...new Set(history.map((h) => h.semana))].length;

  const scores = employees.map((emp) => {
    const empHistory = history.filter((h) => h.empleadoId === emp.id);
    const sabados = empHistory.filter((h) => h.dia === 'SABADO' && h.turno !== 'LIBRE').length;
    const domingos = empHistory.filter((h) => h.dia === 'DOMINGO' && h.turno !== 'LIBRE').length;
    const partidos = empHistory.filter((h) => h.turno === 'PARTIDO').length;
    const tardes = empHistory.filter((h) => h.turno === 'TARDE').length;
    const libres = empHistory.filter((h) => h.turno === 'LIBRE').length;
    const semanasTrabajadas = [...new Set(empHistory.map((h) => h.semana))].length;

    return {
      empleadoId: emp.id,
      nombre: `${emp.nombre} ${emp.apellidos}`,
      semanasAnalizadas: weeksAnalyzed,
      sabadosTrabajados: sabados,
      domingosTrabajados: domingos,
      finesDeSemanaTrabajados: sabados + domingos,
      turnosPartido: partidos,
      turnosTarde: tardes,
      diasLibreTotal: libres,
      diasLibrePromedio: semanasTrabajadas > 0 ? Math.round((libres / semanasTrabajadas) * 10) / 10 : 0,
    };
  });

  // Compute fairness index: how far each employee is from the average
  if (scores.length > 0) {
    const avgWeekend = scores.reduce((s, e) => s + e.finesDeSemanaTrabajados, 0) / scores.length;
    const avgPartido = scores.reduce((s, e) => s + e.turnosPartido, 0) / scores.length;
    for (const s of scores) {
      s.desvioFinDeSemana = Math.round((s.finesDeSemanaTrabajados - avgWeekend) * 10) / 10;
      s.desvioPartido = Math.round((s.turnosPartido - avgPartido) * 10) / 10;
      // Negative = has worked LESS than average (should work more this week)
      // Positive = has worked MORE than average (deserves a break)
    }
  }

  return scores;
}

// ─────────────────────────────────────────────
// LEARNING FROM EDITS — what the manager keeps having to fix
//
// This used to read the click log, where two thirds of the entries were undos
// made seconds apart and the same person's history could say both "changes
// MANANA to TARDE" and the reverse. It has now been reading clean corrections
// — the difference between what we generated and what was published — grouped
// into decisions rather than cells.
//
// The thresholds came down from three identical repetitions to two, because
// three was unreachable: five weeks of real use produced six corrections in
// total, no two of them alike. These go to the model as soft preferences, so
// the cost of a pattern that turns out to be a coincidence is small — and the
// count is written into the sentence so it can be judged.
// ─────────────────────────────────────────────
export async function getEditPatterns(establecimientoId, employees) {
  const employeeIds = employees.map((e) => e.id);

  const files = await prisma.schedule.findMany({
    where: {
      establecimientoId,
      empleadoId: { in: employeeIds },
      generadoPorIa: true,
      turnoIa: { not: null },
    },
    select: { empleadoId: true, semana: true, dia: true, turno: true, turnoIa: true, generadoPorIa: true },
    orderBy: { semana: 'desc' },
    take: 2000,
  });

  const decisions = moviments(edicionsNetes(files));
  if (decisions.length === 0) return [];

  const patterns = [];
  const nomDe = (id) => {
    const e = employees.find((x) => x.id === id);
    return e ? `${e.nombre} ${e.apellidos}` : `#${id}`;
  };

  const perEmpleat = {};
  for (const d of decisions) (perEmpleat[d.empleadoId] ||= []).push(d);

  for (const [idStr, seves] of Object.entries(perEmpleat)) {
    const empId = Number(idStr);
    if (!employees.some((e) => e.id === empId)) continue;
    const name = nomDe(empId);

    // Days off we keep putting in the wrong place, and where they end up.
    const treuDe = {};
    const posaA = {};
    for (const d of seves.filter((x) => x.tipus === 'MOU_FESTA')) {
      treuDe[d.de] = (treuDe[d.de] || 0) + 1;
      posaA[d.a] = (posaA[d.a] || 0) + 1;
    }
    for (const [dia, n] of Object.entries(treuDe)) {
      if (n >= 2) patterns.push({ empleadoId: empId, descripcion: `${name}: el responsable li treu el dia de festa del ${DIA_CA[dia]} (${n} vegades). Evita posar-l\'hi.` });
    }
    for (const [dia, n] of Object.entries(posaA)) {
      if (n >= 2) patterns.push({ empleadoId: empId, descripcion: `${name}: el responsable sol acabar posant-li el dia de festa el ${DIA_CA[dia]} (${n} vegades).` });
    }

    // Shifts on a given weekday that keep getting swapped for the same thing.
    const canvis = {};
    for (const d of seves.filter((x) => x.tipus === 'CANVIA_TORN')) {
      const k = `${d.dia}|${d.deIa}|${d.aManager}`;
      canvis[k] = (canvis[k] || 0) + 1;
    }
    for (const [k, n] of Object.entries(canvis)) {
      if (n < 2) continue;
      const [dia, de, a] = k.split('|');
      patterns.push({ empleadoId: empId, descripcion: `${name}: el ${DIA_CA[dia]} el responsable li canvia ${de} per ${a} (${n} vegades).` });
    }
  }

  // Something the whole shop keeps correcting, not one person.
  const totsCanvis = decisions.filter((d) => d.tipus === 'CANVIA_TORN');
  const desDePartido = totsCanvis.filter((d) => d.deIa === 'PARTIDO').length;
  if (desDePartido >= 4 && desDePartido / decisions.length > 0.3) {
    patterns.push({
      empleadoId: null,
      descripcion: `El responsable desfà sovint els torns DIA que assigna la IA (${desDePartido} de ${decisions.length} correccions). Fes-ne servir menys.`,
    });
  }

  return patterns;
}

// Main function — generates a full week schedule
// ─────────────────────────────────────────────
export async function generateAISchedule({ establecimientoId, semana, quality = 'standard', draftOnly = false, requests = [], coverage }) {
  if (!draftOnly && (requests.length || coverage !== undefined)) throw new Error('Les simulacions només es poden utilitzar en esborranys no desats.');

  // 1. Fetch employees: PRIMARY + cross-establishment (flexible ones from other establishments)
  const employees = await prisma.employee.findMany({
    where: {
      activo: true,
      OR: [
        { establecimientoId },
        { establecimientosPermitidos: { some: { establishmentId: establecimientoId } } },
      ],
    },
    select: {
      id: true,
      nombre: true,
      apellidos: true,
      funcion: true,
      maxHorasSemana: true,
      flexible: true,
      establecimientoId: true,
      disponibilidad: true,
      condicionesFijas: true,
      condicionesEstructuradas: true,
      ...REDUCED_DAY_FIELDS,
      establecimiento: { select: { id: true, nombre: true } },
    },
  });

  const employeeIds = employees.map((e) => e.id);

  // 2. Fetch everything else in parallel
  const [establishment, savedRules, freeRules, recentSchedules, otherEstSchedules] = await Promise.all([
    prisma.establishment.findUnique({ where: { id: establecimientoId }, select: { nombre: true, horarioApertura: true, horarioCierre: true, cierraMediodia: true, inicioCierreMediodia: true, finCierreMediodia: true, diasApertura: true, cierraFestivos: true } }),
    prisma.establishmentRules.findMany({ where: { establecimientoId, activa: true } }),
    prisma.freeTextRule.findMany({ where: { establecimientoId, activa: true } }),
    prisma.schedule.findMany({
      where: { establecimientoId, semana: { not: semana } },
      orderBy: { createdAt: 'desc' },
      take: employees.length * 14,
    }),
    // Schedules in OTHER establishments for the SAME week (to know how many hours each employee already has)
    prisma.schedule.findMany({
      where: {
        empleadoId: { in: employeeIds },
        semana,
        establecimientoId: { not: establecimientoId },
      },
      include: {
        establecimiento: { select: { id: true, nombre: true } },
        // Needed to price the shift: a reduced day is not 7h.
        empleado: { select: { horasPorTurno: true } },
      },
    }),
  ]);

  const rules = draftOnly ? applyDraftCoverage(coverage, savedRules) : savedRules;

  // Build a map: empleadoId → { hours, days: { LUNES: { establecimiento, turno }, ... } }
  // Vegeu services/altresBotigues.js: només els dies que de debò l'ocupen.
  const otherEstMap = ocupacioAltresBotigues(otherEstSchedules);

  // Weekly intensity set by the manager for this week (100 = normal week,
  // 115 = peak season, 85 = quiet week). Scales everyone's target hours
  // proportionally, so a 40h and a 30h contract keep their relative weight.
  const intensidadRow = await prisma.semanaIntensidad.findUnique({
    where: { establecimientoId_semana: { establecimientoId, semana } },
  }).catch(() => null);
  const intensidad = Math.min(130, Math.max(60, intensidadRow?.porcentaje ?? 100));
  const notaIntensidad = intensidadRow?.nota || null;

  for (const emp of employees) {
    const other = otherEstMap[emp.id];
    emp.horasYaTrabajadas = other?.hours || 0;
    emp.diasOcupadosOtrosEstablecimientos = other?.days || {};
    emp.esVisitante = emp.establecimientoId !== establecimientoId;
    emp.dispParsed = parseDisponibilidad(emp.disponibilidad);
    // Read once here rather than per candidate per day per iteration: the
    // repair loop runs five times over every day and every slot.
    emp.condParsed = parseConditions(emp.condicionesFijas);
  }
  // The weekly hour target is set further down, once the closed days and each
  // person's absences are known — it depends on both.

  // Fetch absences for this week
  const [yearNum, weekNum] = semana.split('-W').map(Number);
  const jan4 = new Date(yearNum, 0, 4);
  const dow = (jan4.getDay() + 6) % 7;
  const weekMonday = new Date(jan4);
  weekMonday.setDate(jan4.getDate() - dow + (weekNum - 1) * 7);
  const weekSunday = new Date(weekMonday);
  weekSunday.setDate(weekMonday.getDate() + 6);

  // An employee's leave belongs to the person, not to the shop where it was
  // filed: someone signed off sick at Arnall 2 is equally unavailable at Girona.
  // Scoping these by establishment meant a flexible worker showed a "B" in the
  // schedule table (which never filtered) while the engine, blind to it, was
  // free to give them shifts.
  // FESTIVO is the opposite case — it closes one particular shop — so it stays
  // scoped to this establishment.
  const absences = await prisma.absence.findMany({
    where: {
      estado: 'APROBADO',
      fechaInicio: { lte: weekSunday },
      fechaFin: { gte: weekMonday },
      OR: [
        { empleadoId: { not: null } },
        { empleadoId: null, establecimientoId },
      ],
    },
    include: { empleado: { select: { id: true, nombre: true, apellidos: true } } },
  });

  // Build absence map: empleadoId → [LUNES, MARTES, ...] and festivo days
  const absenceMap = {}; // { empleadoId: { LUNES: 'VACACIONES', ... } }
  const festivoDays = []; // ['LUNES', 'MARTES', ...]
  const DIAS_LIST = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];

  for (const abs of absences) {
    for (let i = 0; i < 7; i++) {
      const day = new Date(weekMonday);
      day.setDate(weekMonday.getDate() + i);
      if (dayWithinAbsence(day, abs.fechaInicio, abs.fechaFin)) {
        if (abs.tipo === 'FESTIVO') {
          // Only close on holidays if this establishment is configured to do so
          if (establishment?.cierraFestivos !== false && !festivoDays.includes(DIAS_LIST[i])) {
            festivoDays.push(DIAS_LIST[i]);
          }
        } else if (abs.empleadoId) {
          if (!absenceMap[abs.empleadoId]) absenceMap[abs.empleadoId] = {};
          absenceMap[abs.empleadoId][DIAS_LIST[i]] = abs.tipo;
        }
      }
    }
  }

  // Merge the establishment's weekly closed days (diasApertura) into the closed-day list.
  // Days not present in diasApertura are treated exactly like festivos: closed, everyone LIBRE.
  if (establishment?.diasApertura) {
    try {
      const openDays = JSON.parse(establishment.diasApertura);
      for (const dia of DIAS_LIST) {
        if (!openDays.includes(dia) && !festivoDays.includes(dia)) festivoDays.push(dia);
      }
    } catch {
      console.warn('[aiScheduler] diasApertura is not valid JSON — ignoring:', establishment.diasApertura);
    }
  }

  // Attach absence info to each employee
  for (const emp of employees) {
    emp.diasAusente = absenceMap[emp.id] || {};
    emp.diasFestivo = festivoDays;
  }

  // Fetch preferences
  const prefs = await prisma.shiftPreference.findMany({
    where: { empleadoId: { in: employeeIds }, semana, activa: true },
  });
  const prefMap = {};
  for (const p of prefs) prefMap[p.empleadoId] = p;

  // Attach the days each employee asked off this week, so the repair passes
  // treat them as unavailable instead of filling them back in to reach hours.
  for (const emp of employees) {
    const dias = prefMap[emp.id]?.diasNoDisponible || [];
    emp.diasPreferenciaLibre = {};
    for (const d of dias) {
      const up = String(d).toUpperCase();
      if (DIAS.includes(up)) emp.diasPreferenciaLibre[up] = true;
    }
    // "That day I can only do mornings/afternoons" — a half-shift the repair
    // passes must not upgrade to PARTIDO.
    emp.turnosPorDiaPreferencia = {};
    for (const [dia, turno] of Object.entries(prefMap[emp.id]?.turnosPorDia || {})) {
      const up = String(dia).toUpperCase();
      const t = String(turno).toUpperCase();
      if (DIAS.includes(up) && (t === 'MANANA' || t === 'TARDE') && !emp.diasPreferenciaLibre[up]) {
        emp.turnosPorDiaPreferencia[up] = t;
      }
    }
  }

  if (draftOnly) {
    if (!establishment || !employees.length) throw new Error('Cal una botiga amb personal actiu per preparar un esborrany.');
    applyDraftRequests(requests, employees);
    for (const r of requests) {
      prefMap[r.employeeId] = { ...prefMap[r.employeeId],
        diasNoDisponible: Object.keys(employees.find(e => e.id === r.employeeId).diasPreferenciaLibre),
        turnosPorDia: employees.find(e => e.id === r.employeeId).turnosPorDiaPreferencia };
    }
  }

  // Target hours for THIS week. Pro-rated by the days the shop actually opens
  // and the days this person can actually work, using the same function the
  // dashboard reports with — the two used to disagree, and the engine's version
  // was the optimistic one. Chasing a target that the week cannot contain is
  // what makes the repair passes eat days off: in 2026-W33 Nuria Bachs was
  // asked for 42h across five open days, so every LIBRE day she had looked to
  // Pass C like an unfilled gap.
  const diasAbiertos = DIAS.filter((d) => !festivoDays.includes(d)).length || 7;
  const diasNormales = normalOpenDays(establishment?.diasApertura);
  for (const emp of employees) {
    // A day this person never works is part of their ordinary week, not a loss:
    // it shrinks the week their contract is measured against. A day lost only
    // this week really is hours gone. Only days that are otherwise open count
    // at all — a closed day is already out of the denominator.
    const abiertoYNoBloqueado = (d) => {
      if (festivoDays.includes(d)) return false;
      const disp = emp.dispParsed?.[d];
      return !(disp && disp.M === false && disp.T === false);
    };
    const diasBloqueadosSiempre = DIAS.filter((d) => {
      if (festivoDays.includes(d)) return false;
      const disp = emp.dispParsed?.[d];
      return !!(disp && disp.M === false && disp.T === false);
    }).length;
    const diasNoDisponibles = DIAS.filter((d) => {
      if (!abiertoYNoBloqueado(d)) return false;
      if (emp.diasAusente?.[d]) return true;
      if (emp.diasPreferenciaLibre?.[d]) return true;
      return !!emp.diasOcupadosOtrosEstablecimientos?.[d];
    }).length;

    const { objetivo, ajustado, diasDisponibles } = weeklyHourTarget({
      contractHours: emp.maxHorasSemana,
      intensidad,
      diasAbiertos,
      diasNormales,
      diasNoDisponibles,
      diasBloqueadosSiempre,
      // Only where the shop shuts for holidays does a closure stand in for the
      // agreed day off — and when it doesn't shut there are no extra closures,
      // so this needs no flag of its own.
      diasLibresPactados: emp.condParsed?.minDiasLibres || 0,
    });
    emp.horasObjetivoSemana = objetivo;
    emp.objetivoAjustado = ajustado;
    emp.diasDisponiblesSemana = diasDisponibles;
    emp.horasDisponibles = Math.max(0, objetivo - emp.horasYaTrabajadas);
  }

  // Build recent history map
  const historyMap = {};
  for (const s of recentSchedules) {
    if (!historyMap[s.empleadoId]) historyMap[s.empleadoId] = [];
    historyMap[s.empleadoId].push({ semana: s.semana, dia: s.dia, turno: s.turno });
  }

  // 2a. Fetch fairness data and edit patterns (for prompt enrichment)
  const [fairnessData, editPatterns] = await Promise.all([
    computeFairnessScores(establecimientoId, semana, employees),
    getEditPatterns(establecimientoId, employees),
  ]);

  // 2b. Build the prompt (split into system instructions + user data)
  const { system, user } = buildPrompt({
    establishment,
    semana,
    employees,
    prefMap,
    rules,
    freeRules,
    historyMap,
    fairnessData,
    editPatterns,
    festivoDays,
    intensidad,
    notaIntensidad,
  });

  // 3. Call Claude API
  const isHighQuality = quality === 'high';
  const model = isHighQuality
    ? (process.env.ANTHROPIC_SCHEDULER_MODEL_HIGH || 'claude-opus-4-8')
    : (process.env.ANTHROPIC_SCHEDULER_MODEL || 'claude-sonnet-4-6');

  const apiParams = {
    model,
    max_tokens: 16000,
    temperature: 0.3,
    system,
    messages: [{ role: 'user', content: user }],
    tools: [SCHEDULE_TOOL],
  };

  if (isHighQuality) {
    // Extended thinking improves quality but forbids forcing a specific tool,
    // so we let the model choose (it still uses the tool) and keep the text fallback.
    apiParams.temperature = 1;
    apiParams.thinking = { type: 'enabled', budget_tokens: 10000 };
  } else {
    // Force the tool → the model returns ONLY the structured schedule, no prose.
    apiParams.tool_choice = { type: 'tool', name: SCHEDULE_TOOL.name };
  }

  const message = await client.messages.create(apiParams);

  // Preferred path: the model answered through the tool → clean structured object.
  const toolBlock = message.content.find((b) => b.type === 'tool_use' && b.name === SCHEDULE_TOOL.name);
  // Fallback: any free text (only possible in high-quality/auto mode).
  const responseText = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  // 4. Get the schedule object.
  let scheduleData;
  if (toolBlock) {
    // Structured tool output — already a parsed object, no JSON.parse needed.
    scheduleData = toolBlock.input;
  } else {
    // Fallback (high-quality/auto mode may answer in text): extract + repair JSON.
    // jsonrepair fixes the occasional unescaped quote / trailing comma / truncation.
    try {
      const jsonStr = extractScheduleJson(responseText);
      if (!jsonStr) throw new Error('No JSON found in response');
      try {
        scheduleData = JSON.parse(jsonStr);
      } catch {
        scheduleData = JSON.parse(jsonrepair(jsonStr));
      }
    } catch (err) {
      throw new Error(`Error al parsear la respuesta de la IA: ${err.message}`);
    }
  }
  if (!scheduleData?.horario) {
    throw new Error('La IA no devolvió un horario válido.');
  }

  // 5. Post-process: force LIBRE on days employee works in another establishment
  forceCrossEstablishmentLibre(scheduleData.horario, employees);

  // 5a-bis. Force LIBRE on approved-absence days BEFORE repair, so coverage
  // gaps left by absent employees get filled with available people instead.
  forceAbsenceDays(scheduleData.horario, employees);

  // 5b. Unified repair algorithm
  repairSchedule(scheduleData.horario, employees, rules);

  // 5c. Enforce "cannot work together" rules parsed from free text
  enforceIncompatiblePairs(scheduleData.horario, employees, freeRules, rules);

  // 5d. Hard guarantee: fixed per-employee availability (a worker can never be
  // scheduled on a slot they marked as unavailable).
  enforceAvailability(scheduleData.horario, employees);

  // 5e. Hard guarantee: on closed days (festivos + weekly closed days) EVERYONE is LIBRE,
  // even if the AI or the repair passes assigned someone.
  forceClosedDays(scheduleData.horario, festivoDays);

  // 5f. Re-assert absences last — no repair pass may leave an absent employee scheduled.
  forceAbsenceDays(scheduleData.horario, employees);

  // 5g. Honour the days each employee asked off in their weekly preferences.
  // Coverage minimums already had their chance above; a requested day off is not
  // undone just to top someone up to their contracted hours.
  forcePreferenceDaysOff(scheduleData.horario, employees);

  // 5h. Honour "that day I can only do mornings/afternoons". Must run after the
  // hour-topping passes, which happily upgrade a half shift to PARTIDO.
  forceShiftRestrictions(scheduleData.horario, employees);

  // 5i. Same reasoning for reduced working days: no split shifts, ever.
  forceNoPartidoOnReduced(scheduleData.horario, employees);


  // The days the shop opens in an ORDINARY week. Needed from here on, both by
  // the passes below and by the reporting at the end.
  let diasHabituales = DIAS;
  try {
    const abiertos = JSON.parse(establishment?.diasApertura || 'null');
    if (Array.isArray(abiertos) && abiertos.length > 0) diasHabituales = abiertos;
  } catch { /* sin configurar → toda la semana */ }

  // 5i-ter. Put the days off where they cost least: off a day the shop is
  // short-staffed, and off Friday and Saturday.
  recolocarFestes(scheduleData.horario, employees, rules, festivoDays, diasHabituales);

  // 5i-quater. A morning nobody is left to cover: turn an afternoon that day
  // into a split shift rather than leave the gap.
  cobrirAmbPartits(scheduleData.horario, employees, rules, festivoDays, diasHabituales);

  // 5i-quinquies. The Saturday rotation. Last, because it needs coverage to
  // have settled: it works by trading places, and it can only tell a good
  // trade from a bad one against a day that is already correct.
  const ultimsDissabtes = {};
  for (const emp of employees) {
    const ultim = ultimDissabteTreballat(historyMap[emp.id] || [], semana);
    if (ultim) ultimsDissabtes[emp.id] = ultim.turno;
  }
  ajustarAlternancaDissabtes(scheduleData.horario, employees, rules, ultimsDissabtes, festivoDays, diasHabituales);

  // 5i-bis. Now that coverage and every restriction have settled, bring people
  // up to the totals their conditions oblige — two split shifts a week, three
  // mornings and three afternoons. Runs here, after the force passes, so
  // nothing downstream can undo what it fixes; it checks all of their
  // constraints itself before touching anything.
  honrarRecuentosExactos(scheduleData.horario, employees, rules);

  // 5k. Les condicions fixes de cadascú, fetes complir amb codi i no demanades
  // al prompt. Fins aquí eren l'única restricció sense passada: la IA les
  // mirava i les passades de reparació les desfeien sense saber que existien.
  //
  // ÚLTIMA DE LA FILA, i no a mitges com estava. Anava després de tot el que
  // mana més —absències, dies tancats, disponibilitat, peticions— però encara
  // en quedaven quatre al darrere: recolocarFestes, cobrirAmbPartits,
  // ajustarAlternancaDissabtes i honrarRecuentosExactos. Cap d'aquestes quatre
  // sap què és `condicionesEstructuradas` —miren el text lliure d'abans— o
  // sigui que podien moure un torn que s'acabava de fixar per complir una
  // condició, i ningú se n'assabentava. El comentari deia «perquè no pugui
  // desfer-ho» i era mentida a mitges.
  aplicaCondicionsFixes(scheduleData.horario, employees, rules, festivoDays);

  // Els mateixos matins que una altra persona. Va DESPRÉS de les condicions
  // d'un en un, perquè aquella altra persona ha d'haver acabat de quadrar la
  // seva setmana abans que ningú s'hi sincronitzi.
  sincronitzaMatins(scheduleData.horario, (id) => {
    const e = employees.find((x) => x.id === id);
    return e?.condicionesEstructuradas || null;
  }, {
    esIntocable: (id, dia) => {
      const e = employees.find((x) => x.id === id);
      return !!(e?.diasPreferenciaLibre?.[dia] || e?.turnosPorDiaPreferencia?.[dia]);
    },
    // Les mateixes proteccions que la resta: ni la disponibilitat fixa ni la
    // cobertura mínima es trenquen per sincronitzar dues persones.
    potFer: (id, dia, turno) => disponiblePara(employees.find((x) => x.id === id), dia, turno),
    deixaMarge: (id, dia, de, a) => marge(
      scheduleData.horario, employees, rules, employees.find((x) => x.id === id),
    )(dia, de, a),
    canvia: (d, turno) => setShift(d, turno),
  });

  const finalAdjustments = enforceFinalScheduleBounds(scheduleData.horario, employees, rules, festivoDays,
    (employee, day, shift) => disponiblePara(employee, day, shift) && condicionesPermiten(scheduleData.horario, employee, shift));

  // 5l. Last of all, stamp the start and break times. Both are decided here
  // rather than taken from the model, which gave the same week two different
  // break times and left the split shifts our own passes created without one.
  aplicarHorasFijas(scheduleData.horario, employees, establishment);

  // Return before EVERY business write. Simulations cannot replace saved shifts,
  // preferences, absences, rules, reports or published schedules.
  if (draftOnly) {
    const schedules = [];
    for (const e of employees) {
      const proposed = scheduleData.horario.filter(h => h.empleadoId === e.id);
      if (proposed.length !== 1 || proposed[0].dias.length !== 7 || new Set(proposed[0].dias.map(d => d.dia)).size !== 7) throw new Error('La proposta no conté una setmana completa per persona.');
      for (const d of proposed[0].dias) {
        if (!DIAS.includes(d.dia) || !['MANANA', 'TARDE', 'PARTIDO', 'LIBRE'].includes(d.turno)) throw new Error('Torn de la proposta invàlid.');
        const noSplit = requests.some(r => r.employeeId === e.id && r.noSplit);
        const blocked = e.diasAusente[d.dia] || e.diasPreferenciaLibre[d.dia] || festivoDays.includes(d.dia) || e.diasOcupadosOtrosEstablecimientos[d.dia] ||
          !disponiblePara(e, d.dia, d.turno) || (e.turnosPorDiaPreferencia[d.dia] && !['LIBRE', e.turnosPorDiaPreferencia[d.dia]].includes(d.turno)) || (noSplit && d.turno === 'PARTIDO');
        const turno = blocked ? 'LIBRE' : d.turno;
        schedules.push({ empleadoId: e.id, establecimientoId, semana, dia: d.dia, turno,
          horaEntrada: entradaPara(e, turno), horaDescanso: descansoPara(turno, establishment),
          ausencia: e.diasAusente[d.dia] || null, publicado: false,
          empleado: { id: e.id, nombre: e.nombre, apellidos: e.apellidos, funcion: e.funcion, maxHorasSemana: e.maxHorasSemana,
            horasPorTurno: e.horasPorTurno, horaEntradaManana: e.horaEntradaManana, horaEntradaTarde: e.horaEntradaTarde } });
      }
    }
    const review = { ...reviewDraft(schedules, employees, rules, festivoDays, requests, freeRules), adjustments: finalAdjustments };
    return { schedules, establishment: { ...establishment, id: establecimientoId },
      roster: employees.map(e => schedules.find(s => s.empleadoId === e.id).empleado), review,
      // Model commentary is separate from checks on the final grid.
      modelSummary: scheduleData.resumen || '', modelConflicts: scheduleData.conflictos || [] };
  }

  // 6. Save schedules to DB
  const results = [];
  for (const empSchedule of scheduleData.horario) {
    const employee = employees.find((e) => e.id === empSchedule.empleadoId);
    if (!employee) continue;

    for (const dayEntry of empSchedule.dias) {
      const { dia, turno, conflicto, notaConflicto } = dayEntry;
      if (!DIAS.includes(dia)) continue;
      const turnoFinal = turno || 'LIBRE';

      // Delete existing shift for this employee/day/week if any
      await prisma.schedule.deleteMany({
        where: { empleadoId: employee.id, semana, dia },
      });

      const schedule = await prisma.schedule.create({
        data: {
          empleadoId: employee.id,
          establecimientoId,
          semana,
          dia,
          turno: turnoFinal,
          // Standard entry times (07:30 / 14:45) unless this person has their
          // own, which David Castillo does: 8:00 to 12:00 on a 20h contract.
          //
          // This line used to call defaultEntrada and so wrote 07:30 for
          // everybody, discarding what applyCustomEntryTimes had just worked
          // out a few lines above. Fixing the query that loads horaEntradaManana
          // corrected his hours and left his start time exactly as wrong as
          // before, because the value never reached the insert.
          horaEntrada: entradaPara(employee, turnoFinal),
          // Not the model's value: it gave 13:00 to some people and 14:00 to
          // others in the same week, and nothing at all to the split shifts the
          // repair passes created, since setShift clears the field.
          horaDescanso: descansoPara(turnoFinal, establishment),
          generadoPorIa: true,
          // Frozen copy of what we produced. Everything we later claim to have
          // learned is the difference between this and `turno`.
          turnoIa: turnoFinal,
          conflicto: conflicto || false,
          notaConflicto: notaConflicto || null,
        },
        include: {
          empleado: { select: { id: true, nombre: true, apellidos: true, funcion: true, maxHorasSemana: true } },
        },
      });
      results.push(schedule);
    }
  }

  // 7. Persist the manager report (summary + conflicts + notable per-worker changes)
  // Both filters run on the FINAL schedule, after every pass: the model wrote
  // its list about the draft it produced, and the passes have moved things
  // since. A day off is counted among the days the shop opens in an ORDINARY
  // week, so an exceptional closure still counts as one.
  const conflictos = filtrarConflictosYaResueltos(
    filtrarConflictosDeDiasCerrados(scheduleData.conflictos || [], festivoDays),
    scheduleData.horario, employees, diasHabituales,
  );
  // The report is the model's account of its own work, and it was the only
  // part with nothing behind it: in W33 it justified an afternoon with "Nuria
  // Bachs té LIBRE el dimecres", a day off she did not have. Claims the grid
  // denies keep their place and get the truth stapled to them — a
  // justification built on something untrue is what the manager needs to see.
  const { canvis: informeCanvis, avisos } = revisaInforme(
    (scheduleData.informeCanvis || []).filter((x) => x && x.empleadoId),
    scheduleData.horario,
    employees,
  );
  if (avisos.length > 0) {
    console.warn(`[aiScheduler] l'informe afirma ${avisos.length} cosa/es que l'horari desmenteix:`,
      avisos.map((a) => `${a.nom} ${a.dia} diu LIBRE, fa ${a.real}`).join(' · '));
  }
  try {
    await prisma.horarioInforme.upsert({
      where: { establecimientoId_semana: { establecimientoId, semana } },
      update: { resumen: scheduleData.resumen || '', conflictos: JSON.stringify(conflictos), informeCanvis: JSON.stringify(informeCanvis) },
      create: { establecimientoId, semana, resumen: scheduleData.resumen || '', conflictos: JSON.stringify(conflictos), informeCanvis: JSON.stringify(informeCanvis) },
    });
  } catch (err) {
    console.error('[aiScheduler] no se pudo guardar el informe:', err.message);
  }

  return {
    schedules: results,
    conflictos,
    resumen: scheduleData.resumen || '',
    informeCanvis,
  };
}

// ─────────────────────────────────────────────
// Force LIBRE on days when visitor is already working in another establishment
// ─────────────────────────────────────────────
function forceCrossEstablishmentLibre(horario, employees) {
  for (const empSched of horario) {
    const emp = employees.find((e) => e.id === empSched.empleadoId);
    if (!emp || !emp.diasOcupadosOtrosEstablecimientos) continue;

    for (const d of empSched.dias) {
      if (emp.diasOcupadosOtrosEstablecimientos[d.dia]) {
        // This day is already worked elsewhere → force LIBRE in THIS establishment
        setShift(d, 'LIBRE');
      }
    }
  }
}

// ─────────────────────────────────────────────
// Force LIBRE for everyone on closed days (festivos + weekly closed days).
// Runs LAST so no repair pass can re-assign a shift on a closed day.
// ─────────────────────────────────────────────
function forceClosedDays(horario, closedDays) {
  if (!closedDays || closedDays.length === 0) return;
  for (const empSched of horario) {
    for (const d of empSched.dias) {
      if (closedDays.includes(d.dia) && d.turno !== 'LIBRE') {
        setShift(d, 'LIBRE');
      }
    }
  }
}

// ─────────────────────────────────────────────
// Force LIBRE on days with an approved absence (vacaciones / baja).
// Hard guarantee — the AI is told about absences, but this makes it impossible
// to schedule an absent employee even if it (or a repair pass) tries.
// ─────────────────────────────────────────────
function forceAbsenceDays(horario, employees) {
  for (const empSched of horario) {
    const emp = employees.find((e) => e.id === empSched.empleadoId);
    if (!emp || Object.keys(emp.diasAusente || {}).length === 0) continue;
    for (const d of empSched.dias) {
      if (emp.diasAusente[d.dia] && d.turno !== 'LIBRE') setShift(d, 'LIBRE');
    }
  }
}

// ─────────────────────────────────────────────
// Force LIBRE on the days an employee asked off in their weekly preferences.
// Without this, the hour-topping repair passes fill those days back in when the
// employee ends up below their contracted hours — silently ignoring what they
// asked for. Coverage minimums are satisfied earlier with other employees.
// ─────────────────────────────────────────────
function forcePreferenceDaysOff(horario, employees) {
  for (const empSched of horario) {
    const emp = employees.find((e) => e.id === empSched.empleadoId);
    if (!emp || Object.keys(emp.diasPreferenciaLibre || {}).length === 0) continue;
    for (const d of empSched.dias) {
      if (emp.diasPreferenciaLibre[d.dia] && d.turno !== 'LIBRE') setShift(d, 'LIBRE');
    }
  }
}

// ─────────────────────────────────────────────
// WHERE THE DAYS OFF GO
//
// Two reasons to move one, and deliberately one pass rather than two: separate
// passes pulling the same lever for different motives undo each other's work.
//
//   1. The shop is short-staffed that day and this person could cover it.
//   2. It is a Friday or a Saturday — the busiest days in a butcher's — and
//      nobody asked for it.
//
// Reason 1 first: a shortfall is a shop with too few people behind the
// counter, which beats a preference about which day is quiet.
//
// The move is a swap: the shift travels from the giving day to the receiving
// one, so every total a person's conditions are measured by is untouched —
// same mornings, afternoons, split shifts and days off. Only the calendar
// position changes.
//
// It never touches a day off somebody asked for, a day they are absent, a day
// they work elsewhere, or a day the shop is shut. Both halves are checked
// against coverage before either is applied, and the person's own conditions
// are re-checked afterwards: a swap that would break one is not made.
//
// Nuria Bachs in 2026-W34 is the case it was written for. Thursday wanted six
// sales staff and had five; Monday allows six to eight and had seven. Her day
// off moved from Thursday to Monday: both days inside their rule, her hours,
// her five mornings and her single day off all unchanged.
// ─────────────────────────────────────────────
const DIES_CARREGATS = ['VIERNES', 'SABADO', 'DOMINGO'];

/** How short a day is on one half, for one function. 0 when it is covered. */
function faltaGent(horario, employees, rules, dia, funcion, half) {
  const rule = getRuleForDay(rules, dia);
  if (!rule) return 0;
  const min = funcion === 'DEPENDIENTA'
    ? (half === 'MANANA' ? rule.minDependientasManana : rule.minDependientasTarde)
    : (half === 'MANANA' ? rule.minElaboracionManana : rule.minElaboracionTarde);
  return Math.max(0, (min || 0) - countForDay(horario, employees, dia, funcion, half));
}

/**
 * How many fixed conditions this person's week breaks right now.
 *
 * Used to refuse a swap that would trade a coverage gap for a broken
 * condition — the conditionals ("si el dissabte fa MATÍ, el divendres fa
 * PARTIDO") are the ones at risk, because they are the only family that cares
 * which day a shift lands on.
 */
function problemesDe(horario, employees, emp, diasHabituales) {
  const sched = horario.find((h) => h.empleadoId === emp.id);
  if (!sched) return 0;
  const companys = horario
    .filter((h) => h.empleadoId !== emp.id)
    .map((h) => ({ empleado: employees.find((e) => e.id === h.empleadoId), dias: h.dias }))
    .filter((c) => c.empleado);
  return checkEmployeeConditions({
    empleado: emp, dias: sched.dias, diasHabituales, companys,
  }).problemas.length;
}

/** A day off this person did not ask for and nothing else forces. */
function festaMovible(emp, dia, oberts) {
  if (!oberts.has(dia)) return false;                      // shut: not a day off
  if (emp.diasPreferenciaLibre?.[dia]) return false;       // they asked for it
  if (emp.diasAusente?.[dia]) return false;
  if (emp.diasOcupadosOtrosEstablecimientos?.[dia]) return false;
  return true;
}

export function recolocarFestes(horario, employees, rules, festivoDays = [], diasHabituales = DIAS) {
  const tancats = new Set(festivoDays);
  const oberts = new Set(DIAS.filter((d) => !tancats.has(d)));

  for (const empSched of horario) {
    const emp = employees.find((e) => e.id === empSched.empleadoId);
    if (!emp) continue;

    const festes = empSched.dias
      .filter((d) => d.turno === 'LIBRE' && festaMovible(emp, d.dia, oberts))
      .map((d) => d.dia);
    if (festes.length === 0) continue;

    // Reason 1 before reason 2, and within each the shortfall that is worst.
    const candidats = festes
      .map((dia) => ({
        dia,
        falta: Math.max(
          faltaGent(horario, employees, rules, dia, emp.funcion, 'MANANA'),
          faltaGent(horario, employees, rules, dia, emp.funcion, 'TARDE'),
        ),
        carregat: DIES_CARREGATS.includes(dia),
      }))
      .filter((c) => c.falta > 0 || c.carregat)
      .sort((a, b) => (b.falta - a.falta) || (b.carregat - a.carregat));

    for (const { dia } of candidats) {
      const rep = empSched.dias.find((d) => d.dia === dia);
      if (!rep || rep.turno !== 'LIBRE') continue;

      for (const donant of empSched.dias) {
        if (donant.dia === dia || donant.turno === 'LIBRE') continue;
        if (!oberts.has(donant.dia)) continue;
        // Never take the shift off a Friday or a Saturday to fill another day:
        // that only moves the day off onto the busiest day, which is the thing
        // this pass exists to prevent.
        if (DIES_CARREGATS.includes(donant.dia)) continue;
        const torn = donant.turno;

        // Different days, so neither half affects the other's coverage: both
        // can be judged against the schedule as it stands.
        if (!cambioPermitido(horario, employees, rules, emp, empSched, dia, 'LIBRE', torn)) continue;
        if (!cambioPermitido(horario, employees, rules, emp, empSched, donant.dia, torn, 'LIBRE')) continue;

        const abans = problemesDe(horario, employees, emp, diasHabituales);
        setShift(rep, torn);
        setShift(donant, 'LIBRE');
        if (problemesDe(horario, employees, emp, diasHabituales) > abans) {
          setShift(rep, 'LIBRE');       // undo: a covered counter is not worth a broken condition
          setShift(donant, torn);
          continue;
        }
        break;
      }
    }
  }
}

// ─────────────────────────────────────────────
// THE SATURDAY ROTATION, MADE TO HOLD
//
// Whoever worked a Saturday morning does the afternoon or the split next time,
// and after a split comes the morning. It lived only in the prompt, and across
// the four weeks on record it held five Saturdays in thirteen.
//
// It cannot be fixed one person at a time. Girona's Saturday rule is exact —
// seven in the morning, five in the afternoon — so any single change breaks it
// and would be refused. The fixes only work in combination: somebody moving
// off the morning has to be matched by somebody moving onto it.
//
// And a split shift counts on BOTH halves at once, which is what makes the
// arithmetic worth searching rather than guessing: moving a morning to a split
// does not take anybody off the morning, it only adds to the afternoon.
//
// So: enumerate the changes that would leave each person compliant with the
// rotation, try them in pairs and triples, keep the ones that leave every
// function and both halves inside their rule, and accept the best only if the
// total number of broken rules actually falls. Anything it cannot fix stays
// for the panel to report — a Saturday where the rotation and the coverage
// genuinely cannot both hold is a fact about the week, not a bug.
// ─────────────────────────────────────────────

/** Every function and half of one day, inside its rule. */
function coberturaCorrecta(horario, employees, rules, dia) {
  const rule = getRuleForDay(rules, dia);
  if (!rule) return true;
  const limits = {
    DEPENDIENTA: { MANANA: [rule.minDependientasManana, rule.maxDependientasManana ?? 99],
      TARDE: [rule.minDependientasTarde, rule.maxDependientasTarde ?? 99] },
    ELABORACION: { MANANA: [rule.minElaboracionManana, rule.maxElaboracionManana ?? 99],
      TARDE: [rule.minElaboracionTarde, rule.maxElaboracionTarde ?? 99] },
  };
  for (const funcion of ['DEPENDIENTA', 'ELABORACION']) {
    for (const half of ['MANANA', 'TARDE']) {
      const [min, max] = limits[funcion][half];
      const n = countForDay(horario, employees, dia, funcion, half);
      if (n < (min || 0) || n > max) return false;
    }
  }
  return true;
}

/** How many rules the whole week breaks, rotation included. */
function problemesTotals(horario, employees, diasHabituales, ultimsDissabtes) {
  let n = 0;
  for (const empSched of horario) {
    const emp = employees.find((e) => e.id === empSched.empleadoId);
    if (!emp) continue;
    const companys = horario
      .filter((h) => h.empleadoId !== emp.id)
      .map((h) => ({ empleado: employees.find((e) => e.id === h.empleadoId), dias: h.dias }))
      .filter((c) => c.empleado);
    n += checkEmployeeConditions({ empleado: emp, dias: empSched.dias, diasHabituales, companys }).problemas.length;
    const ds = empSched.dias.find((d) => d.dia === 'SABADO');
    if (ds && !alternancaCompleix(ultimsDissabtes?.[emp.id], ds.turno)) n++;
  }
  return n;
}

/**
 * `ultimsDissabtes` maps employeeId → the shift of the last Saturday they
 * actually worked. A Saturday the shop was shut carries the turn over, so it
 * is not always last week's.
 */
export function ajustarAlternancaDissabtes(horario, employees, rules, ultimsDissabtes = {}, festivoDays = [], diasHabituales = DIAS) {
  if ((festivoDays || []).includes('SABADO')) return;

  const base = problemesTotals(horario, employees, diasHabituales, ultimsDissabtes);

  // Every change that would leave that person compliant with the rotation and
  // that their own availability and conditions allow.
  const opcions = [];
  for (const empSched of horario) {
    const emp = employees.find((e) => e.id === empSched.empleadoId);
    if (!emp) continue;
    const ds = empSched.dias.find((d) => d.dia === 'SABADO');
    if (!ds || ds.turno === 'LIBRE') continue;
    if (emp.diasPreferenciaLibre?.SABADO || emp.turnosPorDiaPreferencia?.SABADO) continue;
    if (emp.diasAusente?.SABADO || emp.diasOcupadosOtrosEstablecimientos?.SABADO) continue;
    for (const nou of ['MANANA', 'TARDE', 'PARTIDO']) {
      if (nou === ds.turno) continue;
      if (!alternancaCompleix(ultimsDissabtes[emp.id], nou)) continue;
      if (!disponiblePara(emp, 'SABADO', nou)) continue;
      if (nou === 'PARTIDO') {
        if (jornadaReducida(emp)) continue;
        if (emp.condParsed?.partidosNoConsecutivos && partidoSeriaConsecutivo(empSched, 'SABADO')) continue;
      }
      opcions.push({ ds, de: ds.turno, a: nou, empId: emp.id });
    }
  }
  if (opcions.length === 0) return;

  const aplica = (combo, cap) => combo.forEach((c) => { c.ds.turno = cap ? c.a : c.de; });
  let millor = null;

  const prova = (combo) => {
    aplica(combo, true);
    const val = coberturaCorrecta(horario, employees, rules, 'SABADO')
      ? problemesTotals(horario, employees, diasHabituales, ultimsDissabtes)
      : null;
    aplica(combo, false);
    if (val == null || val >= base) return;
    // Fewer people moved wins a tie: two solutions that leave the same number
    // of rules broken are not equally good if one churns three rotas and the
    // other two.
    const guanya = !millor || val < millor.val
      || (val === millor.val && combo.length < millor.combo.length);
    if (guanya) millor = { combo: [...combo], val };
  };

  // Pairs and triples: a single change cannot balance an exact rule, and
  // beyond three the search stops paying for itself.
  for (let i = 0; i < opcions.length; i++) {
    for (let j = i + 1; j < opcions.length; j++) {
      if (opcions[i].empId === opcions[j].empId) continue;
      prova([opcions[i], opcions[j]]);
      for (let k = j + 1; k < opcions.length; k++) {
        if (opcions[k].empId === opcions[i].empId || opcions[k].empId === opcions[j].empId) continue;
        prova([opcions[i], opcions[j], opcions[k]]);
      }
    }
  }

  if (millor) millor.combo.forEach((c) => setShift(c.ds, c.a));
}

// ─────────────────────────────────────────────
// COVERING A GAP WITH A SPLIT SHIFT
//
// The pass that fills a shortfall looks for somebody free that day and
// assigns them. On the Saturday of 2026-W34 nobody was free — the whole shop
// worked it, two people were off sick, and the morning was still one short of
// the seven the rule demands. With no candidate the pass gave up and left the
// gap.
//
// What never occurred to it was to make a shift already there cover more. A
// split shift counts on both halves at once, so turning one afternoon into one
// split closed the morning without adding a soul. Manuel Campistol, who has no
// fixed conditions, went from 36h to the 40 of his contract.
//
// The engine does promote a shift to a split — but only ever to satisfy the
// employee's own conditions ("fa 2 torns PARTIDO per setmana"), never to cover
// the shop.
// ─────────────────────────────────────────────
export function cobrirAmbPartits(horario, employees, rules, festivoDays = [], diasHabituales = DIAS) {
  const tancats = new Set(festivoDays);
  const CONTRARI = { MANANA: 'TARDE', TARDE: 'MANANA' };

  for (const dia of DIAS) {
    if (tancats.has(dia)) continue;
    for (const funcion of ['DEPENDIENTA', 'ELABORACION']) {
      for (const half of ['MANANA', 'TARDE']) {
        // Recomputed each round: one split shift may close the gap on its own.
        while (faltaGent(horario, employees, rules, dia, funcion, half) > 0) {
          const abansFalta = faltaGent(horario, employees, rules, dia, funcion, half);
          let fet = false;

          for (const empSched of horario) {
            const emp = employees.find((e) => e.id === empSched.empleadoId);
            if (!emp || emp.funcion !== funcion) continue;
            const d = empSched.dias.find((x) => x.dia === dia);
            if (!d || d.turno !== CONTRARI[half]) continue;   // must already cover the other half
            if (!cambioPermitido(horario, employees, rules, emp, empSched, dia, d.turno, 'PARTIDO')) continue;

            const abans = problemesDe(horario, employees, emp, diasHabituales);
            const previ = d.turno;
            setShift(d, 'PARTIDO');
            if (problemesDe(horario, employees, emp, diasHabituales) > abans) {
              setShift(d, previ);
              continue;
            }
            fet = true;
            break;
          }

          // Nobody left who can, or the change did not help: stop rather than
          // spin. The gap goes to the conflicts panel, which is what it is for.
          if (!fet) break;
          if (faltaGent(horario, employees, rules, dia, funcion, half) >= abansFalta) break;
        }
      }
    }
  }
}

// ─────────────────────────────────────────────
// A reduced working day can never be a split shift.
//
// PARTIDO covers morning and afternoon, so giving one to somebody on a 20h
// contract doubles their day into more than a full-timer's. The prompt says so
// and the coverage pass refuses it, but this is the guarantee: prompts are
// followed almost always, and "almost" is how a part-timer ends up rostered for
// ten hours.
// ─────────────────────────────────────────────
// Applies each employee's own start time. Done as a final sweep rather than
// threaded through setShift, which is called from a dozen places and would have
// to carry the employee everywhere just for a cosmetic field.
function aplicarHorasFijas(horario, employees, establishment) {
  for (const empSched of horario) {
    const emp = employees.find((e) => e.id === empSched.empleadoId);
    for (const d of empSched.dias) {
      if (d.turno === 'LIBRE') {
        d.horaEntrada = null;
        d.horaDescanso = null;
        continue;
      }
      d.horaEntrada = entradaPara(emp, d.turno);
      d.horaDescanso = descansoPara(d.turno, establishment);
    }
  }
}

/**
 * Un canvi deixaria el dia sense prou gent?
 *
 * Se'n fa UNA PER PERSONA: mira la cobertura de la SEVA funció. Viu aquí i no
 * dins de cada passada perquè les dues que la necessiten —les condicions d'un
 * en un i la sincronització— no puguin acabar comprovant coses diferents.
 */
function marge(horario, employees, rules, emp) {
  return (dia, de, a) => {
    const rule = getRuleForDay(rules, dia);
    if (!rule) return true;
    for (const slot of ['MANANA', 'TARDE']) {
      const hiEra = slot === 'MANANA' ? ['MANANA', 'PARTIDO'].includes(de) : ['TARDE', 'PARTIDO'].includes(de);
      const hiSera = slot === 'MANANA' ? ['MANANA', 'PARTIDO'].includes(a) : ['TARDE', 'PARTIDO'].includes(a);
      if (!hiEra || hiSera) continue;   // no en treu ningú d'aquest tram
      const min = slot === 'MANANA'
        ? (emp.funcion === 'DEPENDIENTA' ? rule.minDependientasManana : rule.minElaboracionManana)
        : (emp.funcion === 'DEPENDIENTA' ? rule.minDependientasTarde : rule.minElaboracionTarde);
      if (countForDay(horario, employees, dia, emp.funcion, slot) <= (min ?? 0)) return false;
    }
    return true;
  };
}

/**
 * Fa complir les condicions fixes de cada persona.
 *
 * La feina de decidir QUÈ canviar és a passadesCondicions.js, que és pur i es
 * prova sol. Aquí es lliga amb el món: qui té condicions traduïdes, què no es
 * pot tocar, i si un canvi deixaria el dia sense prou gent.
 *
 * Un canvi que baixés un torn per sota del mínim NO es fa. Ho va decidir el
 * Roger el 21 d'agost veient el preu amb la setmana del 24: complir-les del tot
 * deixava tres tardes per sota, perquè els PARTIDO que es treien eren els que
 * les tapaven. La condició es queda sense complir i surt avisada al panell, com
 * ja passa amb l'alternança dels dissabtes: no decideix la màquina.
 */
function aplicaCondicionsFixes(horario, employees, rules, festivoDays = []) {
  for (const empSched of horario) {
    const emp = employees.find((e) => e.id === empSched.empleadoId);
    const cond = emp?.condicionesEstructuradas;
    if (!cond || typeof cond !== 'object') continue;

    // El que mana més que la condició i que aquí no es toca. Les absències i
    // els dies tancats ja han deixat el dia a LIBRE, i els dies lliures no es
    // toquen mai; queden les peticions d'aquesta setmana.
    const demanats = new Set([
      ...(emp.diasPreferenciaLibre ? Object.keys(emp.diasPreferenciaLibre) : []),
      ...Object.keys(emp.turnosPorDiaPreferencia || {}),
    ]);

    const fets = aplicaAUnaPersona(empSched.dias, cond, {
      esIntocable: (dia) => demanats.has(dia),
      potFer: (dia, turno) => disponiblePara(emp, dia, turno),
      deixaMarge: marge(horario, employees, rules, emp),
      // Si el dia és seu de debò. Fa falta per a «no fa festa entre setmana»,
      // l'única condició que s'omple AFEGINT un torn: un dia de baixa o amb la
      // botiga tancada també és LIBRE, i des de la passada no es distingeixen.
      // Posar-lo a treballar un d'aquells seria pitjor que la condició.
      // Els tres motius pels quals un dia LIBRE no és seu. El tercer se'm va
      // escapar i és el que més mal faria: qui aquell dia ja treballa a una
      // altra botiga quedaria compromès dues vegades alhora. A la resta del
      // fitxer els dos primers van sempre junts amb aquest.
      potTreballar: (dia) => !emp.diasAusente?.[dia]
        && !emp.diasOcupadosOtrosEstablecimientos?.[dia]
        && !festivoDays.includes(dia),
      canvia: (d, turno) => setShift(d, turno),
    });

    if (fets.fets.length > 0) {
      console.log(`[Condicions] ${emp.nombre} ${emp.apellidos}: `
        + fets.fets.map((f) => `${f.dia.slice(0, 3)} ${f.de}→${f.a}`).join(', ')
        + ` (incompliment ${fets.abans}→${fets.despres})`);
    }
  }
}

function forceNoPartidoOnReduced(horario, employees) {
  for (const empSched of horario) {
    const emp = employees.find((e) => e.id === empSched.empleadoId);
    if (!emp || !jornadaReducida(emp)) continue;
    for (const d of empSched.dias) {
      if (d.turno === 'PARTIDO') setShift(d, 'MANANA');
    }
  }
}

// ─────────────────────────────────────────────
// Force the specific half-shift an employee asked for on a given day
// ("Wednesday I can only do afternoons" → TARDE, never PARTIDO).
// This has to be deterministic: PARTIDO covers both halves, so a model asked to
// "respect the afternoon request" can satisfy it literally with a full day and
// leave the person with no morning off at all — which is the opposite of what
// they asked. Runs with the other hard guarantees, after the hour-topping passes.
// ─────────────────────────────────────────────
function forceShiftRestrictions(horario, employees) {
  for (const empSched of horario) {
    const emp = employees.find((e) => e.id === empSched.empleadoId);
    const restricciones = emp?.turnosPorDiaPreferencia;
    if (!restricciones || Object.keys(restricciones).length === 0) continue;
    for (const d of empSched.dias) {
      const requerido = restricciones[d.dia];
      if (!requerido) continue;
      // LIBRE is left alone: not working at all never violates "only afternoons".
      if (d.turno === 'LIBRE') continue;
      if (d.turno !== requerido) setShift(d, requerido);
    }
  }
}

// Parse the fixed-availability JSON grid. Returns { LUNES: {M,T}, ... } or null.
function parseDisponibilidad(str) {
  if (!str) return null;
  try {
    const obj = JSON.parse(str);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Enforce each employee's FIXED weekly availability (hard constraint).
// A worker with M:false on a day can never work that morning, etc. Runs late so
// no shift survives on a slot the worker can never do. Keeps them working on the
// allowed half when possible; otherwise LIBRE.
// ─────────────────────────────────────────────
function enforceAvailability(horario, employees) {
  for (const empSched of horario) {
    const emp = employees.find((e) => e.id === empSched.empleadoId);
    const disp = emp?.dispParsed;
    if (!disp) continue;
    for (const d of empSched.dias) {
      const slot = disp[d.dia];
      if (!slot) continue;
      const canM = slot.M !== false;
      const canT = slot.T !== false;
      if (d.turno === 'MANANA' && !canM) setShift(d, canT ? 'TARDE' : 'LIBRE');
      else if (d.turno === 'TARDE' && !canT) setShift(d, canM ? 'MANANA' : 'LIBRE');
      else if (d.turno === 'PARTIDO' && !(canM && canT)) {
        setShift(d, canM ? 'MANANA' : canT ? 'TARDE' : 'LIBRE');
      }
    }
  }
}

// ─────────────────────────────────────────────
// Incompatible pairs — parse free text rules and enforce
// ─────────────────────────────────────────────

// Normalize a string for matching: lowercase, strip accents, trim
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// Parse free text rules to detect incompatible pairs like:
//   "Diego y Lucía no pueden trabajar juntos"
//   "Diego no puede trabajar con Lucía"
//   "Diego Ortega y Lucía Romero no pueden coincidir"
// Returns array of { aId, bId } employee id pairs.
function parseIncompatiblePairs(freeRules, employees) {
  const pairs = [];
  if (!freeRules || freeRules.length === 0) return pairs;

  // Build a lookup: normalized name/first-name → employee
  const byFirstName = {};
  const byFullName = {};
  for (const emp of employees) {
    const first = normalize(emp.nombre);
    const full = normalize(`${emp.nombre} ${emp.apellidos}`);
    if (!byFirstName[first]) byFirstName[first] = [];
    byFirstName[first].push(emp);
    byFullName[full] = emp;
  }

  function findEmployee(nameText) {
    const n = normalize(nameText);
    if (!n) return null;
    if (byFullName[n]) return byFullName[n];
    // Try first-name match
    const candidates = byFirstName[n.split(' ')[0]];
    if (candidates && candidates.length === 1) return candidates[0];
    // Try substring match on full name
    for (const emp of employees) {
      const full = normalize(`${emp.nombre} ${emp.apellidos}`);
      if (full.includes(n) || n.includes(full)) return emp;
    }
    return null;
  }

  // Patterns that indicate incompatibility
  const incompatibleKeywords = [
    /no\s+pueden\s+trabajar\s+juntos/i,
    /no\s+pueden\s+coincidir/i,
    /no\s+pueden\s+estar\s+juntos/i,
    /no\s+puede\s+trabajar\s+con/i,
    /no\s+puede\s+coincidir\s+con/i,
    /no\s+puede\s+estar\s+con/i,
    /no\s+coinciden/i,
  ];

  for (const rule of freeRules) {
    const text = rule.texto || '';
    const isIncompatibleRule = incompatibleKeywords.some((re) => re.test(text));
    if (!isIncompatibleRule) continue;

    // Extract names: try to find two employee names mentioned in the text
    const mentioned = [];
    for (const emp of employees) {
      const first = normalize(emp.nombre);
      const full = normalize(`${emp.nombre} ${emp.apellidos}`);
      const normText = normalize(text);
      if (normText.includes(full)) {
        mentioned.push(emp);
      } else if (normText.includes(first)) {
        // Only add first-name match if unambiguous
        const sameFirst = employees.filter((e) => normalize(e.nombre) === first);
        if (sameFirst.length === 1) mentioned.push(emp);
      }
    }
    // Deduplicate by id
    const unique = [];
    for (const e of mentioned) {
      if (!unique.find((u) => u.id === e.id)) unique.push(e);
    }

    // Create pairs for every combination (usually just 2 people)
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        pairs.push({ aId: unique[i].id, bId: unique[j].id });
      }
    }
  }

  return pairs;
}

// Check if two shifts overlap. PARTIDO overlaps with everything non-LIBRE.
function shiftsOverlap(a, b) {
  if (a === 'LIBRE' || b === 'LIBRE') return false;
  if (a === 'PARTIDO' || b === 'PARTIDO') return true; // PARTIDO covers whole day
  return a === b; // MANANA+MANANA or TARDE+TARDE
}

// Fix incompatible pair conflicts by modifying one of the two shifts each day they overlap
function enforceIncompatiblePairs(horario, employees, freeRules, rules) {
  const pairs = parseIncompatiblePairs(freeRules, employees);
  if (pairs.length === 0) return;

  for (const { aId, bId } of pairs) {
    const aSched = horario.find((h) => h.empleadoId === aId);
    const bSched = horario.find((h) => h.empleadoId === bId);
    if (!aSched || !bSched) continue;

    const aEmp = employees.find((e) => e.id === aId);
    const bEmp = employees.find((e) => e.id === bId);
    if (!aEmp || !bEmp) continue;

    for (const dia of DIAS) {
      const aDay = aSched.dias.find((d) => d.dia === dia);
      const bDay = bSched.dias.find((d) => d.dia === dia);
      if (!aDay || !bDay) continue;
      if (!shiftsOverlap(aDay.turno, bDay.turno)) continue;

      // They overlap — we need to fix it.
      // Strategy:
      //   1. If one has PARTIDO, split them: PARTIDO → MANANA, other → TARDE (or vice versa)
      //   2. If both have same simple shift (e.g. both MANANA), move one to opposite shift
      //   3. If no room in opposite shift, set one to LIBRE (the one with more hours)

      // Decide which to keep in place (the one with more hours gets reduced first)
      const aHours = getWeekHours(horario, aId, employees);
      const bHours = getWeekHours(horario, bId, employees);
      const [keep, change] = aHours <= bHours
        ? [{ entry: aDay, emp: aEmp }, { entry: bDay, emp: bEmp }]
        : [{ entry: bDay, emp: bEmp }, { entry: aDay, emp: aEmp }];

      // Case 1: The "change" one has PARTIDO → turn it into the opposite of "keep"
      if (change.entry.turno === 'PARTIDO') {
        if (keep.entry.turno === 'MANANA') {
          setShift(change.entry, 'TARDE');
        } else if (keep.entry.turno === 'TARDE') {
          setShift(change.entry, 'MANANA');
        } else {
          // keep also has PARTIDO → change becomes MANANA, keep becomes TARDE
          setShift(change.entry, 'MANANA');
          setShift(keep.entry, 'TARDE');
        }
        continue;
      }

      // Case 2: The "keep" has PARTIDO but change doesn't
      if (keep.entry.turno === 'PARTIDO') {
        // change must go LIBRE or swap keep to half-shift
        // Try: turn keep into MANANA, put change into TARDE
        const oppositeSlot = 'TARDE';
        const rule = rules && rules.length > 0 ? getRuleForDay(rules, dia) : null;
        const oppMax = rule
          ? (change.emp.funcion === 'DEPENDIENTA' ? (rule.maxDependientasTarde ?? 99) : (rule.maxElaboracionTarde ?? 99))
          : 99;
        const oppCount = countForDay(horario, employees, dia, change.emp.funcion, oppositeSlot);
        if (oppCount < oppMax) {
          setShift(keep.entry, 'MANANA');
          setShift(change.entry, 'TARDE');
        } else {
          setShift(change.entry, 'LIBRE');
        }
        continue;
      }

      // Case 3: Both have simple shifts (MANANA+MANANA or TARDE+TARDE)
      // Move "change" to opposite shift if room, otherwise LIBRE
      const currentShift = change.entry.turno;
      const opposite = currentShift === 'MANANA' ? 'TARDE' : 'MANANA';
      const oppSlot = opposite; // same as shift name for simple shifts
      const rule = rules && rules.length > 0 ? getRuleForDay(rules, dia) : null;
      const oppMax = rule
        ? (opposite === 'MANANA'
            ? (change.emp.funcion === 'DEPENDIENTA' ? (rule.maxDependientasManana ?? 99) : (rule.maxElaboracionManana ?? 99))
            : (change.emp.funcion === 'DEPENDIENTA' ? (rule.maxDependientasTarde ?? 99) : (rule.maxElaboracionTarde ?? 99)))
        : 99;
      const oppCount = countForDay(horario, employees, dia, change.emp.funcion, oppSlot);

      if (oppCount < oppMax) {
        setShift(change.entry, opposite);
      } else {
        setShift(change.entry, 'LIBRE');
      }
    }
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

// `employees` is needed because a reduced-day worker's shift is not 7h/6h.
// Passing it everywhere is noisier than a bare lookup, but the alternative is
// counting a 4h morning as 7h, which silently corrupts every hours check.
function getWeekHours(horario, empId, employees) {
  const empSchedule = horario.find((h) => h.empleadoId === empId);
  if (!empSchedule) return 0;
  const emp = employees?.find((e) => e.id === empId) || null;
  return empSchedule.dias.reduce((sum, d) => sum + shiftHours(emp, d.turno), 0);
}

// ─────────────────────────────────────────────
// REACHING A COUNT SOMEBODY IS OWED
//
// Everything built so far is a prohibition: don't give this person that shift.
// Some conditions are the opposite — an obligation to reach a number. Albert
// Triano does exactly two split shifts a week; Eva Mademont splits hers into
// three mornings and three afternoons. Nothing pushed towards those totals, so
// one short simply stayed one short, and a pass that moved somebody for
// coverage could quietly undo a total that had been right.
//
// Runs last, once coverage and every restriction have settled, and only makes a
// change that leaves all of them intact — so it can add what is missing without
// breaking what already worked.
// ─────────────────────────────────────────────

/** Whether a day's coverage still fits its rule after a change of ±1 per half. */
function coberturaAguanta(horario, employees, rules, dia, funcion, delta) {
  const rule = getRuleForDay(rules, dia);
  if (!rule) return true;
  const limites = funcion === 'DEPENDIENTA'
    ? { MANANA: [rule.minDependientasManana, rule.maxDependientasManana ?? 99],
      TARDE: [rule.minDependientasTarde, rule.maxDependientasTarde ?? 99] }
    : { MANANA: [rule.minElaboracionManana, rule.maxElaboracionManana ?? 99],
      TARDE: [rule.minElaboracionTarde, rule.maxElaboracionTarde ?? 99] };
  for (const half of ['MANANA', 'TARDE']) {
    const [min, max] = limites[half];
    const after = countForDay(horario, employees, dia, funcion, half) + (delta[half] || 0);
    if (after < min || after > max) return false;
  }
  return true;
}

/** How each half of a day changes when one person moves between shift types. */
function deltaCobertura(de, a) {
  const peso = (t) => ({ MANANA: { MANANA: 1, TARDE: 0 }, TARDE: { MANANA: 0, TARDE: 1 },
    PARTIDO: { MANANA: 1, TARDE: 1 }, LIBRE: { MANANA: 0, TARDE: 0 } }[t] || { MANANA: 0, TARDE: 0 });
  const antes = peso(de);
  const despues = peso(a);
  return { MANANA: despues.MANANA - antes.MANANA, TARDE: despues.TARDE - antes.TARDE };
}

/** Split shifts on adjacent days, for the people whose rule forbids exactly that. */
function partidoSeriaConsecutivo(empSched, dia) {
  const i = DIAS.indexOf(dia);
  return [i - 1, i + 1].some((j) => {
    if (j < 0 || j >= DIAS.length) return false;
    const d = empSched.dias.find((x) => x.dia === DIAS[j]);
    return d?.turno === 'PARTIDO';
  });
}

/** Whether this one person may be switched from one shift to another on a day. */
function cambioPermitido(horario, employees, rules, emp, empSched, dia, de, a) {
  if (de === a) return false;
  if (emp.diasAusente?.[dia] || emp.diasOcupadosOtrosEstablecimientos?.[dia]) return false;
  if (emp.diasPreferenciaLibre?.[dia]) return false;
  if (emp.turnosPorDiaPreferencia?.[dia]) return false; // asked for one half only
  if (!disponiblePara(emp, dia, a)) return false;
  if (a === 'PARTIDO') {
    if (jornadaReducida(emp)) return false;
    if (emp.condParsed?.partidosNoConsecutivos && partidoSeriaConsecutivo(empSched, dia)) return false;
  }
  return coberturaAguanta(horario, employees, rules, dia, emp.funcion, deltaCobertura(de, a));
}

/**
 * Brings each person towards the totals their conditions require, one change at
 * a time, re-counting after each. Conservative by construction: a change that
 * would break coverage, availability or another condition is simply not made,
 * and the shortfall is left for the conflict panel to report.
 */
export function honrarRecuentosExactos(horario, employees, rules) {
  for (const empSched of horario) {
    const emp = employees.find((e) => e.id === empSched.empleadoId);
    const cond = emp?.condParsed;
    if (!cond) continue;
    if (cond.partidosExactos == null && cond.mananasExactas == null && cond.tardesExactas == null) continue;

    const dobles = !!cond.partidoCuentaComoAmbos;
    for (let intento = 0; intento < 8; intento++) {
      const c = contarTurnos(empSched.dias);
      const mananas = c.mananas + (dobles ? c.partidos : 0);
      const tardes = c.tardes + (dobles ? c.partidos : 0);
      let cambio = false;

      // Short of split shifts: promote a single one, preferring the day that
      // upsets the least — one already at its coverage minimum on the other half
      // is checked by cambioPermitido anyway.
      if (!cambio && cond.partidosExactos != null && c.partidos < cond.partidosExactos) {
        for (const d of empSched.dias) {
          if (d.turno !== 'MANANA' && d.turno !== 'TARDE') continue;
          if (!turnoPermitido(cond, 'PARTIDO', contarTurnos(empSched.dias))) break;
          if (!cambioPermitido(horario, employees, rules, emp, empSched, d.dia, d.turno, 'PARTIDO')) continue;
          setShift(d, 'PARTIDO');
          cambio = true;
          break;
        }
      }

      // Short of one half and long of the other: turn one into the other. Only
      // ever moves a shift that already exists, so the person's days and hours
      // stay roughly where they were.
      const faltaManana = cond.mananasExactas != null && mananas < cond.mananasExactas;
      const sobraTarde = cond.tardesExactas != null && tardes > cond.tardesExactas;
      if (!cambio && faltaManana && (sobraTarde || cond.tardesExactas == null)) {
        for (const d of empSched.dias) {
          if (d.turno !== 'TARDE') continue;
          if (!cambioPermitido(horario, employees, rules, emp, empSched, d.dia, 'TARDE', 'MANANA')) continue;
          setShift(d, 'MANANA');
          cambio = true;
          break;
        }
      }

      // Short of one half while the other is already exactly right. Converting
      // a shift would only move the shortage across; a split shift adds the
      // missing half without giving up the one that is correct.
      //
      // Eva Mademont needs three mornings and three afternoons, which is six
      // shifts, and a week with a public holiday has five days. Exactly one
      // split shift is the only arrangement that fits — and it is what her own
      // condition describes when it says a split counts on both sides.
      if (!cambio && dobles && faltaManana && !sobraTarde) {
        for (const d of empSched.dias) {
          if (d.turno !== 'TARDE') continue;
          if (!turnoPermitido(cond, 'PARTIDO', contarTurnos(empSched.dias))) break;
          if (!cambioPermitido(horario, employees, rules, emp, empSched, d.dia, 'TARDE', 'PARTIDO')) continue;
          setShift(d, 'PARTIDO');
          cambio = true;
          break;
        }
      }

      const faltaTarde = cond.tardesExactas != null && tardes < cond.tardesExactas;
      const sobraManana = cond.mananasExactas != null && mananas > cond.mananasExactas;

      if (!cambio && dobles && faltaTarde && !sobraManana) {
        for (const d of empSched.dias) {
          if (d.turno !== 'MANANA') continue;
          if (!turnoPermitido(cond, 'PARTIDO', contarTurnos(empSched.dias))) break;
          if (!cambioPermitido(horario, employees, rules, emp, empSched, d.dia, 'MANANA', 'PARTIDO')) continue;
          setShift(d, 'PARTIDO');
          cambio = true;
          break;
        }
      }

      if (!cambio && faltaTarde && (sobraManana || cond.mananasExactas == null)) {
        for (const d of empSched.dias) {
          if (d.turno !== 'MANANA') continue;
          if (!turnoPermitido(cond, 'TARDE', contarTurnos(empSched.dias))) break;
          if (!cambioPermitido(horario, employees, rules, emp, empSched, d.dia, 'MANANA', 'TARDE')) continue;
          setShift(d, 'TARDE');
          cambio = true;
          break;
        }
      }

      if (!cambio) break;
    }
  }
}

// Day names as they turn up in the model's prose, so a conflict can be matched
// back to the day it is about.
const NOMS_DIA = {
  LUNES: /\blunes|dilluns\b/i,
  MARTES: /\bmartes|dimarts\b/i,
  MIERCOLES: /\bmi[eé]rcoles|dimecres\b/i,
  JUEVES: /\bjueves|dijous\b/i,
  VIERNES: /\bviernes|divendres\b/i,
  SABADO: /\bs[áa]bado|dissabte\b/i,
  DOMINGO: /\bdomingo|diumenge\b/i,
};

/**
 * Drops reported conflicts that are only about days the shop is shut.
 *
 * On a closed day every single person is LIBRE, so "Saturday coverage cannot be
 * met, everybody is LIBRE" describes the closure itself rather than anything a
 * manager can act on. The prompt already forbids it and the model writes it
 * anyway, which is the usual reason a rule ends up here instead: what the panel
 * shows has to be true, and prose is the one part nothing was checking.
 */
export function filtrarConflictosDeDiasCerrados(conflictos, diasCerrados) {
  if (!Array.isArray(conflictos) || !diasCerrados?.length) return conflictos || [];
  const cerrados = new Set(diasCerrados);
  return conflictos.filter((c) => {
    const texto = String(c);
    const mencionados = Object.entries(NOMS_DIA)
      .filter(([, re]) => re.test(texto))
      .map(([dia]) => dia);
    if (mencionados.length === 0) return true;               // not about a day at all
    return mencionados.some((d) => !cerrados.has(d));        // keep if any open day is involved
  });
}

/**
 * Drops reported conflicts about people whose week we can prove is fine.
 *
 * The model writes its conflict list about its own draft. The deterministic
 * passes then run and fix things — so it reported that Albert Triano and Victor
 * Sanchez had only one split shift each when by the time anybody read it they
 * had two. Stale, confident and wrong is worse on that panel than silent.
 *
 * Only drops when a claim is disprovable: the line names somebody, and every
 * person it names passes the condition check on the final schedule. Anything we
 * cannot verify is left alone. Hour shortfalls are reported separately by the
 * dashboard, which compares against the same target the generator used.
 */
export function filtrarConflictosYaResueltos(conflictos, horario, employees, diasHabituales) {
  if (!Array.isArray(conflictos) || conflictos.length === 0) return conflictos || [];
  return conflictos.filter((c) => {
    const texto = normalize(String(c));
    const mencionados = employees.filter((e) => {
      const nom = normalize(`${e.nombre} ${e.apellidos}`.replace(/\s+/g, ' ').trim());
      return nom.length > 0 && texto.includes(nom);
    });
    if (mencionados.length === 0) return true; // nobody named — nothing to disprove
    return mencionados.some((e) => {
      const sched = horario.find((h) => h.empleadoId === e.id);
      const { problemas } = checkEmployeeConditions({
        empleado: e, dias: sched?.dias || [], diasHabituales,
      });
      return problemas.length > 0;
    });
  });
}

// Fixed weekly availability: a half explicitly set to false is a half this
// person never works.
function disponiblePara(emp, dia, turno) {
  const slot = emp?.dispParsed?.[dia];
  if (!slot) return true;
  if (turno === 'MANANA') return slot.M !== false;
  if (turno === 'TARDE') return slot.T !== false;
  if (turno === 'PARTIDO') return slot.M !== false && slot.T !== false;
  return true;
}

// Whether giving this person one more shift of this type would break their
// fixed conditions, counting what the week already holds for them.
function condicionesPermiten(horario, emp, turno) {
  if (!emp?.condParsed) return true;
  const sched = horario.find((h) => h.empleadoId === emp.id);
  return turnoPermitido(emp.condParsed, turno, contarTurnos(sched?.dias));
}

function getDayEntry(horario, empId, dia) {
  const emp = horario.find((h) => h.empleadoId === empId);
  if (!emp) return null;
  return emp.dias.find((d) => d.dia === dia) || null;
}

function setShift(entry, turno) {
  entry.turno = turno;
  entry.horaEntrada = defaultEntrada(turno);
  entry.horaDescanso = null;
}

// Effective max hours accounting for cross-establishment hours already scheduled this week
function effectiveMaxHours(emp) {
  // Target for this week (contract × weekly intensity), minus hours already
  // worked in other establishments. Falls back to the plain contract.
  const objetivo = emp.horasObjetivoSemana ?? (emp.maxHorasSemana || 40);
  return Math.max(0, Math.min(objetivo - (emp.horasYaTrabajadas || 0), remainingWeeklyHours(emp)));
}

// Count workers of a given function active in morning or afternoon for a day
function countForDay(horario, employees, dia, funcion, slot) {
  // slot: 'MANANA' means MANANA+PARTIDO, 'TARDE' means TARDE+PARTIDO
  const shifts = slot === 'MANANA' ? ['MANANA', 'PARTIDO'] : ['TARDE', 'PARTIDO'];
  let count = 0;
  for (const empSched of horario) {
    const emp = employees.find((e) => e.id === empSched.empleadoId);
    if (!emp || emp.funcion !== funcion) continue;
    const d = empSched.dias.find((x) => x.dia === dia);
    if (d && shifts.includes(d.turno)) count++;
  }
  return count;
}

// ─────────────────────────────────────────────
// UNIFIED REPAIR ALGORITHM
// Runs in passes until schedule is consistent:
//   Pass A: trim over-max (move excess workers to opposite shift or LIBRE)
//   Pass B: fill under-min (assign LIBRE workers to shifts with gap)
//   Pass C: fill underutilized hours (workers below contracted hours get more shifts if room exists)
//   Pass D: trim over-hours (workers exceeding contracted hours lose shifts from end of week)
//   Pass E: variety (avoid 5+ same shift in a row)
// Repeats A+B up to 5 times since B can cause A violations and vice versa.
// ─────────────────────────────────────────────
export function repairSchedule(horario, employees, rules) {
  // Sort each employee's days in week order once
  for (const empSched of horario) {
    empSched.dias.sort((a, b) => DIAS.indexOf(a.dia) - DIAS.indexOf(b.dia));
  }

  if (rules && rules.length > 0) {
    // Iterate coverage repair up to 5 times
    for (let iter = 0; iter < 5; iter++) {
      let changed = false;

      // Pass A: trim over-max
      for (const dia of DIAS) {
        const rule = getRuleForDay(rules, dia);
        if (!rule) continue;

        const slots = [
          { funcion: 'DEPENDIENTA', slot: 'MANANA', max: rule.maxDependientasManana ?? 99, min: rule.minDependientasManana },
          { funcion: 'DEPENDIENTA', slot: 'TARDE',  max: rule.maxDependientasTarde  ?? 99, min: rule.minDependientasTarde  },
          { funcion: 'ELABORACION', slot: 'MANANA', max: rule.maxElaboracionManana  ?? 99, min: rule.minElaboracionManana  },
          { funcion: 'ELABORACION', slot: 'TARDE',  max: rule.maxElaboracionTarde   ?? 99, min: rule.minElaboracionTarde   },
        ];

        for (const { funcion, slot, max, min } of slots) {
          const count = countForDay(horario, employees, dia, funcion, slot);
          if (count <= max) continue;

          const excess = count - max;
          const oppositeSlot = slot === 'MANANA' ? 'TARDE' : 'MANANA';
          const oppMax = slots.find((s) => s.funcion === funcion && s.slot === oppositeSlot)?.max ?? 99;

          // Candidates: same function, on this slot, not PARTIDO (don't touch split shifts)
          const shiftVal = slot === 'MANANA' ? 'MANANA' : 'TARDE';
          const candidates = horario
            .filter((h) => {
              const emp = employees.find((e) => e.id === h.empleadoId);
              if (!emp || emp.funcion !== funcion) return false;
              const d = h.dias.find((x) => x.dia === dia);
              return d && d.turno === shiftVal;
            })
            // Move workers with most hours first (they're most over-contracted)
            .sort((a, b) => getWeekHours(horario, b.empleadoId, employees) - getWeekHours(horario, a.empleadoId, employees));

          let removed = 0;
          for (const cand of candidates) {
            if (removed >= excess) break;
            const d = cand.dias.find((x) => x.dia === dia);
            const oppCount = countForDay(horario, employees, dia, funcion, oppositeSlot);
            const empCand = employees.find((e) => e.id === cand.empleadoId);
            const oppShift = oppositeSlot === 'MANANA' ? 'MANANA' : 'TARDE';
            // Trimming an over-staffed morning must not solve it by pushing
            // somebody into an afternoon they are never supposed to work; they
            // get the day off instead.
            if (oppCount < oppMax && condicionesPermiten(horario, empCand, oppShift)) {
              // Move to opposite shift
              setShift(d, oppShift);
            } else {
              // Can't move, set LIBRE
              setShift(d, 'LIBRE');
            }
            removed++;
            changed = true;
          }
        }
      }

      // Pass B: fill under-min
      for (const dia of DIAS) {
        const rule = getRuleForDay(rules, dia);
        if (!rule) continue;

        const slots = [
          { funcion: 'DEPENDIENTA', slot: 'MANANA', min: rule.minDependientasManana, max: rule.maxDependientasManana ?? 99 },
          { funcion: 'DEPENDIENTA', slot: 'TARDE',  min: rule.minDependientasTarde,  max: rule.maxDependientasTarde  ?? 99 },
          { funcion: 'ELABORACION', slot: 'MANANA', min: rule.minElaboracionManana,  max: rule.maxElaboracionManana  ?? 99 },
          { funcion: 'ELABORACION', slot: 'TARDE',  min: rule.minElaboracionTarde,   max: rule.maxElaboracionTarde   ?? 99 },
        ];

        for (const { funcion, slot, min, max } of slots) {
          const count = countForDay(horario, employees, dia, funcion, slot);
          if (count >= min) continue;

          const needed = min - count;
          const targetShift = slot === 'MANANA' ? 'MANANA' : 'TARDE';

          // Candidates: same function, LIBRE on this day, and not forbidden this
          // shift by their own conditions. Whoever has to cover an afternoon, it
          // must not be the person whose conditions say they never do one.
          //
          // Among those who may, the unrestricted go first: somebody allowed at
          // most three afternoons a week should not spend that allowance on the
          // first gap of the week when a colleague with no limit is equally
          // free. Hours still break the tie, so the load stays even.
          const candidates = horario
            .filter((h) => {
              const emp = employees.find((e) => e.id === h.empleadoId);
              if (!emp || emp.funcion !== funcion) return false;
              const d = h.dias.find((x) => x.dia === dia);
              if (!d || d.turno !== 'LIBRE') return false;
              return condicionesPermiten(horario, emp, targetShift);
            })
            .sort((a, b) => {
              const ea = employees.find((e) => e.id === a.empleadoId);
              const eb = employees.find((e) => e.id === b.empleadoId);
              const ra = turnoRestringido(ea?.condParsed, targetShift) ? 1 : 0;
              const rb = turnoRestringido(eb?.condParsed, targetShift) ? 1 : 0;
              if (ra !== rb) return ra - rb;
              return getWeekHours(horario, a.empleadoId, employees) - getWeekHours(horario, b.empleadoId, employees);
            });

          let filled = 0;
          for (const cand of candidates) {
            if (filled >= needed) break;
            const d = cand.dias.find((x) => x.dia === dia);
            const emp = employees.find((e) => e.id === cand.empleadoId);
            // Don't assign if this day is already worked in another establishment
            if (emp?.diasOcupadosOtrosEstablecimientos?.[dia]) continue;
            // Don't assign on approved-absence days (vacaciones / baja)
            if (emp?.diasAusente?.[dia]) continue;
            // Don't fill a day the employee asked off in their weekly preferences
            if (emp?.diasPreferenciaLibre?.[dia]) continue;
            const currentHours = getWeekHours(horario, cand.empleadoId, employees);
            const addedHours = shiftHours(emp, targetShift);
            // Coverage cannot authorize hours above the weekly maximum.
            if (emp && currentHours + addedHours <= effectiveMaxHours(emp)) {
              setShift(d, targetShift);
              filled++;
              changed = true;
            }
          }

          // Still short and nobody is LIBRE? Upgrade a same-function worker on the
          // OPPOSITE single shift to PARTIDO — a split shift covers this slot too,
          // so it fills the gap AND gives that worker more hours. Pick fewest-hours
          // first, and don't stack too many split shifts on one person.
          if (filled < needed) {
            const oppositeSingle = targetShift === 'MANANA' ? 'TARDE' : 'MANANA';
            const upgradables = horario
              .filter((h) => {
                const emp = employees.find((e) => e.id === h.empleadoId);
                if (!emp || emp.funcion !== funcion) return false;
                if (emp.diasOcupadosOtrosEstablecimientos?.[dia] || emp.diasAusente?.[dia]) return false;
                if (emp.diasPreferenciaLibre?.[dia]) return false; // asked off this week
                if (emp.turnosPorDiaPreferencia?.[dia]) return false; // asked for one half only
                if (jornadaReducida(emp)) return false; // a part-time day must never be doubled
                // A split shift is an afternoon too, and spends whatever
                // afternoon allowance the person's conditions grant them.
                if (!condicionesPermiten(horario, emp, 'PARTIDO')) return false;
                const d = h.dias.find((x) => x.dia === dia);
                if (!d || d.turno !== oppositeSingle) return false;
                return h.dias.filter((x) => x.turno === 'PARTIDO').length < 3; // cap split shifts/week
              })
              .sort((a, b) => {
                const ea = employees.find((e) => e.id === a.empleadoId);
                const eb = employees.find((e) => e.id === b.empleadoId);
                const ra = turnoRestringido(ea?.condParsed, 'PARTIDO') ? 1 : 0;
                const rb = turnoRestringido(eb?.condParsed, 'PARTIDO') ? 1 : 0;
                if (ra !== rb) return ra - rb;
                return getWeekHours(horario, a.empleadoId, employees) - getWeekHours(horario, b.empleadoId, employees);
              });

            for (const cand of upgradables) {
              if (filled >= needed) break;
              const d = cand.dias.find((x) => x.dia === dia);
              const emp = employees.find((e) => e.id === cand.empleadoId);
              const currentHours = getWeekHours(horario, cand.empleadoId, employees);
              const delta = shiftHours(emp, 'PARTIDO') - shiftHours(emp, d.turno);
              if (currentHours + delta <= effectiveMaxHours(emp)) {
                setShift(d, 'PARTIDO');
                filled++;
                changed = true;
              }
            }
          }
        }
      }

      // Pass B-bis: move somebody from a shift with people to spare to one that
      // is short.
      //
      // Every pass so far could only add, remove, or upgrade to a split shift.
      // None could move anybody, so a day with eight dependientas in the morning
      // — its maximum — and three in the afternoon, one below its minimum, stayed
      // broken: Pass A saw nothing above a maximum to trim, and Pass B found
      // nobody free to add. The people needed were already at work, on the wrong
      // half of the day.
      //
      // Only single shifts move. A split shift already covers both halves, so
      // moving one out of the morning takes it out of the afternoon too and
      // leaves the day no better off.
      for (const dia of DIAS) {
        const rule = getRuleForDay(rules, dia);
        if (!rule) continue;

        const limites = {
          DEPENDIENTA: {
            MANANA: { min: rule.minDependientasManana, max: rule.maxDependientasManana ?? 99 },
            TARDE: { min: rule.minDependientasTarde, max: rule.maxDependientasTarde ?? 99 },
          },
          ELABORACION: {
            MANANA: { min: rule.minElaboracionManana, max: rule.maxElaboracionManana ?? 99 },
            TARDE: { min: rule.minElaboracionTarde, max: rule.maxElaboracionTarde ?? 99 },
          },
        };

        for (const funcion of ['DEPENDIENTA', 'ELABORACION']) {
          for (const destino of ['MANANA', 'TARDE']) {
            const origen = destino === 'MANANA' ? 'TARDE' : 'MANANA';
            const lim = limites[funcion];

            // One move per evaluation, then look again: both counts change.
            for (let intento = 0; intento < 4; intento++) {
              const nDestino = countForDay(horario, employees, dia, funcion, destino);
              const nOrigen = countForDay(horario, employees, dia, funcion, origen);
              if (nDestino >= lim[destino].min) break;      // no longer short
              if (nDestino >= lim[destino].max) break;      // no room to receive
              if (nOrigen <= lim[origen].min) break;        // taking one would break the other half

              const candidato = horario
                .filter((h) => {
                  const emp = employees.find((e) => e.id === h.empleadoId);
                  if (!emp || emp.funcion !== funcion) return false;
                  if (emp.diasOcupadosOtrosEstablecimientos?.[dia] || emp.diasAusente?.[dia]) return false;
                  if (emp.diasPreferenciaLibre?.[dia]) return false;
                  // "That day I can only do mornings/afternoons" — moving them is
                  // exactly what they asked us not to do.
                  if (emp.turnosPorDiaPreferencia?.[dia]) return false;
                  if (!disponiblePara(emp, dia, destino)) return false;
                  if (!condicionesPermiten(horario, emp, destino)) return false;
                  const d = h.dias.find((x) => x.dia === dia);
                  return d && d.turno === origen; // single shifts only
                })
                .sort((a, b) => {
                  const ea = employees.find((e) => e.id === a.empleadoId);
                  const eb = employees.find((e) => e.id === b.empleadoId);
                  const ra = turnoRestringido(ea?.condParsed, destino) ? 1 : 0;
                  const rb = turnoRestringido(eb?.condParsed, destino) ? 1 : 0;
                  if (ra !== rb) return ra - rb;
                  return getWeekHours(horario, a.empleadoId, employees) - getWeekHours(horario, b.empleadoId, employees);
                })[0];

              if (!candidato) break;
              setShift(candidato.dias.find((x) => x.dia === dia), destino);
              changed = true;
            }
          }
        }
      }

      if (!changed) break;
    }
  }

  // Pass C: fill underutilized hours
  // Workers more than 2h below their EFFECTIVE contracted hours (contracted - already worked elsewhere)
  // get extra shifts on days they're LIBRE, but only if that day still has room under max coverage
  for (const empSched of horario) {
    const emp = employees.find((e) => e.id === empSched.empleadoId);
    if (!emp) continue;

    const effMax = effectiveMaxHours(emp);
    let hours = getWeekHours(horario, emp.id, employees);
    if (hours >= effMax - 2) continue;

    for (const d of empSched.dias) {
      if (d.turno !== 'LIBRE') continue;
      if (hours >= effMax - 2) break;
      // Skip days already worked in another establishment
      if (emp.diasOcupadosOtrosEstablecimientos?.[d.dia]) continue;
      // Skip approved-absence days (vacaciones / baja)
      if (emp.diasAusente?.[d.dia]) continue;
      // Respect days the employee asked off in their weekly preferences
      if (emp.diasPreferenciaLibre?.[d.dia]) continue;

      // Check if there's room on this day for this function
      const rule = rules && rules.length > 0 ? getRuleForDay(rules, d.dia) : null;

      const maxM = rule
        ? (emp.funcion === 'DEPENDIENTA' ? (rule.maxDependientasManana ?? 99) : (rule.maxElaboracionManana ?? 99))
        : 99;
      const maxT = rule
        ? (emp.funcion === 'DEPENDIENTA' ? (rule.maxDependientasTarde ?? 99) : (rule.maxElaboracionTarde ?? 99))
        : 99;

      const countM = countForDay(horario, employees, d.dia, emp.funcion, 'MANANA');
      const countT = countForDay(horario, employees, d.dia, emp.funcion, 'TARDE');

      // "Only mornings/afternoons that day" restricts which half we may fill.
      const soloTurno = emp.turnosPorDiaPreferencia?.[d.dia] || null;

      // Ask what the shift is worth to THIS person: a reduced working day is
      // four hours, not seven, and the literals here used to overshoot by three
      // for every part-timer — the pass thought it had topped somebody up when
      // it had not.
      const horasM = shiftHours(emp, 'MANANA');
      const horasT = shiftHours(emp, 'TARDE');

      // Topping somebody up to their hours is never a reason to give them a
      // shift their conditions rule out.
      const puedeM = condicionesPermiten(horario, emp, 'MANANA');
      const puedeT = condicionesPermiten(horario, emp, 'TARDE');

      if (soloTurno !== 'TARDE' && puedeM && countM < maxM && hours + horasM <= effMax) {
        setShift(d, 'MANANA');
        hours += horasM;
      } else if (soloTurno !== 'MANANA' && puedeT && countT < maxT && hours + horasT <= effMax) {
        setShift(d, 'TARDE');
        hours += horasT;
      }
    }
  }

  // Pass D: trim hours within the maximum; the final pass enforces it again
  // after the later condition and rotation passes.
  const MAX_EXCESS = 0;
  for (const empSched of horario) {
    const emp = employees.find((e) => e.id === empSched.empleadoId);
    if (!emp) continue;

    let total = empSched.dias.reduce((sum, d) => sum + shiftHours(emp, d.turno), 0);
    const cap = effectiveMaxHours(emp) + MAX_EXCESS;
    if (total <= cap) continue;

    // Remove from end of week first (Sunday → Monday).
    // First sub-pass: trim regular MANANA/TARDE shifts (leave PARTIDO for now).
    const reversed = [...empSched.dias].sort((a, b) => DIAS.indexOf(b.dia) - DIAS.indexOf(a.dia));
    for (const d of reversed) {
      if (total <= cap) break;
      if (d.turno === 'LIBRE' || d.turno === 'PARTIDO') continue;
      // Before removing, check if this day is still above coverage min
      const rule = rules && rules.length > 0 ? getRuleForDay(rules, d.dia) : null;
      if (rule) {
        const slot = d.turno === 'MANANA' ? 'MANANA' : 'TARDE';
        const count = countForDay(horario, employees, d.dia, emp.funcion, slot);
        const minVal = slot === 'MANANA'
          ? (emp.funcion === 'DEPENDIENTA' ? rule.minDependientasManana : rule.minElaboracionManana)
          : (emp.funcion === 'DEPENDIENTA' ? rule.minDependientasTarde : rule.minElaboracionTarde);
        if (count <= minVal) continue; // can't remove — would break minimum coverage
      }
      total -= shiftHours(emp, d.turno);
      setShift(d, 'LIBRE');
    }

    // Second sub-pass: if STILL over cap, only PARTIDO (10h split) shifts remain.
    // Downgrade a split shift to a single half-shift to recover hours, keeping the
    // employee on that day for coverage where possible and never dropping a slot
    // below its minimum staffing. A PARTIDO counts toward BOTH morning and afternoon,
    // so converting it removes the employee from ONE of those slots.
    if (total > cap) {
      for (const d of reversed) {
        if (total <= cap) break;
        if (d.turno !== 'PARTIDO') continue;

        const rule = rules && rules.length > 0 ? getRuleForDay(rules, d.dia) : null;
        let keep = null; // 'TARDE' keeps afternoon (drops morning); 'MANANA' keeps morning (drops afternoon)
        if (!rule) {
          keep = 'TARDE'; // no coverage constraints — keep the shorter half to save the most hours
        } else {
          const minM = (emp.funcion === 'DEPENDIENTA' ? rule.minDependientasManana : rule.minElaboracionManana) ?? 0;
          const minT = (emp.funcion === 'DEPENDIENTA' ? rule.minDependientasTarde : rule.minElaboracionTarde) ?? 0;
          const countM = countForDay(horario, employees, d.dia, emp.funcion, 'MANANA');
          const countT = countForDay(horario, employees, d.dia, emp.funcion, 'TARDE');
          // Prefer keeping afternoon (drops morning) if morning can spare this worker
          if (countM - 1 >= minM) keep = 'TARDE';
          // Otherwise keep morning (drops afternoon) if afternoon can spare this worker
          else if (countT - 1 >= minT) keep = 'MANANA';
          // else: converting either way breaks a minimum — leave the PARTIDO as-is
        }
        if (!keep) continue;
        total -= shiftHours(emp, 'PARTIDO') - shiftHours(emp, keep);
        setShift(d, keep);
      }
    }
  }

  // Pass E: variety — break up runs of 4+ identical shifts
  for (const empSched of horario) {
    const emp = employees.find((e) => e.id === empSched.empleadoId);
    if (!emp) continue;

    const dias = empSched.dias; // already sorted
    let runStart = 0;
    for (let i = 1; i <= dias.length; i++) {
      const same =
        i < dias.length &&
        dias[i].turno === dias[runStart].turno &&
        (dias[runStart].turno === 'MANANA' || dias[runStart].turno === 'TARDE');

      if (!same) {
        const runLen = i - runStart;
        const shiftType = dias[runStart].turno;

        if (runLen >= 4 && (shiftType === 'MANANA' || shiftType === 'TARDE')) {
          const opposite = shiftType === 'MANANA' ? 'TARDE' : 'MANANA';
          for (let j = runStart + 1; j < i; j += 2) {
            const d = dias[j];
            const rule = rules && rules.length > 0 ? getRuleForDay(rules, d.dia) : null;
            // Check coverage allows this swap
            if (rule) {
              const newSlot = opposite === 'MANANA' ? 'MANANA' : 'TARDE';
              const oldSlot = shiftType === 'MANANA' ? 'MANANA' : 'TARDE';
              const newCount = countForDay(horario, employees, d.dia, emp.funcion, newSlot);
              const oldCount = countForDay(horario, employees, d.dia, emp.funcion, oldSlot);
              const newMax = newSlot === 'MANANA'
                ? (emp.funcion === 'DEPENDIENTA' ? (rule.maxDependientasManana ?? 99) : (rule.maxElaboracionManana ?? 99))
                : (emp.funcion === 'DEPENDIENTA' ? (rule.maxDependientasTarde ?? 99) : (rule.maxElaboracionTarde ?? 99));
              const oldMin = oldSlot === 'MANANA'
                ? (emp.funcion === 'DEPENDIENTA' ? rule.minDependientasManana : rule.minElaboracionManana)
                : (emp.funcion === 'DEPENDIENTA' ? rule.minDependientasTarde : rule.minElaboracionTarde);
              if (newCount >= newMax) continue; // opposite is full
              if (oldCount <= oldMin) continue; // current slot would go under min
            }
            // Skip days occupied in another establishment
            if (emp.diasOcupadosOtrosEstablecimientos?.[d.dia]) continue;
            const hours = getWeekHours(horario, emp.id, employees);
            const delta = shiftHours(emp, opposite) - shiftHours(emp, shiftType);
            if (hours + delta <= effectiveMaxHours(emp)) {
              setShift(d, opposite);
            }
          }
        }
        runStart = i;
      }
    }
  }
}

// ─────────────────────────────────────────────
// Prompt builder
// ─────────────────────────────────────────────
// Human-readable list of slots an employee can NEVER work, from the availability grid.
function disponibilidadNoTrabaja(emp) {
  const disp = emp.dispParsed || parseDisponibilidad(emp.disponibilidad);
  if (!disp) return [];
  const out = [];
  for (const dia of DIAS) {
    const s = disp[dia];
    if (!s) continue;
    const noM = s.M === false, noT = s.T === false;
    if (noM && noT) out.push(`${dia} (todo el día)`);
    else if (noM) out.push(`${dia} por la mañana`);
    else if (noT) out.push(`${dia} por la tarde`);
  }
  return out;
}

function buildEstablishmentHours(establishment) {
  let text = `- Apertura: ${establishment.horarioApertura || '08:00'}\n- Cierre: ${establishment.horarioCierre || '21:00'}`;
  if (establishment.cierraMediodia) {
    text += `\n- Cierra al mediodía: sí, de ${establishment.inicioCierreMediodia || '—'} a ${establishment.finCierreMediodia || '—'} (no debe haber empleados trabajando durante ese tramo)`;
  } else {
    text += `\n- Cierre al mediodía: no`;
  }
  return text;
}

// ISO week string of the week immediately before `semana` (e.g. "2026-W26" → "2026-W25")
function previousWeek(semana) {
  const [year, week] = semana.split('-W').map(Number);
  // Monday of the given ISO week
  const jan4 = new Date(year, 0, 4);
  const dow = (jan4.getDay() + 6) % 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dow + (week - 1) * 7);
  // Step back one week and recompute the ISO week number (handles year / 53-week boundaries)
  const prev = new Date(monday);
  prev.setDate(prev.getDate() - 7);
  prev.setDate(prev.getDate() + 3 - ((prev.getDay() + 6) % 7));
  const week1 = new Date(prev.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((prev - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${prev.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function buildPrompt({ establishment, semana, employees, prefMap, rules, freeRules, historyMap, fairnessData, editPatterns, festivoDays, intensidad = 100, notaIntensidad = null }) {
  const prevWeek = previousWeek(semana);
  const employeeList = employees.map((emp) => {
    const pref = prefMap[emp.id];
    const history = (historyMap[emp.id] || []).slice(0, 14);
    // Compact "last week" map (dia → turno) so cross-week rules are easy to apply
    const lastWeek = (historyMap[emp.id] || [])
      .filter((h) => h.semana === prevWeek)
      .reduce((acc, h) => { acc[h.dia] = h.turno; return acc; }, {});
    // The Saturday alternation rule needs the last Saturday this person actually
    // worked, which is not always last week's. A Saturday the shop was shut for
    // a public holiday — or that the employee had off — carries no shift to
    // alternate from, and reading it as LIBRE loses the turn entirely instead of
    // carrying it over to the next open Saturday. Week strings are zero-padded,
    // so they sort correctly as text.
    const ultimoSabado = (historyMap[emp.id] || [])
      .filter((h) => h.dia === 'SABADO' && h.turno !== 'LIBRE')
      .sort((a, b) => b.semana.localeCompare(a.semana))[0] || null;
    const diasOcupados = emp.diasOcupadosOtrosEstablecimientos || {};
    const diasNoDisponibles = Object.keys(diasOcupados);
    const empFairness = fairnessData?.find((f) => f.empleadoId === emp.id);
    const empPatterns = editPatterns?.filter((p) => p.empleadoId === emp.id);
    return {
      id: emp.id,
      nombre: `${emp.nombre} ${emp.apellidos}`,
      funcion: emp.funcion,
      horasContratadas: emp.maxHorasSemana,
      horasObjetivoEstaSemana: emp.horasObjetivoSemana ?? emp.maxHorasSemana,
      horasYaTrabajadasOtrosEstablecimientos: emp.horasYaTrabajadas || 0,
      horasDisponiblesEstaSemana: emp.horasDisponibles ?? emp.maxHorasSemana,
      esVisitanteDeOtroEstablecimiento: emp.esVisitante || false,
      establecimientoPrincipal: emp.establecimiento?.nombre || null,
      diasYaOcupadosEnOtroEstablecimiento: diasNoDisponibles.length > 0
        ? diasNoDisponibles.map((dia) => ({ dia, establecimiento: diasOcupados[dia].establecimiento, turno: diasOcupados[dia].turno }))
        : [],
      preferencias: pref ? {
        turnoPreferido: pref.turnoPreferido,
        diasNoDisponible: pref.diasNoDisponible,
        ...(pref.turnosPorDia && Object.keys(pref.turnosPorDia).length > 0
          ? { SOLO_puede_este_turno: pref.turnosPorDia }
          : {}),
        notasAdicionales: pref.notasAdicionales,
      } : null,
      ...(disponibilidadNoTrabaja(emp).length > 0 ? { NO_puede_trabajar: disponibilidadNoTrabaja(emp) } : {}),
      ...(emp.horasPorTurno ? { jornadaReducida: { horasPorTurno: emp.horasPorTurno, nuncaPartido: true } } : {}),
      ...(emp.condicionesFijas ? { condicionesFijas: emp.condicionesFijas } : {}),
      historialReciente: history,
      ...(Object.keys(lastWeek).length > 0 ? { semanaPasada: lastWeek } : {}),
      ...(ultimoSabado ? { ultimoSabadoTrabajado: { semana: ultimoSabado.semana, turno: ultimoSabado.turno } } : {}),
      ...(empFairness ? { equidad: empFairness } : {}),
      ...(empPatterns && empPatterns.length > 0 ? { patronesAprendidos: empPatterns.map((p) => p.descripcion) } : {}),
      ...(Object.keys(emp.diasAusente || {}).length > 0 ? {
        ausencias: Object.entries(emp.diasAusente).map(([dia, tipo]) => ({ dia, motivo: tipo })),
      } : {}),
    };
  });

  const rulesText = rules.length > 0 ? rules.map((r) => `
- ${r.nombre}:
  · Dependientas turno mañana: entre ${r.minDependientasManana} y ${r.maxDependientasManana ?? 99}
  · Dependientas turno tarde: entre ${r.minDependientasTarde} y ${r.maxDependientasTarde ?? 99}
  · Elaboración turno mañana: entre ${r.minElaboracionManana} y ${r.maxElaboracionManana ?? 99}
  · Elaboración turno tarde: entre ${r.minElaboracionTarde} y ${r.maxElaboracionTarde ?? 99}
  · Mínimo personas durante descanso partido (13:00–15:00): ${r.minPersonasDescansoPartido}
  IMPORTANTE: El número de personas asignadas a cada turno debe estar DENTRO del rango indicado. No puede estar ni por debajo del mínimo ni por encima del máximo.`
  ).join('\n') : 'Sin reglas de cobertura definidas.';

  const freeRulesText = freeRules.length > 0
    ? freeRules.map((r, i) => `${i + 1}. ${r.texto}`).join('\n')
    : 'Sin reglas adicionales.';

  const horasEstablecimiento = buildEstablishmentHours(establishment);

  // Absence / holiday section for the prompt
  let absenceSection = '';
  if (festivoDays && festivoDays.length > 0) {
    absenceSection += `
## DÍAS CERRADOS ESTA SEMANA (festivos o cierre semanal)
El establecimiento está CERRADO los siguientes días: ${festivoDays.join(', ')}.
- TODOS los empleados deben tener LIBRE en esos días, sin excepción.
- Ajusta las horas semanales en consecuencia (no penalices a nadie por tener libre un día cerrado).
`;
  }

  // Check if any employee has personal absences
  const hasAbsences = employees.some((e) => Object.keys(e.diasAusente || {}).length > 0);
  if (hasAbsences) {
    absenceSection += `
## AUSENCIAS DE EMPLEADOS
Algunos empleados tienen ausencias aprobadas esta semana (vacaciones o baja médica).
Estas ausencias aparecen en el campo "ausencias" de cada empleado afectado.
- Los días con ausencia DEBEN ser LIBRE obligatoriamente.
- No cuentes esos días como disponibles para cubrir turnos.
- Ajusta las horas esperadas del empleado proporcionalmente (no penalices por estar de baja/vacaciones).
`;
  }

  // Fairness section for the prompt
  let fairnessSection = '';
  if (fairnessData && fairnessData.length > 0) {
    fairnessSection = `
## EQUIDAD — DISTRIBUCIÓN JUSTA DE TURNOS
Datos de equidad de las últimas semanas (incluidos en cada empleado como campo "equidad"):
- sabadosTrabajados / domingosTrabajados: cuántos fines de semana ha trabajado cada uno en las últimas 8 semanas
- turnosPartido: cuántos turnos PARTIDO ha tenido
- turnosTarde: cuántos turnos de tarde ha tenido
- diasLibrePromedio: media de días libres por semana

REGLA DE EQUIDAD: Distribuye los turnos menos deseables (fines de semana, PARTIDO) de forma equilibrada.
- Si un empleado ha trabajado muchos más sábados/domingos que otros, dale prioridad para tener libre este fin de semana.
- Si un empleado ha tenido muchos más turnos PARTIDO que otros, reduce sus PARTIDO esta semana.
- Busca que la diferencia entre el que más fines de semana trabaja y el que menos sea ≤ 2 en 8 semanas.
`;
  }

  // Learning-from-edits section
  let learningSection = '';
  if (editPatterns && editPatterns.length > 0) {
    learningSection = `
## PATRONES APRENDIDOS DEL MANAGER
El manager suele hacer los siguientes ajustes después de la generación automática. Tenlos en cuenta para evitar que tenga que corregir lo mismo:
${editPatterns.map((p) => `- ${p.descripcion}`).join('\n')}

Estos patrones están incluidos también en cada empleado afectado como campo "patronesAprendidos".
Aplica estos patrones como preferencias suaves (no obligatorias, pero sí preferidas).
`;
  }

  const systemPrompt = `Eres un experto en gestión de horarios laborales para una empresa cárnica española.
Tu objetivo es generar horarios semanales óptimos que cumplan todas las reglas de cobertura, respeten las horas contratadas, y sean justos para todos los empleados.

## TIPOS DE TURNO Y HORAS
- MANANA: 7 horas de trabajo
- TARDE: 6 horas de trabajo
- PARTIDO: 10 horas de trabajo (con 3h de descanso entre 13:00 y 15:00)
- LIBRE: 0 horas — día de descanso

## DISPONIBILIDAD FIJA Y CONDICIONES DEL EMPLEADO — OBLIGATORIO
- Si un empleado tiene el campo "NO_puede_trabajar", esos turnos/días son IMPOSIBLES para él (disponibilidad fija). Asígnale SIEMPRE LIBRE en esos tramos. Ejemplo: "MARTES (todo el día)" → el martes debe ser LIBRE; "LUNES por la mañana" → ese lunes solo puede trabajar por la tarde o LIBRE.
- Si un empleado tiene el campo "condicionesFijas" (texto libre), son condiciones recurrentes acordadas (p. ej. compensaciones) que debes respetar como norma. Léelas con atención y aplícalas.
- Si un empleado tiene "jornadaReducida" (horas fijas por turno, p. ej. 4h de 8:00 a 12:00), NUNCA le asignes PARTIDO: un turno partido cubre mañana y tarde y le duplicaría la jornada, que es lo contrario de un contrato reducido. Solo MANANA, TARDE o LIBRE.
- Si dentro de "preferencias" hay un campo "SOLO_puede_este_turno" (p. ej. {"MIERCOLES":"TARDE"}), ese día el empleado SOLO puede hacer ese turno concreto. Asígnale exactamente ese turno, o LIBRE si no hace falta. **NUNCA le pongas PARTIDO ese día**: PARTIDO ocupa mañana Y tarde, así que el empleado se quedaría sin el medio día libre que ha pedido. Pedir "solo tarde" significa que la mañana tiene que quedar libre.

## INTENSIDAD DE ESTA SEMANA: ${intensidad}%${notaIntensidad ? ` (${notaIntensidad})` : ''}
${intensidad > 100
  ? `Semana de MÁS carga de lo normal: los objetivos de horas de cada empleado ya vienen aumentados en "horasObjetivoEstaSemana". Es normal que trabajen por encima de su contrato habitual.`
  : intensidad < 100
    ? `Semana de MENOS carga de lo normal: los objetivos de horas ya vienen reducidos en "horasObjetivoEstaSemana". Es correcto que trabajen por debajo de su contrato habitual; no intentes llegar al contrato.`
    : `Semana normal: los objetivos coinciden con el contrato de cada empleado.`}

## HORAS CONTRATADAS — MUY IMPORTANTE
Cada empleado tiene:
- "horasContratadas": horas semanales de su contrato (referencia).
- "horasObjetivoEstaSemana": OBJETIVO REAL de esta semana (contrato ajustado por la intensidad que ha fijado el manager). Es el número al que debes acercarte, NO el contrato.
- "horasYaTrabajadasOtrosEstablecimientos": horas que YA tiene asignadas esta semana en OTROS establecimientos.
- "horasDisponiblesEstaSemana": horas que puede trabajar aquí = horasObjetivoEstaSemana − horasYaTrabajadasOtrosEstablecimientos.

Para calcular horas: MANANA=7, TARDE=6, PARTIDO=10, LIBRE=0
Ejemplo: 3 PARTIDO + 1 MANANA + 1 TARDE = 3×10 + 7 + 6 = 43h

Reglas:
- Cada empleado debe acercarse a su "horasObjetivoEstaSemana" (sumando lo de aquí + otros establecimientos).
- Asígnale en ESTE establecimiento como máximo sus "horasDisponiblesEstaSemana" (+1–3h). NUNCA más.
- Si un empleado tiene 40h contratadas y ya trabaja 20h en otro establecimiento, aquí debe trabajar ~20h (NO 40h).
- Si un empleado tiene "horasDisponiblesEstaSemana: 0", asígnale TODOS los días LIBRE aquí.
- Es MEJOR pasarse un poco (1–3h por encima) que quedarse por debajo.
- Un empleado con 40h contratadas sin horas en otros establecimientos debe trabajar ~40–43h aquí, NUNCA 20h o 30h.

## EMPLEADOS VISITANTES (de otro establecimiento)
Algunos empleados tienen "esVisitanteDeOtroEstablecimiento: true" — su establecimiento principal es otro pero pueden trabajar aquí.
- Revisa su campo "diasYaOcupadosEnOtroEstablecimiento": son días en los que YA trabajan en otro establecimiento esta semana.
- Esos días DEBEN ser LIBRE aquí. No pueden trabajar en dos sitios el mismo día.
- Solo úsalos para cubrir huecos que no puedas cubrir con empleados locales.
- Prioriza siempre a los empleados locales para cubrir los turnos — los visitantes son un recurso extra.

## CÓMO CONTAR PERSONAS POR TURNO — MUY IMPORTANTE
Para verificar los rangos de cobertura, cuenta así para CADA DÍA:
- Personas en turno MAÑANA = empleados con turno MANANA + empleados con turno PARTIDO (ambos trabajan por la mañana)
- Personas en turno TARDE = empleados con turno TARDE + empleados con turno PARTIDO (ambos trabajan por la tarde)

REGLA ABSOLUTA: Para cada día, el número de personas en cada turno DEBE estar DENTRO del rango.
Si el rango de dependientas mañana es 4–6, NO puede haber 3 ni 7. Debe haber 4, 5 o 6.
Si necesitas reducir personas en un turno para no superar el máximo, asigna LIBRE o cambia a otro turno.

NOTAS sobre reglas adicionales:
- "No pueden trabajar juntos" = no pueden COINCIDIR en ningún momento del día.
  · RECUERDA: PARTIDO significa que la persona está presente TODO EL DÍA (mañana Y tarde).
  · Si A tiene PARTIDO y B tiene MANANA → están juntos por la mañana → PROHIBIDO.
  · Si A tiene PARTIDO y B tiene TARDE → están juntos por la tarde → PROHIBIDO.
  · Si A tiene PARTIDO y B tiene PARTIDO → están juntos todo el día → PROHIBIDO.
  · Si A tiene MANANA y B tiene TARDE → NO coinciden → PERMITIDO.
  · Si A tiene MANANA y B tiene MANANA → coinciden → PROHIBIDO.
  · Si uno de ellos tiene LIBRE → PERMITIDO.
  · En resumen: si NO pueden trabajar juntos, o uno está LIBRE, o uno hace MANANA y el otro TARDE. Nada más.
- Si una regla modifica los rangos para ciertos días (ej: "viernes incrementa el rango"), aplícalo: suma o resta al mín y máx de esos días.
- Cumple TODAS las reglas adicionales. Si no puedes, explícalo en "conflictos".

## VARIEDAD EN LOS TURNOS — MUY IMPORTANTE
- NO asignes el mismo tipo de turno toda la semana a un empleado. Mezcla turnos MANANA y TARDE.
- Ejemplo BUENO para 40h: MANANA, TARDE, MANANA, PARTIDO, TARDE, MANANA, LIBRE = 7+6+7+10+6+7 = 43h
- Ejemplo MALO para 40h: MANANA, MANANA, MANANA, MANANA, MANANA, MANANA, LIBRE = 42h (demasiado monótono)
- Alterna turnos: si un empleado trabaja de mañana un día, intenta que trabaje de tarde al día siguiente o viceversa.
- Cada empleado debería tener AL MENOS 1-2 turnos diferentes en la semana (no contar LIBRE).
- Los días LIBRE también deben distribuirse: no pongas todos los LIBRE el mismo día para todos.
- Reparte los días LIBRE a lo largo de la semana (no siempre domingo, no siempre el mismo día para todos).
${absenceSection}${fairnessSection}${learningSection}
## INSTRUCCIONES
1. Genera un turno para cada empleado para cada día de la semana (LUNES a DOMINGO).
2. HORAS: Cada empleado debe acercarse a su "horasObjetivoEstaSemana" (no a su contrato: esta semana puede ser más intensa o más floja). Es mejor pasarse 1-3h que quedarse corto. Si su objetivo es 46h, debe trabajar ~46-48h; si es 34h, ~34-36h.
2b. REPARTO EQUITATIVO: distribuye las horas de forma proporcionada entre los empleados disponibles. Evita que unos queden muy por encima de su objetivo y otros muy por debajo sin motivo (ausencia, preferencia o disponibilidad fija).
3. COBERTURA — REGLA ABSOLUTA: Después de asignar los turnos de cada día, cuenta las personas por turno y verifica que estén DENTRO del rango. Si hay más del máximo, cambia algunos a LIBRE o a otro turno. Si hay menos del mínimo, reasigna.
4. Respeta las preferencias de cada empleado en la medida de lo posible.
5. Cumple SIEMPRE las reglas adicionales.
6. VARIEDAD: Mezcla turnos MANANA y TARDE para cada empleado. No repitas el mismo turno más de 2-3 días seguidos. Distribuye los días LIBRE en diferentes días de la semana entre los empleados.
7. En "conflictos" va SOLO lo que no has podido cumplir y exige una decisión del encargado: cobertura por debajo del mínimo en algún turno, o una regla del establecimiento incumplida.
   NO incluyas NUNCA en "conflictos" (el sistema ya lo calcula por su cuenta, y repetirlo tapa lo que sí importa):
   - Ausencias ya aprobadas (bajas, vacaciones) ni sus consecuencias. Que alguien de baja acumule pocas horas es lo correcto, no un conflicto.
   - Empleados por debajo de su objetivo de horas cuando la causa es una ausencia, una preferencia o su disponibilidad fija: si tiene menos días disponibles, es aritmética, no un problema.
   - Cálculos ni sumas de horas ("6+6+7=19h"). Nada de aritmética.
   - Identificadores numéricos de empleado: escribe solo el nombre, nunca "(102)".
   - Días en los que el establecimiento está CERRADO (festivos, o días fuera del horario de apertura). Ese día todo el mundo está LIBRE por definición: no hay cobertura que cumplir ni decisión que tomar.
   - Explicaciones de lo que SÍ has cumplido. Si has respetado una condición, no lo cuentes: "conflictos" es solo lo que queda sin resolver. Frases como "se acepta como mejor aproximación", "tal como permite la regla" o "el resto de días coinciden" describen un acierto, no un problema.
   Escribe cada conflicto en UNA frase corta, en el mismo idioma que el resto de tu respuesta. Si no hay ninguno, deja el array vacío.
8. En el campo "resumen", escribe una frase breve describiendo el horario generado. No incluyas cálculos de horas ni sumas. No afirmes que todos los empleados respetan sus límites — eso lo comprobará el sistema automáticamente.
9. En el campo "informeCanvis" incluye SOLO los cambios notables que el manager debería revisar (no todos los empleados; deja el array vacío si no hay nada destacable). Para cada uno: "peticion" (lo que pidió el trabajador), "cambio" (lo que se ha decidido) y "motivo" (por qué). Ejemplos de cuándo incluirlo: no se ha podido respetar una preferencia, se ha aplicado una regla que le afecta, o una decisión discutible por cobertura. Sé breve y concreto.

## FORMATO DE RESPUESTA
IMPORTANTE: Empieza tu respuesta directamente con el carácter "{". NO escribas ningún análisis, razonamiento, explicación ni texto antes o después del JSON. SOLO el objeto JSON.

Responde ÚNICAMENTE con un JSON válido con esta estructura exacta, sin texto adicional:

{
  "horario": [
    {
      "empleadoId": 1,
      "dias": [
        {
          "dia": "LUNES",
          "turno": "MANANA",
          "horaEntrada": "07:30",
          "horaDescanso": null,
          "conflicto": false,
          "notaConflicto": null
        }
      ]
    }
  ],
  "conflictos": [
    "Descripción de conflicto si no se pudo cumplir alguna regla"
  ],
  "resumen": "Breve resumen del horario generado y decisiones tomadas"
}`;

  const userPrompt = `Genera el horario semanal completo para el establecimiento "${establishment.nombre}" para la semana ${semana}.

## HORARIO DEL ESTABLECIMIENTO
${horasEstablecimiento}
Los turnos asignados deben encajar dentro de este horario. No asignes entradas antes de la apertura ni salidas después del cierre.
${establishment.cierraMediodia ? `Durante el cierre de mediodía (${establishment.inicioCierreMediodia}–${establishment.finCierreMediodia}) el establecimiento está cerrado. Los empleados con turno PARTIDO descansan automáticamente durante ese cierre — por tanto asigna SIEMPRE horaDescanso: null para todos los turnos PARTIDO en este establecimiento.` : ''}

## EMPLEADOS
${JSON.stringify(employeeList, null, 2)}

## REGLAS DE COBERTURA — RANGOS (OBLIGATORIAS)
${rulesText}

## REGLAS ADICIONALES (OBLIGATORIAS — LEE CADA UNA CON ATENCIÓN)
${freeRulesText}

DÓNDE COLOCAR LOS DÍAS LIBRES:
- Viernes y sábado son los días de más trabajo. Un día libre que NO haya pedido el empleado debe caer de lunes a jueves.
- Esto NO se aplica a los días que el empleado ha pedido libre en sus preferencias, ni a ausencias, ni a días en que trabaja en otro establecimiento: esos se respetan donde caigan.
- Si respetarlo dejara la cobertura por debajo del mínimo, prioriza la cobertura y deja el día libre donde estaba.

REGLAS QUE DEPENDEN DE SEMANAS ANTERIORES:
- Algunas reglas hacen referencia a lo que un empleado hizo la semana pasada (ej: "si trabajó el sábado por la mañana, esta semana trabaja por la tarde o partido").
- Para aplicarlas, consulta el campo "semanaPasada" de cada empleado (mapa día → turno de la semana ${prevWeek}) y, si necesitas más contexto, "historialReciente".
- Si un empleado no tiene "semanaPasada", es que no hay datos de la semana anterior: aplica la regla con normalidad sin penalizarle.
- Para la regla de ALTERNANCIA DE SÁBADOS usa SIEMPRE el campo "ultimoSabadoTrabajado" (el último sábado que la persona trabajó de verdad, con su semana y turno), NO el sábado de "semanaPasada". Si un sábado el establecimiento estuvo cerrado por festivo, o el empleado libró, ese sábado NO cuenta: la alternancia se arrastra al siguiente sábado que sí se trabaje. Ejemplo: hizo MANANA el sábado de la W32, la W33 el establecimiento cerró en sábado → en la W34 le toca TARDE.
- Si un empleado no tiene "ultimoSabadoTrabajado", nunca ha trabajado un sábado en el historial: asígnale el turno que mejor encaje sin penalizarle.

Para turnos PARTIDO: ${establishment.cierraMediodia ? `este establecimiento cierra al mediodía, así que asigna horaDescanso: null en TODOS los turnos PARTIDO — el descanso ya está cubierto por el cierre del establecimiento.` : `asigna horaDescanso entre 13:00 y 15:00, escalonando entre empleados para garantizar el mínimo de personas en el establecimiento durante el descanso.`}
Asigna horaEntrada a todos los turnos que no sean LIBRE.`;

  return { system: systemPrompt, user: userPrompt };
}
