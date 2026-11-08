import { entradaPara, salidaPara, descansoPara, duracionDescanso, aMinutos, aHora, shiftHours } from '../utils/shiftHours.js';

const DAYS = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
const CODES = { MANANA: 'M', TARDE: 'T', PARTIDO: 'D', LIBRE: 'F' };
const codeHours = employee => ({ M: shiftHours(employee, 'MANANA'), T: shiftHours(employee, 'TARDE'), D: shiftHours(employee, 'PARTIDO') });

// Called only after the existing live establishment/employee authorization.
// Pass business cells, never phone numbers, other shops or personnel tables.
export function excelSchedule(schedules, establishment, roster, week) {
  const people = new Map(roster.map(e => [e.id, { id: e.id, name: `${e.nombre} ${e.apellidos || ''}`.trim(), section: e.funcion, codeHours: codeHours(e), days: Array(7).fill(null) }]));
  for (const shift of schedules) {
    if (shift.establecimientoId !== establishment.id || shift.semana !== week || !DAYS.includes(shift.dia)) throw new Error('Torn fora de la botiga o setmana seleccionada.');
    if (!people.has(shift.empleadoId)) {
      const e = shift.empleado;
      if (!e || e.id !== shift.empleadoId) throw new Error('Persona del torn no disponible.');
      people.set(e.id, { id: e.id, name: `${e.nombre} ${e.apellidos || ''}`.trim(), section: e.funcion, codeHours: codeHours(e), days: Array(7).fill(null) });
    }
    const person = people.get(shift.empleadoId);
    const day = DAYS.indexOf(shift.dia);
    if (person.days[day]) throw new Error('Hi ha més d’un torn per persona i dia. Cal revisar-lo abans de preparar l’Excel.');
    const code = shift.ausencia === 'VACACIONES' ? 'V' : shift.ausencia === 'BAJA_MEDICA' ? 'B' : CODES[shift.turno];
    if (!code) throw new Error('Tipus de torn desconegut.');
    const value = { code, firstLine: '', secondLine: '' };
    if (['M', 'T', 'D'].includes(code)) {
      const start = shift.horaEntrada || entradaPara(shift.empleado, shift.turno);
      const end = salidaPara(shift.empleado, shift.turno, establishment, start);
      if (aMinutos(start) === null || aMinutos(end) === null) throw new Error('Hores del torn invàlides.');
      if (code === 'D') {
        const pause = shift.horaDescanso || descansoPara(shift.turno, establishment);
        const pauseMinutes = aMinutos(pause);
        if (pauseMinutes === null) throw new Error('Descans del torn invàlid.');
        value.firstLine = `${start}–${pause}`;
        value.secondLine = `${aHora(pauseMinutes + duracionDescanso(establishment))}–${end}`;
      } else value[code === 'T' ? 'secondLine' : 'firstLine'] = `${start}–${end}`;
    }
    // Keep both time intervals legible at the exact original column width.
    // Workday requests use the source's blue-code convention so its formulas
    // still compare the literal M/T/D code. SI fits in a free hours line.
    if (shift.peticio) {
      value.requested = true;
      if (!value.firstLine) value.firstLine = 'SI';
      else if (!value.secondLine) value.secondLine = 'SI';
    }
    person.days[day] = value;
  }
  return { establishmentId: establishment.id, establishmentName: establishment.nombre, week,
    people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name, 'ca')) };
}
