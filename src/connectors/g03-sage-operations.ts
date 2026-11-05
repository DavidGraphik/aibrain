import { createHash } from "node:crypto";
import { SageError, sageRecord } from "./g03-sage-api";

/** Solitium Universal v3.4 §§7.1–7.2. Provider metadata and actor policy further narrow this list. */
export const SAGE_IMPORT_TABLES = ["TmpIME_ArticuloCliente", "TmpIME_ArticuloProveedor", "TmpIME_Articulos", "TmpIME_CabeceraDocumento", "TmpIME_ClientesProveedores", "TmpIME_Domicilios", "TmpIME_Familias", "TmpIME_Inventarios", "TmpIME_InventariosSerie", "TmpIME_IvaDocumento", "TmpIME_MovConta", "TmpIME_PlanCuentasPGC", "TmpIME_Tarifas", "TmpIME_TarifasCompra", "TmpIME_TarifasVenta"] as const;
export type SageImportTable = typeof SAGE_IMPORT_TABLES[number];
export const SAGE_IMPORT_ACTIONS = ["create", "update", "delete"] as const;
export type SageImportAction = typeof SAGE_IMPORT_ACTIONS[number];
export type SageField = { name:string; dataType:string; nullable:boolean; maxLength:number|null; hasDefault:boolean };
const fail = (code:string):never => { throw new SageError(code); };
export function sageImportTable(value:unknown):SageImportTable {
  if(typeof value!=="string")return fail("SAGE_TABLE_INVALID");
  const table=SAGE_IMPORT_TABLES.find(t=>t.toLowerCase()===value.toLowerCase());
  return table??fail("SAGE_TABLE_UNSUPPORTED");
}
export function sageImportAction(value:unknown):SageImportAction {
  if(!SAGE_IMPORT_ACTIONS.includes(value as SageImportAction))return fail("SAGE_ACTION_INVALID");
  return value as SageImportAction;
}
function array(value:unknown):unknown[] {
  if(sageRecord(value)&&Object.keys(value).length===1&&typeof value.value==="string"){
    try{value=JSON.parse(value.value);}catch{return fail("SAGE_PROVIDER_RESPONSE_INVALID");}
  }
  if(!Array.isArray(value))return fail("SAGE_PROVIDER_RESPONSE_INVALID");
  return value;
}
export function sageAllowedImportTables(value:unknown):SageImportTable[]{
  const rows=array(value);if(rows.length>200)return fail("SAGE_PROVIDER_RESPONSE_INVALID");
  return [...new Set(rows.flatMap(row=>{
    const name=typeof row==="string"?row:sageRecord(row)?row.name:undefined;
    return typeof name==="string"?SAGE_IMPORT_TABLES.filter(t=>t.toLowerCase()===name.toLowerCase()):[];
  }))];
}
export function sageTableFields(value:unknown):SageField[]{
  const rows=array(value);if(!rows.length||rows.length>500)return fail("SAGE_SCHEMA_INVALID");
  const fields=rows.map(row=>{
    if(!sageRecord(row)||typeof row.Name!=="string"||!row.Name.length||row.Name.length>128||/[\u0000-\u001f]/.test(row.Name)||typeof row.DataType!=="string"||!["YES","NO"].includes(String(row.IsNullable))||!["YES","NO"].includes(String(row.HasDefault))||row.MaxLength!==null&&(!Number.isSafeInteger(row.MaxLength)||Number(row.MaxLength)<-1))return fail("SAGE_SCHEMA_INVALID");
    return {name:row.Name,dataType:row.DataType.toLowerCase(),nullable:row.IsNullable==="YES",maxLength:row.MaxLength===null?null:Number(row.MaxLength),hasDefault:row.HasDefault==="YES"};
  });
  if(new Set(fields.map(f=>f.name.toLowerCase())).size!==fields.length)return fail("SAGE_SCHEMA_INVALID");
  return fields;
}
function validateValue(field:SageField,value:unknown):string {
  if(typeof value!=="string"||value.length>16_384||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))return fail("SAGE_FIELD_VALUE_INVALID");
  if(field.maxLength!==null&&field.maxLength>=0&&Buffer.byteLength(value,"utf8")>field.maxLength)return fail("SAGE_FIELD_VALUE_INVALID");
  if(["tinyint","smallint","int","bigint"].includes(field.dataType)&&!/^[-+]?\d+$/.test(value))return fail("SAGE_FIELD_VALUE_INVALID");
  if(["decimal","numeric","money","smallmoney","float","real"].includes(field.dataType)&&(!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)||!Number.isFinite(Number(value))))return fail("SAGE_FIELD_VALUE_INVALID");
  if(field.dataType==="bit"&&!/^[01]$/.test(value))return fail("SAGE_FIELD_VALUE_INVALID");
  if(field.dataType==="uniqueidentifier"&&!/^\{?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\}?$/i.test(value))return fail("SAGE_FIELD_VALUE_INVALID");
  if(["date","datetime","datetime2","smalldatetime"].includes(field.dataType)){
    const parts=/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?)?$/.exec(value);
    if(!parts)return fail("SAGE_FIELD_VALUE_INVALID");
    const day=Date.parse(`${parts[1]}T00:00:00.000Z`);
    if(!Number.isFinite(day)||new Date(day).toISOString().slice(0,10)!==parts[1]||parts[2]!==undefined&&[Number(parts[2])>23,Number(parts[3])>59,Number(parts[4])>59].some(Boolean))return fail("SAGE_FIELD_VALUE_INVALID");
  }
  return value;
}
function values(input:unknown,fields:SageField[],action:SageImportAction){
  if(!sageRecord(input)||Object.keys(input).length>500)return fail("SAGE_VALUES_INVALID");
  const byName=new Map(fields.map(f=>[f.name,f]));
  if(!byName.has("CodigoEmpresa"))return fail("SAGE_SCHEMA_NOT_COMPANY_SCOPED");
  const result:Record<string,string>={};
  for(const [key,value] of Object.entries(input)){
    if(["CodigoEmpresa","TipoImportacionIME","IdProcesoIME","MovIdentificadorIME","StatusTraspasadoIME"].includes(key))return fail("SAGE_CONTROL_FIELD_DENIED");
    if(/^(CodigoEmpresa|CompanyId)/i.test(key)&&value!=="1")return fail("SAGE_COMPANY_SCOPE_INVALID");
    const field=byName.get(key);if(!field)return fail("SAGE_FIELD_UNKNOWN");result[key]=validateValue(field,value);
  }
  if(!Object.keys(result).length)return fail("SAGE_VALUES_INVALID");
  // These are documented API-level IME controls; live GetTableFields may omit them.
  result.CodigoEmpresa="1";result.TipoImportacionIME=action==="create"?"0":action==="delete"?"1":"2";
  for(const field of fields)if(!field.nullable&&!field.hasDefault&&!Object.hasOwn(result,field.name)&&!["IdProcesoIME","MovIdentificadorIME","StatusTraspasadoIME"].includes(field.name))return fail("SAGE_REQUIRED_FIELD_MISSING");
  return Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b)));
}
export function buildSageImport(input:{table:SageImportTable;action:SageImportAction;values:unknown;lines?:unknown},fields:SageField[],lineFields?:SageField[]){
  const header=values(input.values,fields,input.action);let lines:{line:Record<string,string>}[]|undefined;
  if(input.lines!==undefined){
    if(input.table!=="TmpIME_CabeceraDocumento"||!lineFields||!Array.isArray(input.lines)||!input.lines.length||input.lines.length>100)return fail("SAGE_LINES_INVALID");
    lines=input.lines.map(line=>({line:values(line,lineFields,input.action)}));
  }
  if(input.table==="TmpIME_CabeceraDocumento"&&input.action==="create"&&!lines)return fail("SAGE_LINES_REQUIRED");
  const payload={tables:[{tableName:input.table,values:header,...(lines?{lines}:{})}]};
  if(Buffer.byteLength(JSON.stringify(payload))>60*1024)return fail("SAGE_PAYLOAD_TOO_LARGE");
  const id=createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return {id,payload};
}
