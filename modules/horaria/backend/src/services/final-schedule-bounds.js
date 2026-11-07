import { ruleForDay } from '../utils/ruleForDay.js';
import { shiftHours } from '../utils/shiftHours.js';
import { puntuacio } from './passadesCondicions.js';

const DAYS = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
const SHIFTS = ['LIBRE', 'MANANA', 'TARDE', 'PARTIDO'];
const slots = shift => shift === 'PARTIDO' ? ['Manana', 'Tarde'] : shift === 'MANANA' ? ['Manana'] : shift === 'TARDE' ? ['Tarde'] : [];
const suffix = role => role === 'DEPENDIENTA' ? 'Dependientas' : 'Elaboracion';

export function remainingWeeklyHours(employee) {
  const max = employee.maxHorasSemana ?? 40;
  const other = employee.horasYaTrabajadas ?? 0;
  if (!Number.isFinite(max) || max < 0 || !Number.isFinite(other) || other < 0) throw new Error('Límite semanal de horas no válido.');
  // Intensity is a target, never permission to exceed the employee's maximum.
  return Math.max(0, max - other);
}

/** Last pass after ALL heuristics. No database writes or fabricated coverage. */
export function enforceFinalScheduleBounds(horario, employees, rules, closedDays = [], canAssign = () => true) {
  if (horario.length !== employees.length || new Set(horario.map(h => h.empleadoId)).size !== employees.length) throw new Error('La propuesta no contiene una semana única por persona.');
  for (const h of horario) {
    if (!employees.some(e => e.id === h.empleadoId) || !Array.isArray(h.dias) || h.dias.length !== 7 ||
        !DAYS.every(day => h.dias.filter(d => d.dia === day && SHIFTS.includes(d.turno)).length === 1)) throw new Error('Semana o turno de la propuesta inválido.');
  }
  const byId = new Map(employees.map(e => [e.id, e]));
  const schedulesById = new Map(horario.map(h => [h.empleadoId, h]));
  const rulesByDay = Object.fromEntries(DAYS.map(day => [day, ruleForDay(rules, day)]));
  const hours = e => schedulesById.get(e.id).dias.reduce((sum, d) => sum + shiftHours(e, d.turno), 0);
  const score = () => {
    let hard = employees.reduce((sum, e) => sum + Math.max(0, hours(e) - remainingWeeklyHours(e)), 0);
    const counts = Object.fromEntries(DAYS.map(day => [day, { DEPENDIENTA: { Manana: 0, Tarde: 0 }, ELABORACION: { Manana: 0, Tarde: 0 } }]));
    for (const h of horario) for (const d of h.dias) {
      const role = byId.get(h.empleadoId).funcion;
      for (const period of slots(d.turno)) if (counts[d.dia][role]) counts[d.dia][role][period]++;
    }
    let missing = 0;
    for (const day of DAYS) {
      const rule = rulesByDay[day];
      for (const role of ['DEPENDIENTA', 'ELABORACION']) for (const period of ['Manana', 'Tarde']) {
        const value = counts[day][role][period];
        const min = closedDays.includes(day) ? 0 : (rule?.[`min${suffix(role)}${period}`] ?? 0);
        const max = closedDays.includes(day) ? 0 : (rule?.[`max${suffix(role)}${period}`] ?? Infinity);
        hard += Math.max(0, value - max);
        // Avoid concentrating unavoidable shortages into an entirely empty shift.
        missing += Math.max(0, min - value) ** 2;
      }
    }
    const requested = employees.reduce((sum, e) => sum + Object.entries(e.turnosRequeridosBorrador || {})
      .filter(([day, shift]) => schedulesById.get(e.id).dias.find(d => d.dia === day)?.turno !== shift).length, 0);
    return { hard, requested, missing };
  };
  const improves = (after, before) => after.hard < before.hard || (after.hard === before.hard &&
    (after.requested < before.requested || (after.requested === before.requested && after.missing < before.missing)));
  const personallyAllowed = (e, d, shift) => shift === 'LIBRE' || (!closedDays.includes(d.dia) && !e.diasAusente?.[d.dia] &&
    !e.diasPreferenciaLibre?.[d.dia] && !e.diasOcupadosOtrosEstablecimientos?.[d.dia] &&
    (!e.turnosPorDiaPreferencia?.[d.dia] || e.turnosPorDiaPreferencia[d.dia] === shift) &&
    !(shift === 'PARTIDO' && e.horasPorTurno > 0) &&
    !(shift !== 'MANANA' && e.condParsed?.soloMananas) &&
    !(shift !== 'TARDE' && e.condParsed?.soloTardes) &&
    !(shift === 'PARTIDO' && e.condParsed?.partidosMax === 0) &&
    (shift === 'TARDE' || e.dispParsed?.[d.dia]?.M !== false) &&
    (shift === 'MANANA' || e.dispParsed?.[d.dia]?.T !== false));
  const protectedMornings = new Set();
  for (const e of employees) {
    const peer = e.condicionesEstructuradas?.sincronitzatAmb?.empleadoId;
    if (Number.isSafeInteger(peer)) { protectedMornings.add(e.id); protectedMornings.add(peer); }
  }
  const keepsMorningSync = (e, old, next) => !protectedMornings.has(e.id) ||
    slots(old).includes('Manana') === slots(next).includes('Manana');
  const allowed = (e, d, shift) => {
    if (!personallyAllowed(e, d, shift)) return false;
    if (shift === 'LIBRE') return true;
    // The candidate replaces this day; its old shift must not consume the
    // exact-count allowance while the caller evaluates the replacement.
    const old = d.turno;
    try { d.turno = 'LIBRE'; return canAssign(e, d.dia, shift); }
    finally { d.turno = old; }
  };
  const change = (d, shift) => { d.turno = shift; d.horaEntrada = null; d.horaDescanso = null; };
  const adjustments = [];
  for (const e of employees) for (const d of schedulesById.get(e.id).dias) {
    if (!personallyAllowed(e, d, d.turno)) {
      adjustments.push({ employeeId: e.id, day: d.dia, from: d.turno, to: 'LIBRE' });
      change(d, 'LIBRE');
    }
  }
  // Lexicographically reduce excess, unassigned requests and uncovered slots.
  // Explicit work requests remain below hard bounds and above coverage minima.
  for (let pass = 0; pass < 1000; pass++) {
    const before = score();
    if (!before.hard && !before.requested && !before.missing) break;
    let best = null;
    for (const e of employees) for (const d of schedulesById.get(e.id).dias) for (const shift of SHIFTS) {
      if (shift === d.turno || !allowed(e, d, shift)) continue;
      const old = d.turno;
      const delta = shiftHours(e, shift) - shiftHours(e, old);
      if (delta > 0 && hours(e) + delta > remainingWeeklyHours(e)) continue;
      d.turno = shift;
      const after = score();
      d.turno = old;
      if (!improves(after, before)) continue;
      const requestedLoss = e.turnosPorDiaPreferencia?.[d.dia] === old && shift !== old ? 1 : 0;
      const rank = [after.hard, after.requested, after.missing, requestedLoss, Math.abs(delta)];
      if (!best || rank.some((v, i) => v < best.rank[i] && rank.slice(0, i).every((x, j) => x === best.rank[j]))) best = { e, d, shift, old, rank };
    }
    if (!best && !before.hard && (before.requested || before.missing)) {
      // A capped worker may need to move hours between days. Evaluate both
      // edits atomically; never accept an intermediate excess or new gap.
      for (const e of employees) {
        const entries = schedulesById.get(e.id).dias;
        for (const d of entries) for (const shift of SHIFTS) {
          const old = d.turno;
          if (shiftHours(e, shift) <= shiftHours(e, old) || !personallyAllowed(e, d, shift)) continue;
          for (const other of entries.filter(x => x !== d)) for (const lower of SHIFTS) {
            const otherOld = other.turno;
            if (shiftHours(e, lower) >= shiftHours(e, otherOld) || !allowed(e, other, lower)) continue;
            other.turno = lower;
            if (!allowed(e, d, shift)) { other.turno = otherOld; continue; }
            d.turno = shift;
            const after = score();
            const withinHours = hours(e) <= remainingWeeklyHours(e);
            d.turno = old; other.turno = otherOld;
            if (!withinHours || after.hard || !improves(after, before)) continue;
            const loss = Number(e.turnosPorDiaPreferencia?.[d.dia] === old) + Number(e.turnosPorDiaPreferencia?.[other.dia] === otherOld);
            const rank = [after.hard, after.requested, after.missing, loss, 0];
            if (!best || rank.some((v, i) => v < best.rank[i] && rank.slice(0, i).every((x, j) => x === best.rank[j]))) best = { e, d, shift, old, rank, other, lower, otherOld };
          }
        }
      }
    }
    if (!best) break;
    if (best.other) {
      change(best.other, best.lower);
      adjustments.push({ employeeId: best.e.id, day: best.other.dia, from: best.otherOld, to: best.lower });
    }
    change(best.d, best.shift);
    adjustments.push({ employeeId: best.e.id, day: best.d.dia, from: best.old, to: best.shift });
  }
  if (score().hard) throw new Error('No se ha podido obtener un borrador dentro de los máximos semanales y de cobertura.');
  // Late hour/coverage repairs can undo an exact morning/afternoon count.
  // Recover feasible conditions without erasing work, changing requested
  // shifts or worsening any other person's conditions. A same-day exchange
  // keeps role coverage unchanged when a one-person edit has no spare cover.
  const conditionScore = e => puntuacio(schedulesById.get(e.id).dias.filter(d =>
    !closedDays.includes(d.dia) && !e.diasAusente?.[d.dia] && !e.diasOcupadosOtrosEstablecimientos?.[d.dia]), e.condicionesEstructuradas);
  let examined = 0;
  for (let pass = 0; pass < 20 && examined < 20000; pass++) {
    let best = null;
    const baseline = score();
    for (const e of employees) {
      const before = conditionScore(e);
      if (!before) continue;
      for (const d of schedulesById.get(e.id).dias) {
        if (d.turno === 'LIBRE' || e.turnosPorDiaPreferencia?.[d.dia]) continue;
        const old = d.turno;
        for (const shift of SHIFTS.filter(t => t !== 'LIBRE' && t !== old)) {
          if (++examined > 20000) break;
          if (!keepsMorningSync(e, old, shift) || !allowed(e, d, shift)) continue;
          d.turno = shift;
          const after = conditionScore(e);
          if (after >= before || hours(e) > remainingWeeklyHours(e)) { d.turno = old; continue; }
          const changed = score();
          if (!changed.hard && changed.requested <= baseline.requested && changed.missing <= baseline.missing) best = { e, d, shift, old };
          if (!best) for (const partner of employees.filter(x => x.id !== e.id && x.funcion === e.funcion)) {
            const other = schedulesById.get(partner.id).dias.find(x => x.dia === d.dia);
            if (other.turno === 'LIBRE' || partner.turnosPorDiaPreferencia?.[d.dia]) continue;
            const otherOld = other.turno, partnerBefore = conditionScore(partner);
            for (const lower of SHIFTS.filter(t => t !== 'LIBRE' && t !== otherOld)) {
              if (++examined > 20000) break;
              if (!['Manana', 'Tarde'].every(period =>
                Number(slots(old).includes(period)) + Number(slots(otherOld).includes(period)) ===
                Number(slots(shift).includes(period)) + Number(slots(lower).includes(period))) || !keepsMorningSync(partner, otherOld, lower) || !allowed(partner, other, lower)) continue;
              other.turno = lower;
              const safe = hours(partner) <= remainingWeeklyHours(partner) && conditionScore(partner) <= partnerBefore;
              other.turno = otherOld;
              if (safe) { best = { e, d, shift, old, partner, other, lower, otherOld }; break; }
            }
            if (best || examined >= 20000) break;
          }
          d.turno = old;
          if (best || examined >= 20000) break;
        }
        if (best || examined >= 20000) break;
      }
      if (best || examined >= 20000) break;
    }
    if (!best) break;
    if (best.other) {
      change(best.other, best.lower);
      adjustments.push({ employeeId: best.partner.id, day: best.other.dia, from: best.otherOld, to: best.lower });
    }
    change(best.d, best.shift);
    adjustments.push({ employeeId: best.e.id, day: best.d.dia, from: best.old, to: best.shift });
  }
  return adjustments;
}
