import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excelSchedule } from '../src/integration/excel-schedule.js';

const employee = { id: 1, nombre: 'Persona', apellidos: 'Prova', funcion: 'DEPENDIENTA', horasPorTurno: 4, telefonoWhatsapp: 'PRIVATE_PHONE' };
const establishment = { id: 2, nombre: 'Botiga prova' };
const shift = { empleadoId: 1, empleado: employee, establecimientoId: 2, semana: '2026-W38', dia: 'LUNES', turno: 'MANANA', horaEntrada: '08:00' };

test('native Excel cells preserve reduced hours, absences, requests and unassigned people without private fields', () => {
  const result = excelSchedule([{...shift,peticio:'MANANA'}, {...shift,dia:'MARTES',turno:'LIBRE',ausencia:'VACACIONES'}], establishment, [employee,{...employee,id:2,nombre:'Sense torns'}], shift.semana);
  assert.deepEqual(result.people[0].days[0],{code:'M',firstLine:'08:00–12:00',secondLine:'SI',requested:true});
  assert.deepEqual(result.people[0].codeHours,{M:4,T:4,D:8});
  assert.equal(result.people[0].days[1].code,'V');
  assert.equal(result.people[0].days[2],null);
  assert.deepEqual(result.people[1].days,Array(7).fill(null));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_PHONE'));
});
test('split shifts keep the two working intervals with the actual break', () => {
  const result=excelSchedule([{...shift,empleado:{...employee,horasPorTurno:null},turno:'PARTIDO',horaEntrada:'07:30',horaDescanso:'13:30'}], establishment,[employee],shift.semana);
  assert.deepEqual(result.people[0].days[0],{code:'D',firstLine:'07:30–13:30',secondLine:'16:30–20:30'});
});
test('another shop, another week or duplicate daily shifts cannot enter a recipient workbook', () => {
  for (const invalid of [{...shift,establecimientoId:3},{...shift,semana:'2026-W39'}]) {
    assert.throws(()=>excelSchedule([invalid],establishment,[employee],shift.semana));
  }
  assert.throws(()=>excelSchedule([shift,shift],establishment,[employee],shift.semana));
});
