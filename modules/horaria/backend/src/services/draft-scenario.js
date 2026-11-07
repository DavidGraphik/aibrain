import { checkEmployeeConditions } from './conditionCheck.js';
import { ruleForDay } from '../utils/ruleForDay.js';
import { shiftHours } from '../utils/shiftHours.js';

export const DAYS = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const days = value => Array.isArray(value) && value.length <= 7 && new Set(value).size === value.length && value.every(day => DAYS.includes(day));

const COVERAGE_MINIMUMS = ['minDependientasManana', 'minDependientasTarde', 'minElaboracionManana', 'minElaboracionTarde'];

export function validateDraftCoverage(coverage) {
  if (coverage === undefined) return;
  if (!record(coverage) || !Object.keys(coverage).length || Object.entries(coverage).some(([key, value]) =>
    !COVERAGE_MINIMUMS.includes(key) || !Number.isSafeInteger(value) || value < 0 || value > 99)) {
    throw new Error('Cobertura temporal no válida: indica mínimos de personas por función y turno.');
  }
}

// Add the requested weekly targets to every applicable rule in memory. Keep
// stricter saved minima, maxima and day scopes; never relax a business rule.
export function applyDraftCoverage(coverage, rules) {
  validateDraftCoverage(coverage);
  if (coverage === undefined) return rules;
  const temporaryRule = { nombre: 'Cobertura temporal del borrador', diasAplica: null, minPersonasDescansoPartido: 0,
    ...Object.fromEntries(COVERAGE_MINIMUMS.map(key => [key, 0])) };
  return (rules.length ? rules : [temporaryRule]).map(rule => ({
    ...rule,
    ...Object.fromEntries(Object.entries(coverage).map(([key, value]) => [key, Math.max(rule[key] ?? 0, value)])),
  }));
}

export function validateDraftRequests(requests, employees) {
  if (!Array.isArray(requests) || requests.length > employees.length) throw new Error('Peticiones de simulación no válidas.');
  const ids = new Set();
  for (const r of requests) {
    if (!record(r) || Object.keys(r).some(k => !['employeeId', 'daysOff', 'shiftsByDay', 'requiredShiftsByDay', 'noSplit', 'absences', 'maxHours'].includes(k)) ||
        !Number.isSafeInteger(r.employeeId) || ids.has(r.employeeId) || !employees.some(e => e.id === r.employeeId) ||
        (r.daysOff !== undefined && !days(r.daysOff)) ||
        (r.noSplit !== undefined && typeof r.noSplit !== 'boolean') ||
        (r.maxHours !== undefined && (!Number.isFinite(r.maxHours) || r.maxHours < 0 || r.maxHours > 168)) ||
        (r.shiftsByDay !== undefined && (!record(r.shiftsByDay) || Object.entries(r.shiftsByDay).some(([d, t]) => !DAYS.includes(d) || !['MANANA', 'TARDE'].includes(t)))) ||
        (r.requiredShiftsByDay !== undefined && (!record(r.requiredShiftsByDay) || Object.entries(r.requiredShiftsByDay).some(([d, t]) =>
          !DAYS.includes(d) || !['MANANA', 'TARDE'].includes(t) || (r.shiftsByDay?.[d] && r.shiftsByDay[d] !== t)))) ||
        (r.absences !== undefined && (!record(r.absences) || Object.entries(r.absences).some(([d, t]) => !DAYS.includes(d) || !['VACACIONES', 'BAJA_MEDICA'].includes(t))))) {
      throw new Error('Petición no admitida o persona ajena a la tienda.');
    }
    ids.add(r.employeeId);
  }
}

// These objects are the scheduler's in-memory snapshot, never database records.
export function applyDraftRequests(requests, employees) {
  validateDraftRequests(requests, employees);
  for (const r of requests) {
    const e = employees.find(e => e.id === r.employeeId);
    for (const d of r.daysOff || []) e.diasPreferenciaLibre[d] = true;
    Object.assign(e.turnosPorDiaPreferencia, r.shiftsByDay || {});
    e.turnosRequeridosBorrador = { ...r.requiredShiftsByDay };
    Object.assign(e.turnosPorDiaPreferencia, e.turnosRequeridosBorrador);
    Object.assign(e.diasAusente, r.absences || {});
    if (r.maxHours !== undefined) e.maxHorasSemana = Math.min(e.maxHorasSemana, r.maxHours);
    if (r.noSplit) {
      e.condParsed = { ...e.condParsed, partidosMax: 0 };
      e.condicionesFijas = `${e.condicionesFijas || ''}. No fa mai torns PARTIDO.`;
    }
  }
}

/** Check the FINAL grid, not the model's claims or the saved week's conflicts. */
export function reviewDraft(schedules, employees, rules, closedDays, requests, freeRules) {
  const checks = [];
  const unverifiedConditions = [];
  const companys = employees.map(e => ({ empleado: e, dias: schedules.filter(s => s.empleadoId === e.id) }));
  const check = (employeeId, requirement, ok, detail) => checks.push({ employeeId, requirement, status: ok ? 'respected' : 'conflict', detail });
  for (const e of employees) {
    const shifts = schedules.filter(s => s.empleadoId === e.id);
    const work = shifts.filter(s => s.turno !== 'LIBRE');
    const hours = work.reduce((sum, s) => sum + shiftHours(e, s.turno), 0) + (e.horasYaTrabajadas || 0);
    check(e.id, 'Horas máximas semanales', hours <= e.maxHorasSemana, `${hours} / ${e.maxHorasSemana} h, incluyendo otras tiendas`);
    check(e.id, 'Semana completa', DAYS.every(d => shifts.filter(s => s.dia === d).length === 1), 'Un turno o día libre por persona y día');
    for (const s of work) {
      const slot = e.dispParsed?.[s.dia];
      const available = s.turno === 'MANANA' ? slot?.M !== false : s.turno === 'TARDE' ? slot?.T !== false : slot?.M !== false && slot?.T !== false;
      check(e.id, `Disponibilidad ${s.dia}`, available && !closedDays.includes(s.dia) && !e.diasAusente[s.dia] && !e.diasPreferenciaLibre[s.dia] && !e.diasOcupadosOtrosEstablecimientos?.[s.dia] && (!e.turnosPorDiaPreferencia[s.dia] || e.turnosPorDiaPreferencia[s.dia] === s.turno), s.turno);
    }
    const fixed = checkEmployeeConditions({ empleado: e, dias: shifts,
      diasHabituales: DAYS.filter(d => !closedDays.includes(d)), companys, idioma: 'es',
      diesDemanats: Object.keys(e.turnosPorDiaPreferencia || {}) });
    for (const problem of fixed.problemas) check(e.id, 'Condiciones fijas', false, problem);
    for (const text of fixed.cond.noInterpretadas) unverifiedConditions.push(`Persona ${e.id}: condición no verificada: ${text}`);
    const structured = e.condicionesEstructuradas || {};
    const split = work.filter(s => s.turno === 'PARTIDO').length;
    const morning = work.filter(s => s.turno === 'MANANA').length + (structured.partidoCompta === 'MATI_I_TARDA' ? split : 0);
    const afternoon = work.filter(s => s.turno === 'TARDE').length + (['TARDA', 'MATI_I_TARDA'].includes(structured.partidoCompta) ? split : 0);
    for (const [field, actual, label, exact] of [
      ['maxPartidos', split, 'partidos', false], ['partidosExactes', split, 'partidos', true],
      ['maxTardes', afternoon, 'tardes', false], ['tardesExactes', afternoon, 'tardes', true],
      ['matinsExactes', morning, 'mañanas', true],
    ]) if (structured[field] !== undefined) check(e.id, 'Condiciones estructuradas',
      exact ? actual === structured[field] : actual <= structured[field],
      `${actual} ${label}; ${exact ? 'exactamente' : 'máximo'} ${structured[field]}`);
    const r = requests.find(r => r.employeeId === e.id);
    if (r?.noSplit) check(e.id, 'Sin turnos partidos', !work.some(s => s.turno === 'PARTIDO'), 'Petición de la simulación');
    for (const d of r?.daysOff || []) check(e.id, `${d} libre`, shifts.some(s => s.dia === d && s.turno === 'LIBRE'), 'Petición de la simulación');
    for (const [d, t] of Object.entries(r?.shiftsByDay || {})) check(e.id, `${d} solo ${t}`, shifts.some(s => s.dia === d && [t, 'LIBRE'].includes(s.turno)), 'Petición de la simulación');
    for (const [d, t] of Object.entries(r?.requiredShiftsByDay || {})) check(e.id, `${d} ${t} asignada`,
      shifts.some(s => s.dia === d && s.turno === t), 'Turno solicitado; libre no equivale a asignado');
    for (const [d, t] of Object.entries(r?.absences || {})) check(e.id, `${d} ${t}`, shifts.some(s => s.dia === d && s.turno === 'LIBRE' && s.ausencia === t), 'Ausencia simulada, sin guardar');
  }
  for (const d of DAYS.filter(d => !closedDays.includes(d))) {
    const rule = ruleForDay(rules, d);
    if (!rule) continue;
    for (const [role, suffix] of [['DEPENDIENTA', 'Dependientas'], ['ELABORACION', 'Elaboracion']]) {
      for (const [shift, period] of [['MANANA', 'Manana'], ['TARDE', 'Tarde']]) {
        const count = schedules.filter(s => s.dia === d && [shift, 'PARTIDO'].includes(s.turno) && s.empleado.funcion === role).length;
        const min = rule[`min${suffix}${period}`] ?? 0;
        const max = rule[`max${suffix}${period}`] ?? Infinity;
        check(null, `${d} ${role} ${shift}`, count >= min && count <= max, `${count} personas; mínimo ${min}${Number.isFinite(max) ? `, máximo ${max}` : ''}`);
      }
    }
  }
  const notVerified = [...unverifiedConditions, 'Equidad histórica, alternancia de sábados y tiempo de descanso: no certificados por esta revisión.'];
  const unconfiguredDays = DAYS.filter(d => !closedDays.includes(d) && !ruleForDay(rules, d));
  if (rules.length && unconfiguredDays.length) notVerified.push(`No hay cobertura configurada para: ${unconfiguredDays.join(', ')}.`);
  if (!rules.length) notVerified.push('No hay reglas de cobertura configuradas; no se puede certificar la cobertura.');
  if (freeRules.length || employees.some(e => e.condicionesFijas || e.condicionesEstructuradas)) notVerified.push('El motor ha recibido las condiciones fijas y reglas de texto, pero esta revisión no certifica su cumplimiento completo.');
  return { checks, conflicts: checks.filter(c => c.status === 'conflict'), notVerified,
    allRespected: checks.some(c => c.status === 'conflict') ? false : null,
    explanation: 'Borrador calculado con los datos cargados y las peticiones temporales indicadas. Los días libres, ausencias y límites personales tienen prioridad sobre la cobertura. Revisa los conflictos antes de guardar o publicar. No se ha modificado ni enviado ningún horario.' };
}
