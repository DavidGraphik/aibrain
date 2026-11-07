import { createHash } from 'node:crypto';

/** Solitium API v3.4 pp73–87; tenant metadata read 2026-10-27. No network or authorization here. */
export type SagePurchaseReceipt = {
  id: string; vendorId: string; issueDate: string; receiptSerie: string; storeId: string; productId: string; quantity: string;
  purchase: { period: number; serie: string; number: number; position: number };
  unitPrice?: string; measureUnit?: string; vatPercent?: string; vatGroup?: string; vatCode?: string;
};
export type SageReceiptIdentity = { companyCode: '1'; period: number; serie: string; number: number };
export type SageReceiptExpected = Pick<SagePurchaseReceipt, 'id' | 'vendorId' | 'productId' | 'quantity'>;
export type SageReceiptStockExpected = Pick<SagePurchaseReceipt, 'productId' | 'quantity' | 'storeId'> & { document: SageReceiptIdentity; measureUnit: string };
export type SageReceiptReconciliation =
  | { status: 'none' }
  | { status: 'one'; document: SageReceiptIdentity }
  | { status: 'multiple'; count: number }
  | { status: 'incompatible'; reason: 'company' | 'vendor' | 'identity' | 'lines' | 'quantity' };
export type SageReceiptWriteResponse =
  | { status: 'identified'; document: SageReceiptIdentity; processId?: string }
  | { status: 'pending'; processId: string }
  | { status: 'unknown' };
export type SageReceiptStockProof =
  | { status: 'none' }
  | { status: 'one'; movementId: string }
  | { status: 'multiple'; count: number }
  | { status: 'incompatible' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
function invalid(): never { throw new Error('SAGE_RECEIPT_ARGUMENTS_INVALID'); }
function field(v: unknown, max: number, empty = false): string {
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u001f\u007f]/u.test(v) || (!empty && !v.trim())) return invalid();
  return v;
}
function id(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) return invalid(); return value.toLowerCase(); }
function int(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid();
  return value;
}
function decimal(value: unknown, positive = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,14})(\.\d{1,6})?$/u.test(value) || (positive && Number(value) <= 0)) return invalid();
  return value;
}
function day(value: unknown): string {
  const v = field(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) return invalid();
  return v;
}
function lineUuid(documentId: string): string {
  const bytes = createHash('sha1').update(Buffer.from(documentId.replaceAll('-', ''), 'hex')).update('line:1').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export function sageReceiptMarker(receiptId: string): string { return 'AI:' + id(receiptId); }

/** Exactly one ALP, never a second standalone stock movement. Persist its immutable payload before dispatch. */
export function buildSagePurchaseReceipt(input: SagePurchaseReceipt) {
  if (!record(input) || !record(input.purchase)) return invalid();
  const documentId = id(input.id), lineId = lineUuid(documentId), marker = sageReceiptMarker(documentId);
  const issueDate = day(input.issueDate), vendorId = field(input.vendorId, 15), productId = field(input.productId, 20), storeId = field(input.storeId, 4);
  const quantity = decimal(input.quantity, true), period = int(input.purchase.period, 1900, 2199);
  const serie = field(input.purchase.serie, 10, true), receiptSerie = field(input.receiptSerie, 10, true);
  const number = int(input.purchase.number, 1, 2147483647), position = int(input.purchase.position, 1, 2147483647);
  const values: Record<string, string> = { CodigoEmpresa: '1', CodigoDocumentoLc: 'ALP', TipoImportacionIME: '0',
    Renumerar: '1', EjercicioDocumento: issueDate.slice(0,4), SerieDocumento: receiptSerie, NumeroDocumento: '0',
    FechaDocumento: issueDate + 'T00:00:00', CodigoProveedor: vendorId, IdDocumento: documentId, ObservacionesDocumento: marker };
  const line: Record<string, string> = { CodigoEmpresa: '1', CodigoDocumentoLc: 'ALP', EjercicioDocumento: issueDate.slice(0,4),
    SerieDocumento: receiptSerie, NumeroDocumento: '0', Orden: String(position), FechaDocumento: values.FechaDocumento,
    CodigoArticulo: productId, CodigoAlmacen: storeId, Unidades: quantity, IdDocumento: documentId, IdDocumentoLin: lineId,
    EjercicioOrigen: String(period), SerieOrigen: serie, NumeroOrigen: String(number) };
  if (input.unitPrice !== undefined) line.Precio = decimal(input.unitPrice);
  if (input.measureUnit !== undefined) line.UnidadMedida1_ = field(input.measureUnit, 10, true);
  if (input.vatPercent !== undefined) { line['%Iva'] = decimal(input.vatPercent); if (Number(input.vatPercent) > 100) return invalid(); }
  for (const [source, target] of [['vatGroup', 'GrupoIva'], ['vatCode', 'CodigoIva']] as const) {
    const value = input[source]; if (value !== undefined) { if (!/^\d{1,5}$/u.test(value)) return invalid(); line[target] = value; }
  }
  return { payload: { tables: [{ tableName: 'TmpIME_CabeceraDocumento', values, lines: [{ line }] }] }, marker, documentId, lineId,
    purchaseKey: { companyCode: '1' as const, period, serie, number, position } };
}
function integerResult(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}
function identity(company: unknown, period: unknown, serie: unknown, number: unknown): SageReceiptIdentity | null {
  const y = integerResult(period, 1900, 2199), n = integerResult(number, 1, 999999999999);
  if (!(company === 1 || company === '1') || y === null || n === null || typeof serie !== 'string' || serie.length > 10 || /[\u0000-\u001f\u007f]/u.test(serie)) return null;
  return { companyCode: '1', period: y, serie, number: n };
}
function decimalKey(value: unknown): string | null {
  const v = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof v !== 'string' || !/^\d{1,15}(\.\d{1,18})?$/u.test(v)) return null;
  const [whole, fraction = ''] = v.split('.'); const tail = fraction.replace(/0+$/u, '');
  return whole.replace(/^0+(?=\d)/u, '') + (tail ? '.' + tail : '');
}
/** Exact Notes correlation only. Absence after a timeout never authorizes another insert. */
export function reconcileSagePurchaseReceipt(expected: SageReceiptExpected, rows: unknown): SageReceiptReconciliation {
  const marker = sageReceiptMarker(expected.id); field(expected.vendorId, 15); field(expected.productId, 20); decimal(expected.quantity, true);
  if (!Array.isArray(rows) || rows.some(row => !record(row) || !(row.CompanyId === 1 || row.CompanyId === '1'))) return { status: 'incompatible', reason: 'company' };
  const found = (rows as Record<string, unknown>[]).filter(row => row.Notes === marker);
  if (!found.length) return { status: 'none' };
  if (found.length > 1) return { status: 'multiple', count: found.length };
  const row = found[0]; if (row.VendorId !== expected.vendorId) return { status: 'incompatible', reason: 'vendor' };
  const document = identity(row.CompanyId, row.Period, row.Serie, row.Number); if (!document) return { status: 'incompatible', reason: 'identity' };
  if (!Array.isArray(row.Lines) || row.Lines.length !== 1 || !record(row.Lines[0]) || row.Lines[0].ProductId !== expected.productId) return { status: 'incompatible', reason: 'lines' };
  if (decimalKey(row.Lines[0].Quantity) !== decimalKey(expected.quantity)) return { status: 'incompatible', reason: 'quantity' };
  return { status: 'one', document };
}
/** The provider's stock note identifies the confirmed ALP, independently of its AI observations marker. */
export function reconcileSageReceiptStock(expected: SageReceiptStockExpected, rows: unknown): SageReceiptStockProof {
  const document = record(expected.document) && identity(expected.document.companyCode, expected.document.period, expected.document.serie, expected.document.number);
  if (!document) return invalid();
  const note = `Albarán compra:${document.period}/${document.serie}/${document.number}`;
  field(expected.storeId, 4); field(expected.productId, 20); decimal(expected.quantity, true); field(expected.measureUnit, 10, true);
  if (!Array.isArray(rows) || rows.some(row => !record(row) || !(row.CompanyId === 1 || row.CompanyId === '1'))) return { status: 'incompatible' };
  const found = (rows as Record<string, unknown>[]).filter(row => row.Note === note);
  if (!found.length) return { status: 'none' };
  if (found.length > 1) return { status: 'multiple', count: found.length };
  const row = found[0];
  if (typeof row.Id !== 'string' || !UUID.test(row.Id) || row.StoreId !== expected.storeId || row.ProductId !== expected.productId ||
      !(row.Type === 1 || row.Type === '1') || decimalKey(row.Quantity) !== decimalKey(expected.quantity) ||
      row.MeasureUnitId !== expected.measureUnit) return { status: 'incompatible' };
  return { status: 'one', movementId: row.Id.toLowerCase() };
}
/** An accepted import/assigned ALP number is provisional; callers must reread ALP and stock before applying local quantities. */
export function parseSageReceiptWriteResponse(raw: unknown): SageReceiptWriteResponse {
  if (!record(raw) || Object.hasOwn(raw, 'value') || raw.Success === false || raw.Error || raw.Errors) return { status: 'unknown' };
  const processId = typeof raw.IdsProceso === 'string' && UUID.test(raw.IdsProceso) ? raw.IdsProceso.toLowerCase() : undefined;
  const responses = Array.isArray(raw.Response) ? raw.Response.filter(record).filter(row => typeof row.Table === 'string' && row.Table.toLowerCase() === 'tmpime_cabeceradocumento') : [];
  if (responses.length === 1 && Array.isArray(responses[0].Fields)) {
    const fields: Record<string, unknown> = Object.create(null); let duplicate = false;
    for (const entry of responses[0].Fields) { if (!record(entry) || typeof entry.Field !== 'string' || Object.hasOwn(fields, entry.Field)) { duplicate = true; break; } fields[entry.Field] = entry.Value; }
    if (Object.hasOwn(fields, 'CodigoEmpresa') && !(fields.CodigoEmpresa === 1 || fields.CodigoEmpresa === '1')) return { status: 'unknown' };
    const document = !duplicate && identity(fields.CodigoEmpresa, fields.EjercicioAlbaran, fields.SerieAlbaran, fields.NumeroAlbaran);
    if (document) return { status: 'identified', document, ...(processId ? { processId } : {}) };
  }
  return processId ? { status: 'pending', processId } : { status: 'unknown' };
}
