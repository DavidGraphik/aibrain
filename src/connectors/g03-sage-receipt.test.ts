import { describe, expect, it } from 'vitest';
import { buildSagePurchaseReceipt, parseSageReceiptWriteResponse, reconcileSagePurchaseReceipt, reconcileSageReceiptStock, sageReceiptMarker, type SagePurchaseReceipt } from './g03-sage-receipt';

const receipt: SagePurchaseReceipt = { id: '4336d151-9d51-4e2f-9ce9-7cd669ac269d', vendorId: 'V0001', issueDate: '2026-10-27',
  receiptSerie: 'AL', storeId: '001', productId: 'BAR 1/2"', quantity: '12.50', purchase: { period: 2026, serie: 'PC', number: 234, position: 5 } };
const marker = sageReceiptMarker(receipt.id);
const stockExpected = { ...receipt, document: { companyCode: '1' as const, period: 2026, serie: 'AL', number: 233 }, measureUnit: 'kg' };
const document = () => ({ CompanyId: 1, Period: 2026, Serie: 'AL', Number: 233, VendorId: receipt.vendorId, Notes: marker,
  Lines: [{ ProductId: receipt.productId, Quantity: 12.5 }] });
const movement = () => ({ Id: '42b1d40e-38bb-4bad-a864-59d6abf52837', CompanyId: 1, ProductId: receipt.productId, StoreId: '001',
  Note: 'Albarán compra:2026/AL/233', Quantity: '12.5000', Type: 1, MeasureUnitId: 'kg' });

describe('the documented company-one purchase delivery note', () => {
  it('builds one ALP with nested lines, stable UUIDs, exact origin and string values; no defaults for price/tax/unit', () => {
    const built = buildSagePurchaseReceipt(receipt), again = buildSagePurchaseReceipt({ ...receipt });
    expect(built).toEqual(again); expect(built.documentId).toBe(receipt.id); expect(built.lineId).toMatch(/^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u);
    expect(built.payload.tables).toHaveLength(1); const table = built.payload.tables[0];
    expect(table.tableName).toBe('TmpIME_CabeceraDocumento'); expect(table.values).toMatchObject({ CodigoEmpresa: '1', CodigoDocumentoLc: 'ALP',
      SerieDocumento: 'AL', IdDocumento: receipt.id, ObservacionesDocumento: marker, TipoImportacionIME: '0', Renumerar: '1' });
    expect(table.lines[0].line).toMatchObject({ CodigoEmpresa: '1', CodigoDocumentoLc: 'ALP', CodigoArticulo: receipt.productId, Unidades: '12.50',
      CodigoAlmacen: '001', EjercicioOrigen: '2026', SerieOrigen: 'PC', NumeroOrigen: '234', Orden: '5' });
    for (const value of Object.values(table.values)) expect(typeof value).toBe('string');
    for (const value of Object.values(table.lines[0].line)) expect(typeof value).toBe('string');
    for (const key of ['Precio', '%Iva', 'UnidadMedida1_', 'RebajarStock', 'SuFacturaNo']) expect(table.lines[0].line).not.toHaveProperty(key);
    expect(table.values).not.toHaveProperty('RebajarStock'); expect(table.values).not.toHaveProperty('SuFacturaNo');
  });
  it('copies exact explicit commercial fields and does not replace supplier document fields', () => {
    const line = buildSagePurchaseReceipt({ ...receipt, unitPrice: '0', measureUnit: 'kg', vatPercent: '21', vatGroup: '1', vatCode: '2' }).payload.tables[0].lines[0].line;
    expect(line).toMatchObject({ Precio: '0', UnidadMedida1_: 'kg', '%Iva': '21', GrupoIva: '1', CodigoIva: '2' });
  });
  it('preserves an explicitly empty base unit instead of omitting it', () => {
    expect(buildSagePurchaseReceipt({ ...receipt, measureUnit: '' }).payload.tables[0].lines[0].line).toHaveProperty('UnidadMedida1_', '');
  });
  it.each([
    { quantity: '0' }, { quantity: '-1' }, { quantity: '1e3' }, { quantity: '1,5' }, { quantity: '1.1234567' },
    { quantity: '9999999999999999' }, { unitPrice: '-1' }, { vatPercent: '101' }, { vatCode: 'x' }, { issueDate: '2026-02-29' },
    { productId: 'x'.repeat(21) }, { vendorId: 'x'.repeat(16) }, { storeId: '12345' }, { receiptSerie: 'x'.repeat(11) },
    { productId: 'A\nB' }, { id: '../receipt' }, { measureUnit: 'x'.repeat(11) }, { purchase: { ...receipt.purchase, number: 2147483648 } },
  ])('rejects invalid or out-of-contract receipt %j before an external write', patch => {
    expect(() => buildSagePurchaseReceipt({ ...receipt, ...patch } as SagePurchaseReceipt)).toThrow('SAGE_RECEIPT_ARGUMENTS_INVALID');
  });
  it('does not accept caller-selected company, arbitrary tables, or a replacement correlation field', () => {
    const built = buildSagePurchaseReceipt({ ...receipt, CodigoEmpresa: '2', tableName: 'TmpIME_MovConta', ObservacionesDocumento: 'Other' } as SagePurchaseReceipt);
    expect(built.payload.tables[0]).toMatchObject({ tableName: 'TmpIME_CabeceraDocumento', values: { CodigoEmpresa: '1', ObservacionesDocumento: marker } });
    expect(JSON.stringify(built)).not.toContain('TmpIME_MovConta');
  });
});

describe('timeout reconciliation cannot produce a second import', () => {
  it('matches the exact durable correlation, supplier, company and one product/quantity', () => {
    expect(reconcileSagePurchaseReceipt(receipt, [document()])).toEqual({ status: 'one', document: { companyCode: '1', period: 2026, serie: 'AL', number: 233 } });
  });
  it('does not accept an unrelated or approximate correlation or stock-equivalent quantity', () => {
    expect(reconcileSagePurchaseReceipt(receipt, [{ ...document(), Notes: marker + ' near' }])).toEqual({ status: 'none' });
    expect(reconcileSagePurchaseReceipt(receipt, [])).toEqual({ status: 'none' });
    expect(reconcileSagePurchaseReceipt(receipt, [document(), { ...document(), Number: 234 }])).toEqual({ status: 'multiple', count: 2 });
  });
  it.each([
    [{ CompanyId: 2 }, 'company'], [{ VendorId: 'OTHER' }, 'vendor'], [{ Number: 0 }, 'identity'], [{ Lines: [] }, 'lines'],
    [{ Lines: [{ ProductId: 'OTHER', Quantity: 12.5 }] }, 'lines'], [{ Lines: [{ ProductId: receipt.productId, Quantity: 12.5001 }] }, 'quantity'],
  ])('rejects an incompatible correlated document %j', (patch, reason) => {
    expect(reconcileSagePurchaseReceipt(receipt, [{ ...document(), ...(patch as object) }])).toEqual({ status: 'incompatible', reason });
  });
  it('requires an exactly correlated incoming stock record, never a net stock delta or quantity alone', () => {
    expect(reconcileSageReceiptStock(stockExpected, [movement()])).toEqual({ status: 'one', movementId: movement().Id });
    for (const Note of ['AL233', marker, 'Albarán compra:2026/AL/234', 'Albarán compra:2025/AL/233', 'Albarán compra:2026//233', movement().Note + ' near']) {
      expect(reconcileSageReceiptStock(stockExpected, [{ ...movement(), Note }])).toEqual({ status: 'none' });
    }
    for (const patch of [{ CompanyId: 2 }, { StoreId: '002' }, { Type: 2 }, { Quantity: 13 }, { ProductId: 'OTHER' }, { Id: 'not-a-uuid' }]) {
      expect(reconcileSageReceiptStock(stockExpected, [{ ...movement(), ...patch }])).toEqual({ status: 'incompatible' });
    }
    expect(reconcileSageReceiptStock({ ...stockExpected, measureUnit: 'unitats' }, [movement()])).toEqual({ status: 'incompatible' });
    expect(reconcileSageReceiptStock(stockExpected, [movement(), movement()])).toEqual({ status: 'multiple', count: 2 });
  });
  it('preserves empty series in the causal identity and requires an explicit matching empty stock unit', () => {
    const expected = { ...stockExpected, document: { ...stockExpected.document, serie: '' }, measureUnit: '' };
    const row = { ...movement(), Note: 'Albarán compra:2026//233', MeasureUnitId: '' };
    expect(reconcileSageReceiptStock(expected, [row])).toEqual({ status: 'one', movementId: row.Id });
    for (const MeasureUnitId of [undefined, null, 'kg', ' ']) expect(reconcileSageReceiptStock(expected, [{ ...row, MeasureUnitId }])).toEqual({ status: 'incompatible' });
    expect(() => reconcileSageReceiptStock({ ...expected, document: { ...expected.document, companyCode: '2' } } as never, [row])).toThrow('SAGE_RECEIPT_ARGUMENTS_INVALID');
    expect(() => reconcileSageReceiptStock({ ...expected, measureUnit: undefined } as never, [row])).toThrow('SAGE_RECEIPT_ARGUMENTS_INVALID');
  });
});

describe('provider acceptance is not completion of the stock movement', () => {
  const processId = 'cf52ca12-d398-4c9f-bfe1-9d509d7a463a';
  const result = () => ({ Response: [{ Table: 'TMPIME_CabeceraDocumento', Fields: [
    { Field: 'CodigoEmpresa', Value: '1' }, { Field: 'EjercicioAlbaran', Value: '2026' }, { Field: 'SerieAlbaran', Value: 'AL' }, { Field: 'NumeroAlbaran', Value: '233' },
  ] }], Message: 'Datos insertados correctamente', IdsProceso: processId });
  it('returns the ALP identity only provisionally until a readback and stock proof', () => {
    expect(parseSageReceiptWriteResponse(result())).toEqual({ status: 'identified', document: { companyCode: '1', period: 2026, serie: 'AL', number: 233 }, processId });
    expect(parseSageReceiptWriteResponse({ IdsProceso: processId })).toEqual({ status: 'pending', processId });
    expect(parseSageReceiptWriteResponse({ Message: 'Datos insertados correctamente' })).toEqual({ status: 'unknown' });
  });
  it('does not trust error messages, a different company, repeated fields or duplicate document responses', () => {
    expect(parseSageReceiptWriteResponse({ ...result(), value: 'Error interno' })).toEqual({ status: 'unknown' });
    const wrong = result(); wrong.Response[0].Fields[0].Value = '2'; expect(parseSageReceiptWriteResponse(wrong)).toEqual({ status: 'unknown' });
    const duplicate = result(); duplicate.Response[0].Fields.push({ Field: 'CodigoEmpresa', Value: '1' }); expect(parseSageReceiptWriteResponse(duplicate)).toEqual({ status: 'pending', processId });
    const twice = result(); twice.Response.push(twice.Response[0]); expect(parseSageReceiptWriteResponse(twice)).toEqual({ status: 'pending', processId });
    expect(parseSageReceiptWriteResponse({ Response: [{ Table: 'TmpIME_CabeceraDocumento', Fields: [{ Field: '__proto__', Value: {
      CodigoEmpresa: '1', EjercicioAlbaran: '2026', SerieAlbaran: 'AL', NumeroAlbaran: '233',
    } }] }] })).toEqual({ status: 'unknown' });
  });
});
