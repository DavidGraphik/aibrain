import { sageServerFetch } from "./g03-sage-transport";
import { sageAllowedImportTables, sageImportTable, sageTableFields, type SageImportTable } from "./g03-sage-operations";
/** Solitium API v3.4: predefined company-scoped reads and validated IME imports. Never SQL/scripts. */
export const SAGE_QUERIES = {
  Products: { description: "Artículos de G03", parameters: [] },
  Vendors: { description: "Proveedores de G03", parameters: [] },
  SalesOrders: { description: "Pedidos de venta de G03 entre fechas. Según el manual Solitium, Status de cabecera: 0=abierto, 1=cerrado, 2=servido; abierto no demuestra cuántas unidades siguen pendientes en cada línea. Lines.Quantity es la cantidad pedida, no necesariamente la pendiente; Lines.UnidadesPendientes es el saldo nativo pendiente y UnidadesServidas el servido; si faltan o son nulos, el saldo es desconocido.", parameters: ["FechaInicial", "FechaFinal"] },
  SalesDeliveryNotes: { description: "Albaranes de venta de G03 entre fechas; referencias nativas EjercicioPedido/SeriePedido/NumeroPedido y LineaPedido (UUID de línea origen); nunca vincular por cliente o artículo", parameters: ["FechaInicial", "FechaFinal"] },
  SalesDeliveryNote: { description: "Albarán de venta de G03 por ejercicio, serie y número; referencias nativas EjercicioPedido/SeriePedido/NumeroPedido y LineaPedido (UUID de línea origen)", parameters: ["Ejercicio", "Serie", "Numero"] },
  LineasAlbaranVentaEntreFechas: { description: "Líneas de albaranes de venta de G03 entre fechas; cliente y artículo no identifican por sí solos una línea de pedido", parameters: ["FechaInicial", "FechaFinal"] },
  AlbaranConLineas: { description: "Líneas de un albarán de venta de G03 por ejercicio, serie y número; verifica referencias reales al pedido", parameters: ["Ejercicio", "Serie", "Numero"] },
  PurchaseOrders: { description: "Pedidos de compra de G03 entre fechas; Lines.UnidadesPendientes es el saldo nativo de cada línea y LineasPosicion su UUID; Quantity es la cantidad pedida, no el pendiente", parameters: ["FechaInicial", "FechaFinal"] },
  PurchaseDeliveryNotes: { description: "Albaranes de compra de G03 entre fechas; referencias nativas EjercicioPedido/SeriePedido/NumeroPedido y LineaPedido (UUID de línea origen)", parameters: ["FechaInicial", "FechaFinal"] },
  StockMovements: { description: "Movimientos de stock de G03 entre fechas", parameters: ["FechaInicial", "FechaFinal"] },
  SalesOrder: { description: "Pedido de venta de G03 por ejercicio, serie y número. Según el manual Solitium, Status de cabecera: 0=abierto, 1=cerrado, 2=servido; abierto no demuestra cuántas unidades siguen pendientes en cada línea. Lines.Quantity es la cantidad pedida, no necesariamente la pendiente; Lines.UnidadesPendientes es el saldo nativo pendiente y UnidadesServidas el servido; si faltan o son nulos, el saldo es desconocido.", parameters: ["Ejercicio", "Serie", "Numero"] },
  PurchaseOrder: { description: "Pedido de compra de G03 por ejercicio, serie y número; Lines.UnidadesPendientes es el saldo nativo de cada línea y LineasPosicion su UUID; Quantity es la cantidad pedida, no el pendiente", parameters: ["Ejercicio", "Serie", "Numero"] },
  PurchaseDeliveryNote: { description: "Albarán de compra de G03 por ejercicio, serie y número; referencias nativas EjercicioPedido/SeriePedido/NumeroPedido y LineaPedido (UUID de línea origen)", parameters: ["Ejercicio", "Serie", "Numero"] },
  Product: { description: "Artículo de G03 por código", parameters: ["CodigoArticulo"] },
  ProductStock: { description: "Stock, unidades y partidas de UN artículo G03 por lectura; CodigosArticulo requiere un código exacto, nunca una lista", parameters: ["CodigosArticulo"] },
  ProductKits: { description: "Kits de artículos y componentes de G03; no acredita lotes de material", parameters: [] },
  Stores: { description: "Almacenes de G03", parameters: [] },
  SalesInvoice: { description: "Factura de venta G03 con desglose fiscal por ejercicio, serie y número; comprobar identidad y líneas fiscales reales", parameters: ["Ejercicio", "Serie", "Numero"] },
  PurchaseInvoice: { description: "Factura de compra G03 con desglose fiscal por ejercicio, serie y número; comprobar identidad y líneas fiscales reales", parameters: ["Ejercicio", "Serie", "Numero"] },
  MovimientosConta: { description: "Movimientos contables G03 de una cuenta exacta y ejercicio entre fechas; seguir todas las páginas y contrastar UUID/asiento, nunca confundir un agregado con el movimiento", parameters: ["Cuentas", "Ejercicio", "FechaInicial", "FechaFinal"] },
  AcumuladosConta: { description: "Acumulados de una cuenta exacta G03 por ejercicio y período; no acredita por sí solo un movimiento concreto", parameters: ["Cuentas", "Ejercicio", "Periodo"] },
  PlanCuentas: { description: "Cuenta del plan contable G03 por su código exacto", parameters: ["Cuenta"] },
  Serialnumber: { description: "Número de serie G03 por identificador exacto", parameters: ["NumeroSerie"] },
  SerialnumbersByProduct: { description: "Números de serie G03 de un artículo exacto; seguir páginas y comprobar almacén/lote/dimensiones", parameters: ["CodigoArticulo"] },
  StockMovementsByProduct: { description: "Movimientos de stock G03 de un artículo exacto; seguir todas las páginas y contrastar almacén/lote/dimensiones", parameters: ["CodigoArticulo"] },
} as const;
export type SageQuery = keyof typeof SAGE_QUERIES;
// Provider OpenAPI GetQueryExtraField supports native fields on a named
// subquery. These immutable, server-selected profiles expose the actual line
// balances/UUIDs omitted by the standard DTO. Never accept fields, filters or
// subquery names from the model. Verified against G03 read-only on 5 November 2026.
const NATIVE_LINE_FIELDS: Readonly<Partial<Record<SageQuery, string>>> = Object.freeze({
  SalesOrder: "LineasPosicion,UnidadesPendientes,UnidadesServidas",
  SalesOrders: "LineasPosicion,UnidadesPendientes,UnidadesServidas",
  PurchaseOrder: "LineasPosicion,UnidadesPendientes",
  PurchaseOrders: "LineasPosicion,UnidadesPendientes",
  SalesDeliveryNote: "LineasPosicion,LineaPedido,EjercicioPedido,SeriePedido,NumeroPedido,UnidadesServidas",
  SalesDeliveryNotes: "LineasPosicion,LineaPedido,EjercicioPedido,SeriePedido,NumeroPedido,UnidadesServidas",
  PurchaseDeliveryNote: "LineasPosicion,LineaPedido,EjercicioPedido,SeriePedido,NumeroPedido",
  PurchaseDeliveryNotes: "LineasPosicion,LineaPedido,EjercicioPedido,SeriePedido,NumeroPedido",
});
export type SageCredential = { baseUrl: string; username: string; password: string; appId: string; allowedQueries: SageQuery[] };
export class SageError extends Error { constructor(readonly code: string) { super(code); } }
const fail = (code: string): never => { throw new SageError(code); };
export function sageRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
const companyName = "G03 MECANITZATS MALGRAT S.L.";
function arrayPayload(value: unknown): Record<string, unknown>[] {
  if (sageRecord(value) && Object.keys(value).length === 1 && typeof value.value === "string") {
    try { value = JSON.parse(value.value); } catch { return fail("SAGE_PROVIDER_RESPONSE_INVALID"); }
  }
  if (!Array.isArray(value) || value.some(row => !sageRecord(row))) return fail("SAGE_PROVIDER_RESPONSE_INVALID");
  return value;
}
function validArticleCode(value: string): boolean {
  // Sage returns fixed-width article codes: preserve their original padding in requests.
  if (!value.trim().length || value.length > 128) return false;
  if (/^[\p{L}\p{N} ._\/+()\-]+$/u.test(value)) return true;
  // Inch dimensions are part of real article identifiers, never free quoted text.
  // Allow integer, decimal and fractional dimensions, e.g. 3"X4" or 1 1/2"X3".
  return /^[\p{L}\p{N} ._\/+()\-]*[0-9]+(?:\.[0-9]+|(?: [0-9]+)?\/[0-9]+)?"[Xx][0-9]+(?:\.[0-9]+|(?: [0-9]+)?\/[0-9]+)?" *$/u.test(value);
}
export function sageReadArguments(query: unknown, parameters: unknown, skip: unknown, take: unknown) {
  if (typeof query !== "string" || !Object.hasOwn(SAGE_QUERIES, query) || !sageRecord(parameters)
    || !Number.isSafeInteger(skip) || Number(skip) < 0 || Number(skip) > 5000 || !Number.isSafeInteger(take) || Number(take) < 1 || Number(take) > 50) return fail("SAGE_ARGUMENTS_INVALID");
  const name = query as SageQuery, keys = SAGE_QUERIES[name].parameters;
  if (Object.keys(parameters).sort().join() !== [...keys].sort().join()) return fail("SAGE_ARGUMENTS_INVALID");
  for (const key of keys) {
    const value = parameters[key];
    if (typeof value !== "string") return fail("SAGE_ARGUMENTS_INVALID");
    if (key === "FechaInicial" || key === "FechaFinal") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) return fail("SAGE_ARGUMENTS_INVALID");
    } else if (key === "Ejercicio") {
      if (!/^(19|20|21)\d{2}$/.test(value)) return fail("SAGE_ARGUMENTS_INVALID");
    } else if (key === "Numero") {
      if (!/^\d{1,12}$/.test(value)) return fail("SAGE_ARGUMENTS_INVALID");
    } else if (key === "Serie") {
      // Sage permits a document's unprefixed series to be the empty string.
      if (value.length > 32 || !/^[\p{L}\p{N} ._\/+()\-]*$/u.test(value) || value.trim() !== value) return fail("SAGE_ARGUMENTS_INVALID");
    } else if (key === "Cuentas" || key === "Cuenta") {
      // One exact account, never SQL fragments, wildcards or comma-separated scopes.
      if (!/^[\p{L}\p{N}._-]{1,15}$/u.test(value)) return fail("SAGE_ARGUMENTS_INVALID");
    } else if (key === "Periodo") {
      if (!/^(?:[1-9]|1[0-2])$/.test(value)) return fail("SAGE_ARGUMENTS_INVALID");
    } else if (key === "NumeroSerie") {
      if (value.length > 30 || value.trim() !== value || !/^[\p{L}\p{N} ._\/+()\-]+$/u.test(value)) return fail("SAGE_ARGUMENTS_INVALID");
    } else if (!validArticleCode(value)) return fail("SAGE_ARGUMENTS_INVALID");
  }
  if (Object.hasOwn(parameters,"FechaInicial") && String(parameters.FechaInicial) > String(parameters.FechaFinal)) return fail("SAGE_ARGUMENTS_INVALID");
  const fields=NATIVE_LINE_FIELDS[name];
  return { queryName: name, parameters: { ...parameters, CodigoEmpresa: "1" },
    ...(fields?{extraFields:[{subqueryName:"Lines",fields}]}:{}),skip: Number(skip), take: Number(take) };
}
function foreignCompany(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(foreignCompany);
  if (!sageRecord(value)) return false;
  return Object.entries(value).some(([key,item]) => /^(CompanyId|CodigoEmpresa)$/i.test(key) && String(item) !== "1" || foreignCompany(item));
}
function publicData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicData);
  if (!sageRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/password|passwd|secret|token|authorization|connectionstring/i.test(key)).map(([key, item]) => [key, publicData(item)]));
}
export class SageReader {
  private session: { token: string; expires: number; catalog: Set<string>; verifiedAt: string } | null = null;
  private login: Promise<NonNullable<SageReader["session"]>> | null = null;
  constructor(private readonly credential: SageCredential, private readonly fetcher: typeof fetch = sageServerFetch) {
    const url = new URL(credential.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/api" || !credential.username || !credential.password || !credential.appId) fail("SAGE_CONFIG_INVALID");
  }
  /** A batch owns its session state so a cancelled request cannot alter another call. */
  forkForRead() {
    const fork = new SageReader(this.credential, this.fetcher);
    if (this.session) fork.session = { ...this.session, catalog: new Set(this.session.catalog) };
    return fork;
  }
  private async post(route: "auth/Login" | "DataQuery/GetQueryList" | "DataQuery/GetQuery" | "DataQuery/GetTableFields" | "PutData/allowedTables" | "PutData/InsertData", body: unknown, token?: string, signal?: AbortSignal) {
    try {
      // IME dispatch can finish after the ordinary read deadline. Keep one
      // bounded attempt; a timeout is still uncertain and is never retried.
      if (signal?.aborted) return fail("SAGE_READ_CANCELLED");
      const response = await this.fetcher(`${this.credential.baseUrl}/${route}`, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(route==="PutData/InsertData"?60_000:15_000)]) : AbortSignal.timeout(route==="PutData/InsertData"?60_000:15_000) });
      if (signal?.aborted) return fail("SAGE_READ_CANCELLED");
      if (!response.ok) { await response.body?.cancel(); return fail(response.status === 401 ? "SAGE_AUTH_REQUIRED" : "SAGE_PROVIDER_UNAVAILABLE"); }
      if (Number(response.headers.get("content-length")) > 1024 * 1024) { await response.body?.cancel(); return fail("SAGE_RESPONSE_TOO_LARGE"); }
      const reader = response.body?.getReader(); if (!reader) return fail("SAGE_PROVIDER_RESPONSE_INVALID");
      let bytes = 0; const chunks: Uint8Array[] = [];
      try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 1024 * 1024) return fail("SAGE_RESPONSE_TOO_LARGE"); chunks.push(part.value); } }
      finally { await reader.cancel().catch(() => undefined); }
      if (signal?.aborted) return fail("SAGE_READ_CANCELLED");
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { return fail("SAGE_PROVIDER_RESPONSE_INVALID"); }
    } catch (error) { if (signal?.aborted) return fail("SAGE_READ_CANCELLED"); if (error instanceof SageError) throw error; return fail("SAGE_PROVIDER_UNAVAILABLE"); }
  }
  private async authenticated(signal?: AbortSignal) {
    if (signal?.aborted) return fail("SAGE_READ_CANCELLED");
    if (this.session && this.session.expires > Date.now() + 60_000) return this.session;
    if (!this.login) this.login = (async () => {
      const result = await this.post("auth/Login", { username: this.credential.username, password: this.credential.password, AppId: this.credential.appId }, undefined, signal);
      if (!sageRecord(result) || typeof result.publicToken !== "string" || result.publicToken.length < 16 || result.publicToken.length > 24_000) return fail("SAGE_AUTH_REQUIRED");
      const token = result.publicToken;
      // Never expose Companies: it includes other companies. Only validate the pinned G03 identity internally.
      const companies = arrayPayload(await this.post("DataQuery/GetQuery", { queryName: "Companies", parameters: {}, skip: 0, take: 100 }, token, signal));
      const own = companies.filter(row => String(row.Code) === "1");
      if (own.length !== 1 || own[0].Name !== companyName) return fail("SAGE_COMPANY_MISMATCH");
      const queries = arrayPayload(await this.post("DataQuery/GetQueryList", {}, token, signal));
      const catalog = new Set(queries.filter(row => typeof row.name === "string" && typeof row.parameters === "string" && row.parameters.split(",").map(value => value.trim()).includes("CodigoEmpresa")
        && Object.hasOwn(SAGE_QUERIES, row.name) && [...row.parameters.split(",").map(value => value.trim())].sort().join() === ["CodigoEmpresa", ...SAGE_QUERIES[row.name as SageQuery].parameters].sort().join()).map(row => String(row.name)));
      const expiry = typeof result.publicTokenValidTo === "string" ? Date.parse(result.publicTokenValidTo) : NaN;
      if (signal?.aborted) return fail("SAGE_READ_CANCELLED");
      this.session = { token, catalog, verifiedAt: new Date().toISOString(), expires: Number.isFinite(expiry) ? Math.min(expiry, Date.now() + 300_000) : Date.now() + 120_000 };
      return this.session;
    })().finally(() => { this.login = null; });
    return this.login;
  }
  async read(query: unknown, parameters: unknown = {}, skip: unknown = 0, take: unknown = 10, signal?: AbortSignal) {
    if (signal?.aborted) return fail("SAGE_READ_CANCELLED");
    const body = sageReadArguments(query, parameters, skip, take);
    if (!this.credential.allowedQueries.includes(body.queryName)) return fail("SAGE_QUERY_DENIED");
    let session = await this.authenticated(signal);
    if (!session.catalog.has(body.queryName)) return fail("SAGE_QUERY_NOT_AVAILABLE");
    let pageTake = body.take, reauthenticated = false;
    for (;;) {
      try {
        const data = await this.post("DataQuery/GetQuery", { ...body, take: pageTake }, session.token, signal);
        const rows = arrayPayload(data);
        if (rows.length > pageTake || rows.some(row => !Object.hasOwn(row,"CompanyId") && !Object.hasOwn(row,"CodigoEmpresa")
          || foreignCompany(row))) return fail("SAGE_COMPANY_SCOPE_INVALID");
        const items = publicData(rows);
        if (Buffer.byteLength(JSON.stringify(items)) > 128 * 1024) return fail("SAGE_RESPONSE_TOO_LARGE");
        const requestedLineFields=NATIVE_LINE_FIELDS[body.queryName]?.split(",");
        const lines=rows.flatMap(row=>Array.isArray(row.Lines)?row.Lines.filter(sageRecord):[]);
        return { source: "SAGE", companyCode: "1", companyName, query: body.queryName, items, skip: body.skip, take: pageTake,
          ...(requestedLineFields?{nativeLineFields:{subquery:"Lines",requested:requestedLineFields,returnedLineCount:lines.length,
            documentsMissingLines:rows.filter(row=>!Array.isArray(row.Lines)).length,
            linesMissingRequestedFields:lines.filter(line=>requestedLineFields.some(field=>!Object.hasOwn(line,field))).length,
            linesWithNullRequestedFields:lines.filter(line=>requestedLineFields.some(field=>line[field]===null)).length,
            notice:"Campos nativos solicitados al proveedor, sin cálculos ni cambios. En pedidos, UnidadesPendientes es el pendiente de esa línea y Quantity lo pedido. En albaranes, Quantity es la cantidad del albarán y puede diferir de UnidadesServidas. Un campo ausente/nulo no equivale a cero. LineasPosicion es el UUID de la línea; LineaPedido referencia la línea origen, con EjercicioPedido/SeriePedido/NumeroPedido. UUID cero y pedido 0 no acreditan vínculo. No unir por artículo/cliente/Orden ni restar cantidades de albarán para inventar pendientes."}}:{}),
          nextOffset: rows.length === pageTake && body.skip + pageTake <= 5000 ? body.skip + pageTake : null,
          limitReached: rows.length === pageTake && body.skip + pageTake > 5000, complete: rows.length < pageTake, checkedAt: new Date().toISOString() };
      } catch (error) {
        if (signal?.aborted) return fail("SAGE_READ_CANCELLED");
        if (error instanceof SageError && error.code === "SAGE_AUTH_REQUIRED" && !reauthenticated) {
          reauthenticated = true;
          if (this.session === session) this.session = null;
          session = await this.authenticated(signal);
          if (!session.catalog.has(body.queryName)) return fail("SAGE_QUERY_NOT_AVAILABLE");
          continue; // One reauthentication across all attempts, reads only.
        }
        if (error instanceof SageError && error.code === "SAGE_RESPONSE_TOO_LARGE" && pageTake > 1) {
          pageTake = Math.max(1, Math.floor(pageTake / 2));
          continue; // Preserve skip; return the effective take for correct pagination.
        }
        throw error;
      }
    }
  }
  async insertPurchaseReceipt(payload: unknown) {
    if (!sageRecord(payload) || !Array.isArray(payload.tables) || payload.tables.length !== 1) return fail("SAGE_WRITE_INVALID");
    const table = payload.tables[0];
    if (!sageRecord(table) || table.tableName !== "TmpIME_CabeceraDocumento" || !sageRecord(table.values)
      || table.values.CodigoEmpresa !== "1" || table.values.CodigoDocumentoLc !== "ALP" || !Array.isArray(table.lines)
      || table.lines.length !== 1 || foreignCompany(payload)) return fail("SAGE_WRITE_INVALID");
    const session = await this.authenticated();
    // Never repeat a write after401/timeout: the receiving outbox reconciles it.
    return this.post("PutData/InsertData",payload,session.token);
  }
  /** Metadata reads may refresh a rejected cached token once. Never use for writes. */
  private async readImportMetadata(route: "PutData/allowedTables" | "DataQuery/GetTableFields", body: unknown) {
    let session = await this.authenticated();
    try {
      return await this.post(route, body, session.token);
    } catch (error) {
      if (!(error instanceof SageError) || error.code !== "SAGE_AUTH_REQUIRED") throw error;
      if (this.session === session) this.session = null;
      session = await this.authenticated();
      return this.post(route, body, session.token);
    }
  }
  async importTables() {
    return sageAllowedImportTables(await this.readImportMetadata("PutData/allowedTables", {}));
  }
  async importSchema(table: SageImportTable | "TmpIME_LineasDocumento") {
    if (table !== "TmpIME_LineasDocumento") sageImportTable(table);
    return sageTableFields(await this.readImportMetadata("DataQuery/GetTableFields", table));
  }
  /** Only the actor-bound operation service calls this after live schema and permission checks. Never retries. */
  async insertValidatedImport(payload:{tables:{tableName:SageImportTable;values:Record<string,string>;lines?:{line:Record<string,string>}[]}[]}){
    if(payload.tables.length!==1||foreignCompany(payload))return fail("SAGE_WRITE_INVALID");
    const table=payload.tables[0];sageImportTable(table.tableName);
    if(table.values.CodigoEmpresa!=="1"||!["0","1","2"].includes(table.values.TipoImportacionIME))return fail("SAGE_WRITE_INVALID");
    const session=await this.authenticated();
    const result=publicData(await this.post("PutData/InsertData",payload,session.token));
    if(Buffer.byteLength(JSON.stringify(result))>128*1024)return fail("SAGE_WRITE_RESPONSE_TOO_LARGE");
    return result;
  }
  async discover(signal?: AbortSignal) {
    const session = await this.authenticated(signal);
    const queries = this.credential.allowedQueries.filter(name => session.catalog.has(name)).map(name => ({ name, ...SAGE_QUERIES[name] }));
    if (!queries.length) return fail("SAGE_QUERY_NOT_AVAILABLE");
    return { source: "SAGE", companyCode: "1", companyName, readOnly: true, queries, companyVerifiedAt: session.verifiedAt, maxTake: 50, maxOffset: 5000 };
  }
}
