import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
process.env.WHATSAPP_MOCK = 'false';
process.env.WHATSAPP_PROVIDER = 'meta';
process.env.WHATSAPP_TOKEN = 'test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-number';
process.env.HORARIA_ALLOW_DELIVERY = '1';
process.env.HORARIA_ALLOW_AI = '0';
const { prisma } = await import('../src/services/prisma.js');
const { buidaMemoriaAjustos } = await import('../src/utils/ajustos.js');
const { handleIncomingMessage, properaFinestra, getConversationByPhone } = await import('../src/services/whatsapp.js');
let conv, messages, sent, employee;
const restorers = [];
function stub(target, key, fn) {
  const previous = target[key];
  target[key] = mock.fn(fn);
  restorers.push(() => { target[key] = previous; });
}
beforeEach(() => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-28T12:00:00') });
  buidaMemoriaAjustos(); conv = null; messages = []; sent = [];
  employee = { id: 1, nombre: 'Test', rol: 'EMPLEADO', activo: true, establecimientoId: 1, establecimiento: {} };
  stub(prisma.employee, 'findFirst', async ({where}) => { assert.equal(where.telefonoWhatsapp, '+34600000000'); return employee; });
  stub(prisma.ajuste, 'findMany', async () => []);
  stub(prisma.whatsappConversation, 'findUnique', async ({include}) => conv && ({ ...conv, ...(include ? { mensajes: messages } : {}) }));
  stub(prisma.whatsappConversation, 'create', async ({data}) => { assert.equal(conv, null); return conv = {id: 1, ...data}; });
  stub(prisma.whatsappConversation, 'update', async ({data}) => conv = {...conv, ...data});
  stub(prisma.whatsappMessage, 'create', async ({data}) => { messages.push(data); return data; });
  stub(prisma.whatsappMessage, 'findMany', async () => []);
  stub(prisma.shiftPreference, 'findFirst', async () => null);
  mock.method(globalThis, 'fetch', async (url, opts) => { assert.match(String(url), /^https:\/\/graph.facebook.com\/v23.0\/test-number\/messages$/); sent.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({messages:[{id:'test'}]}) }; });
});
afterEach(() => { restorers.splice(0).reverse().forEach(restore => restore()); mock.restoreAll(); mock.timers.reset(); buidaMemoriaAjustos(); });

test('first greeting opens active week and is visible in conversation read', async () => {
  assert.equal((await handleIncomingMessage('34600000000', 'prova')).reason, 'conversation_started');
  assert.equal(conv.semana, '2026-W41'); assert.equal(conv.fechaLimite.getDay(), 3);
  assert.equal(messages[0].direccion, 'entrante'); assert.equal(messages[0].contenido, 'prova');
  assert.equal(sent.length, 1); assert.match(sent[0].text.body, /Ja pots indicar/);
  assert.equal((await getConversationByPhone('+34600000000')).conversacion.mensajes.length, 2);
});
test('before opening records receipt and dates without collecting preferences', async () => {
  mock.timers.setTime(new Date('2026-09-26T12:00:00').getTime());
  assert.equal((await handleIncomingMessage('34600000000', 'No puc dimarts')).reason, 'before_window');
  assert.equal(messages[0].contenido, 'No puc dimarts'); assert.match(sent[0].text.body, /obre el/);
  assert.equal(prisma.shiftPreference.findFirst.mock.callCount(), 0);
});
test('unknown or inactive senders never open or read conversations', async () => {
  employee = null;
  assert.equal((await handleIncomingMessage('34600000000', 'hola')).reason, 'employee_not_found');
  assert.equal(prisma.employee.findFirst.mock.calls[0].arguments[0].where.activo, true);
  assert.equal(prisma.whatsappConversation.findUnique.mock.callCount(), 0); assert.equal(conv, null);
});
test('same-week block logs inbound without reply', async () => {
  conv = {id:1, semana:'2026-W41', bloqueada:true, fechaApertura:new Date('2026-09-27T09:00:00'), fechaLimite:new Date('2026-09-30T13:00:00')};
  assert.equal((await handleIncomingMessage('34600000000', 'hola')).reason, 'bloqueada');
  assert.equal(sent.length, 0); assert.equal(messages.length, 1);
});
test('new cycle preserves history and resets expired employee conversation', async () => {
  conv = {id:1, semana:'2026-W40', bloqueada:true, fechaApertura:new Date('2026-09-20T09:00:00'), fechaLimite:new Date('2026-09-23T13:00:00')};
  messages.push({contenido:'prior week',semana:'2026-W40'});
  assert.equal((await handleIncomingMessage('34600000000', 'hola')).reason, 'conversation_started');
  assert.equal(conv.semana, '2026-W41'); assert.equal(conv.bloqueada, false); assert.equal(messages[0].contenido, 'prior week');
});
test('substantive first message enters normal flow and survives AI failure', async () => {
  await assert.rejects(handleIncomingMessage('34600000000', 'No puc dimarts'), /IA|chatbot/);
  assert.equal(messages[0].contenido, 'No puc dimarts'); assert.equal(conv.semana, '2026-W41');
});
test('provider failure retains inbound and propagates error', async () => {
  mock.method(globalThis, 'fetch', async () => ({ok:false,status:401,text:async()=> 'test rejection'}));
  await assert.rejects(handleIncomingMessage('34600000000', 'hola'));
  assert.equal(messages.length, 1); assert.equal(messages[0].direccion, 'entrante');
});
test('configured opening, deadline, and year rollover', () => {
  const config={obreDia:2,obreHora:9,tancaDia:4,tancaHora:13};
  const next=properaFinestra(new Date('2026-09-28T12:00:00'),config);
  assert.equal(next.obre.getDay(),2); assert.equal(next.tanca.getDay(),4); assert.equal(next.semana,'2026-W41');
  assert.equal(properaFinestra(next.tanca,config).semana,next.semana);
  assert.notEqual(properaFinestra(new Date(next.tanca.getTime()+1),config).semana,next.semana);
  assert.equal(properaFinestra(new Date('2026-12-29T12:00:00'),config).semana,'2027-W01');
});

test('messages from before opening stay out of the collection context', async () => {
  conv = {id:1, semana:'2026-W41', bloqueada:true, fechaApertura:new Date('2026-09-27T09:00:00'), fechaLimite:new Date('2026-09-30T13:00:00')};
  await handleIncomingMessage('34600000000', 'hola');
  assert.deepEqual(prisma.whatsappMessage.findMany.mock.calls[0].arguments[0].where.createdAt, {gte:conv.fechaApertura});
});

test('existing manual conversations are neither reset nor given a new deadline', async () => {
  conv = {id:1, semana:'2026-W40', estado:'PENDIENTE', bloqueada:true, fechaApertura:null, fechaLimite:new Date('2026-09-23T13:00:00')};
  assert.equal((await handleIncomingMessage('34600000000', 'hola')).reason, 'bloqueada');
  assert.equal(prisma.whatsappConversation.update.mock.callCount(),0);
  assert.equal(conv.semana,'2026-W40');
});
