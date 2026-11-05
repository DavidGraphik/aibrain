import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { inspectWorkbook, compareReviewedWorkbook } from '../src/integration/reviewed-workbook.js';
import { createReviewedScheduleHandlers, sendReviewedExcel, sendReviewedPdf, reviewedPdfTemplate } from '../src/integration/reviewed-schedules.js';

const template = JSON.parse(await readFile(new URL('../../../../src/runtime/documents/templates/arnall-schedule.json', import.meta.url), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function setCell(xml, address, value) {
  const pattern = new RegExp(`<c\\b([^>]*\\br="${address}"[^>]*?)(?:\\s*/>|>[\\s\\S]*?</c>)`);
  assert.match(xml, pattern);
  return xml.replace(pattern, (_, attrs) => `<c${attrs.replace(/\s+t="[^"]*"/g, '')} t="inlineStr"><is><t>${value}</t></is></c>`);
}
function zip(parts) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, xml] of Object.entries(parts)) {
    const bytes = Buffer.from(xml), nameBytes = Buffer.from(name), compressed = deflateRawSync(bytes), crc = crc32(bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed); centrals.push(central, nameBytes); offset += local.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function workbooks() {
  const original = { ...template };
  for (const [address, value] of Object.entries({ G4: 'Shop', O4: '2026', D4: '42', B6: 'Test Employee', E6: 'M', F6: '08:00–15:00' })) original['xl/worksheets/sheet1.xml'] = setCell(original['xl/worksheets/sheet1.xml'], address, value);
  const corrected = { ...original };
  for (const [address, value] of Object.entries({ E6: 'T', F6: '', F7: '14:45–20:45' })) corrected['xl/worksheets/sheet1.xml'] = setCell(corrected['xl/worksheets/sheet1.xml'], address, value);
  return { original, corrected, sourceBytes: zip(original), correctedBytes: zip(corrected) };
}
const files = workbooks();
function fixture() {
  const states = new Map(), calls = [], input = { recipient: { id: 9, nombre: 'Test', apellidos: 'Employee', telefonoWhatsapp: '+34600000000' }, managerId: 9, inbound: '2026-10-08T10:00:00Z', failSend: false, templateApproved: true, templateName: 'schedule_pdf' };
  const handlers = createReviewedScheduleHandlers({
    database: { establishment: { findUnique: async () => ({ id: 3, nombre: 'Shop', activo: true, managerLocalId: input.managerId }) },
      employee: { findFirst: async ({ where }) => { assert.equal(where.activo, true); assert.equal(where.OR[0].establecimientoId, 3); return where.id === input.recipient.id ? input.recipient : null; } },
      whatsappMessage: { findFirst: async () => input.inbound ? { createdAt: new Date(input.inbound) } : null } },
    load: name => states.has(name) ? structuredClone(states.get(name)) : null,
    save: (name, data) => states.set(name, structuredClone(data)), preflight: () => {}, now: () => new Date('2026-10-08T11:00:00Z'),
    pdfTemplate: async () => { if (!input.templateApproved) throw new Error('not approved'); return { name: input.templateName, language: 'ca' }; },
    sendPdf: async (phone, bytes, filename, template) => { calls.push({ phone, bytes, filename, template }); if (input.failSend) throw new Error('timeout'); return { providerMessageId: 'wamid.pdf', providerMediaId: '5678' }; },
    send: async (phone, bytes, filename) => { calls.push({ phone, bytes, filename }); if (input.failSend) throw new Error('timeout after dispatch'); return { providerMessageId: 'wamid.test', providerMediaId: '1234' }; },
  });
  async function call(handler, body = {}, extra = {}) {
    const req = { body: { establecimientoId: 3, ...body }, query: {}, params: {}, horariaClaims: { actorId: 'owner', installationId: 'tenant' }, user: { rol: 'MANAGER_GENERAL' }, ...extra };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
    await handlers[handler](req, res); return res;
  }
  const upload = bytes => ({ horariaUploads: [{ fieldname: 'workbook', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', originalname: 'returned.xlsx', size: bytes.length, buffer: bytes }] });
  const pdf = Buffer.from('%PDF-1.7\nsynthetic corrected schedule\n%%EOF');
  const pdfUpload = () => ({ horariaUploads: [...upload(files.correctedBytes).horariaUploads, { fieldname: 'reviewedPdf', mimetype: 'application/pdf', originalname: 'reviewed.pdf', size: pdf.length, buffer: pdf }] });
  const pdfFields = { deliveryFormat: 'pdf', pdfSha256: digest(pdf), pdfSourceSha256: digest(files.correctedBytes), pdfPages: '1' };
  async function prepare(format = 'xlsx') {
    const source = await call('source', { semana: '2026-W42', sha256: digest(files.sourceBytes) }, upload(files.sourceBytes)); assert.equal(source.code, 200, JSON.stringify(source.body));
    const review = await call('review', { sourceId: source.body.sourceId, ...(format === 'pdf' ? pdfFields : {}) }, format === 'pdf' ? pdfUpload() : upload(files.correctedBytes)); assert.equal(review.code, 200, JSON.stringify(review.body));
    return { source: source.body, review: review.body, sendBody: { reviewId: review.body.reviewId, sha256: review.body.sha256, previewHash: review.body.previewHash } };
  }
  return { states, calls, input, call, prepare, upload, pdf, pdfUpload, pdfFields };
}

test('review preserves every byte and formula while reporting the manual shift/time corrections', () => {
  const before = digest(files.correctedBytes), result = compareReviewedWorkbook(files.sourceBytes, files.correctedBytes);
  assert.deepEqual(result.changes.map(c => c.cell).sort(), ['E6', 'F6', 'F7']);
  assert.equal(digest(files.correctedBytes), before);
  assert.equal(inspectWorkbook(files.sourceBytes).grid[0].cells.get('T6').formula.text, inspectWorkbook(files.correctedBytes).grid[0].cells.get('T6').formula.text);
});
test('foreign shop/person, hidden auxiliary changes, formulas, extra sheets, external links and unused strings are rejected', () => {
  const bad = [];
  for (const [cell, value] of [['G4', 'Other shop'], ['B6', 'Foreign Employee']]) bad.push({ ...files.corrected, 'xl/worksheets/sheet1.xml': setCell(files.corrected['xl/worksheets/sheet1.xml'], cell, value) });
  bad.push({ ...files.corrected, 'xl/worksheets/sheet2.xml': setCell(files.corrected['xl/worksheets/sheet2.xml'], 'A1', 'Other store employee') });
  bad.push({ ...files.corrected, 'xl/worksheets/sheet1.xml': files.corrected['xl/worksheets/sheet1.xml'].replace('<f>', '<f>1+') });
  bad.push({ ...files.corrected, 'xl/worksheets/sheet5.xml': '<worksheet/>' });
  bad.push({ ...files.corrected, 'xl/_rels/workbook.xml.rels': files.corrected['xl/_rels/workbook.xml.rels'].replace('Target="worksheets/sheet1.xml"', 'Target="https://example.test/private" TargetMode="External"') });
  bad.push({ ...files.corrected, 'xl/sharedStrings.xml': '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Other shop hidden data</t></si></sst>' });
  bad.push({ ...files.corrected, 'xl/worksheets/sheet1.xml': files.corrected['xl/worksheets/sheet1.xml'].replace(/(<c r="E6"[^>]*s=")[^"]+/, '$19999') });
  bad.push({ ...files.corrected, 'xl/worksheets/sheet1.xml': files.corrected['xl/worksheets/sheet1.xml'].replace(/(<row r="6"[^>]*ht=")[^"]+/, '$1999') });
  for (const parts of bad) assert.throws(() => compareReviewedWorkbook(files.sourceBytes, zip(parts)));
  const corrupt = Buffer.from(files.correctedBytes); corrupt[100] ^= 1;
  assert.throws(() => inspectWorkbook(corrupt));
});
test('review/send/status retain exact corrected bytes, bound recipient and provider receipt without duplicate sends', async () => {
  const f = fixture(), prepared = await f.prepare();
  assert.equal(f.calls.length, 0);
  assert.equal(prepared.review.sha256, digest(files.correctedBytes));
  const sent = await f.call('send', prepared.sendBody); assert.equal(sent.code, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.status, 'accepted'); assert.equal(sent.body.result.deliveryConfirmed, false);
  assert.ok(f.calls[0].bytes.equals(files.correctedBytes)); assert.equal(f.calls[0].phone, '+34600000000');
  assert.equal((await f.call('send', prepared.sendBody)).body.status, 'accepted'); assert.equal(f.calls.length, 1);
  const status = await f.call('status', {}, { params: { id: prepared.review.reviewId } });
  assert.equal(status.body.result.sha256, digest(files.correctedBytes));
});
test('different actor/shop, stale hash and changed recipient cannot deliver a reviewed file', async () => {
  const f = fixture(), { sendBody } = await f.prepare();
  assert.equal((await f.call('send', sendBody, { horariaClaims: { actorId: 'other', installationId: 'tenant' } })).code, 404);
  assert.equal((await f.call('send', { ...sendBody, establecimientoId: 4 })).code, 404);
  assert.equal((await f.call('send', { ...sendBody, sha256: '0'.repeat(64) })).code, 409);
  f.input.recipient.telefonoWhatsapp = '+34600000001';
  assert.equal((await f.call('send', sendBody)).code, 409); assert.equal(f.calls.length, 0);
});
test('expired service window blocks XLSX instead of misusing the PDF template', async () => {
  const f = fixture(), { sendBody } = await f.prepare(); f.input.inbound = '2026-10-07T10:00:00Z';
  assert.equal((await f.call('send', sendBody)).code, 409); assert.equal(f.calls.length, 0);
});
test('an absent manager does not discard the returned original, but cannot send until a recipient is reviewed', async () => {
  const f = fixture(); f.input.managerId = null;
  const { review, sendBody } = await f.prepare();
  assert.equal(review.sha256, digest(files.correctedBytes));
  assert.equal(review.recipient, null); assert.match(review.deliveryBlocker, /responsable/);
  assert.equal((await f.call('send', sendBody)).code, 409); assert.equal(f.calls.length, 0);
});
test('unknown provider outcome survives re-reading and never automatically retries', async () => {
  const f = fixture(), { sendBody } = await f.prepare(); f.input.failSend = true;
  assert.equal((await f.call('send', sendBody)).body.status, 'uncertain');
  assert.equal((await f.call('send', sendBody)).code, 409); assert.equal(f.calls.length, 1);
});
test('Meta transport uploads the exact XLSX then sends only that media to the selected phone', async t => {
  const values = { HORARIA_ALLOW_DELIVERY: '1', WHATSAPP_MOCK: 'false', WHATSAPP_PROVIDER: 'meta', WHATSAPP_TOKEN: 'synthetic-test-token', WHATSAPP_PHONE_NUMBER_ID: '1000' };
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(url);
    assert.equal(options.method, 'POST');
    if (requests.length === 1) {
      assert.equal(url, 'https://graph.facebook.com/v23.0/1000/media');
      const file = options.body.get('file');
      assert.equal(file.name, 'reviewed.xlsx');
      assert.equal(file.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      assert.ok(Buffer.from(await file.arrayBuffer()).equals(files.correctedBytes));
      return Response.json({ id: '2000' });
    }
    assert.equal(url, 'https://graph.facebook.com/v23.0/1000/messages');
    const message = JSON.parse(options.body);
    assert.equal(message.to, '+34600000000');
    assert.equal(message.type, 'document');
    assert.equal(message.document.id, '2000');
    assert.equal(message.document.filename, 'reviewed.xlsx');
    assert.equal(message.template, undefined);
    return Response.json({ messages: [{ id: 'wamid.synthetic' }] });
  });
  assert.deepEqual(await sendReviewedExcel('+34600000000', files.correctedBytes, 'reviewed.xlsx'), { providerMessageId: 'wamid.synthetic', providerMediaId: '2000' });
  assert.equal(requests.length, 2);
});

test('PDF sends the frozen conversion with an approved template even without any inbound reply', async () => {
  const f = fixture(); f.input.inbound = null;
  const { review, sendBody } = await f.prepare('pdf');
  assert.equal(review.recipient.windowOpen, false); assert.equal(review.deliveryBlocker, null);
  assert.equal(review.pdf.sourceSha256, digest(files.correctedBytes));
  assert.equal(review.pdf.sha256, digest(f.pdf)); assert.equal(review.pdf.bytes, undefined);
  assert.equal(f.calls.length, 0);
  const result = await f.call('send', sendBody);
  assert.equal(result.code, 200, JSON.stringify(result.body)); assert.equal(result.body.status, 'accepted');
  assert.equal(result.body.result.sha256, digest(f.pdf)); assert.equal(result.body.result.workbookSha256, digest(files.correctedBytes));
  assert.ok(f.calls[0].bytes.equals(f.pdf)); assert.match(f.calls[0].filename, /\.pdf$/);
  assert.deepEqual(f.calls[0].template, { name: 'schedule_pdf', language: 'ca', bodyParameters: ['Test Employee', 'Shop', 'del 12 al 18 d’octubre'.replace('’', "'")] });
  assert.ok(Buffer.from(f.states.get(`reviewed-${review.reviewId}.json`).bytes, 'base64').equals(files.correctedBytes));
  await f.call('send', sendBody); assert.equal(f.calls.length, 1);
});
test('PDF identity is separate from a previously accepted XLSX; re-review reuses the preserved PDF', async () => {
  const f = fixture(), excel = await f.prepare(); await f.call('send', excel.sendBody);
  const pdf = await f.prepare('pdf'); assert.notEqual(pdf.review.reviewId, excel.review.reviewId);
  const other = Buffer.from('%PDF-1.7\nnew conversion timestamp\n%%EOF'), upload = f.pdfUpload();
  upload.horariaUploads[1].buffer = other; upload.horariaUploads[1].size = other.length;
  const reread = await f.call('review', { sourceId: pdf.source.sourceId, ...f.pdfFields, pdfSha256: digest(other) }, upload);
  assert.equal(reread.body.pdf.sha256, digest(f.pdf)); assert.equal(reread.body.previewHash, pdf.review.previewHash);
});
test('wrong PDF source/hash, extra attachments and untrusted format cannot become a reviewed PDF', async () => {
  const f = fixture(), { source } = await f.prepare();
  for (const change of [{ pdfSourceSha256: '0'.repeat(64) }, { pdfSha256: '0'.repeat(64) }, { pdfPages: '2' }, { deliveryFormat: 'html' }]) {
    assert.equal((await f.call('review', { sourceId: source.sourceId, ...f.pdfFields, ...change }, f.pdfUpload())).code, 400);
  }
  const upload = f.pdfUpload(); upload.horariaUploads.push(upload.horariaUploads[1]);
  assert.equal((await f.call('review', { sourceId: source.sourceId, ...f.pdfFields }, upload)).code, 400);
  assert.equal(f.calls.length, 0);
});
test('PDF template revocation, config changes and content corruption fail before provider effects', async () => {
  for (const mutate of [f => { f.input.templateApproved = false; }, f => { f.input.templateName = 'other'; },
    (f, id) => { f.states.get(`reviewed-${id}.json`).pdf.bytes = Buffer.from('tampered').toString('base64'); }]) {
    const f = fixture(), { review, sendBody } = await f.prepare('pdf'); mutate(f, review.reviewId);
    assert.equal((await f.call('send', sendBody)).code, 409); assert.equal(f.calls.length, 0);
    assert.equal(f.states.get(`reviewed-${review.reviewId}.json`).status, 'reviewed');
  }
});
test('missing approval preserves PDF and original, while uncertain PDF delivery never automatically repeats', async () => {
  const f = fixture(); f.input.templateApproved = false;
  const blocked = await f.prepare('pdf'); assert.match(blocked.review.deliveryBlocker, /TEMPLATE/);
  assert.equal((await f.call('send', blocked.sendBody)).code, 409); assert.equal(f.calls.length, 0);
  f.input.templateApproved = true;
  const ready = await f.prepare('pdf'); f.input.failSend = true;
  assert.equal((await f.call('send', ready.sendBody)).body.status, 'uncertain');
  assert.equal((await f.call('send', ready.sendBody)).code, 409); assert.equal(f.calls.length, 1);
});
test('PDF review retains actor, installation, shop, recipient and PDF-version authorization', async () => {
  const f = fixture(), { review, sendBody } = await f.prepare('pdf');
  assert.equal((await f.call('send', sendBody, { horariaClaims: { actorId: 'other', installationId: 'tenant' } })).code, 404);
  assert.equal((await f.call('send', sendBody, { horariaClaims: { actorId: 'owner', installationId: 'other' } })).code, 404);
  assert.equal((await f.call('send', { ...sendBody, establecimientoId: 4 })).code, 404);
  const record = f.states.get(`reviewed-${review.reviewId}.json`); record.pdf.sha256 = 'f'.repeat(64);
  assert.equal((await f.call('send', sendBody)).code, 409); assert.equal(f.calls.length, 0);
});
test('Meta PDF transport checks approved document template and uploads frozen PDF without a public URL', async t => {
  const values = { HORARIA_ALLOW_DELIVERY: '1', WHATSAPP_MOCK: 'false', WHATSAPP_PROVIDER: 'meta', WHATSAPP_TOKEN: 'synthetic', WHATSAPP_PHONE_NUMBER_ID: '1000', WHATSAPP_BUSINESS_ACCOUNT_ID: '3000', WHATSAPP_TEMPLATE_HORARIO: 'schedule_pdf:ca' };
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const bytes = Buffer.from('%PDF-1.7\nsynthetic\n%%EOF'), calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    if (url.includes('message_templates')) return Response.json({ data: [{ name: 'schedule_pdf', language: 'ca', status: 'APPROVED', components: [{ type: 'HEADER', format: 'DOCUMENT' }, { type: 'BODY', text: '{{1}} {{2}} {{3}}' }] }] });
    assert.equal(options.method, 'POST');
    if (url.endsWith('/media')) {
      const file = options.body.get('file'); assert.equal(file.type, 'application/pdf'); assert.ok(Buffer.from(await file.arrayBuffer()).equals(bytes));
      return Response.json({ id: '2000' });
    }
    const message = JSON.parse(options.body); assert.equal(message.to, '+34600000000'); assert.equal(message.type, 'template');
    assert.deepEqual(message.template, { name: 'schedule_pdf', language: { code: 'ca' }, components: [
      { type: 'header', parameters: [{ type: 'document', document: { id: '2000', filename: 'reviewed.pdf' } }] },
      { type: 'body', parameters: ['Name', 'Shop', 'Week'].map(text => ({ type: 'text', text })) },
    ] }); assert.equal(message.document, undefined);
    return Response.json({ messages: [{ id: 'wamid.pdf' }] });
  });
  const template = await reviewedPdfTemplate();
  const receipt = await sendReviewedPdf('+34600000000', bytes, 'reviewed.pdf', { ...template, bodyParameters: ['Name', 'Shop', 'Week'] });
  assert.equal(receipt.providerMessageId, 'wamid.pdf'); assert.equal(calls.length, 3);
});
