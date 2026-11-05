import {expect,it} from "vitest";
import {buildSageImport,sageAllowedImportTables,sageTableFields,type SageField} from "./g03-sage-operations";
const fields:SageField[]=[{name:"CodigoEmpresa",dataType:"smallint",nullable:false,maxLength:null,hasDefault:true},{name:"CodigoArticulo",dataType:"varchar",nullable:false,maxLength:20,hasDefault:false},{name:"DescripcionArticulo",dataType:"varchar",nullable:false,maxLength:50,hasDefault:true}];
it("intersects permitted live tables with documented tables and excludes unreviewed provider extensions",()=>{
 expect(sageAllowedImportTables({value:JSON.stringify([{name:"TmpIME_Articulos"},{name:"TMPIME_CABECERADOCUMENTO"},{name:"TmpIME_MovimientoStock"},{name:"Undocumented"}])})).toEqual(["TmpIME_Articulos","TmpIME_CabeceraDocumento"]);
});
it("parses the actual provider metadata shape without inventing business requiredness",()=>{
 expect(sageTableFields({value:JSON.stringify([{Name:"CodigoEmpresa",DataType:"smallint",IsNullable:"NO",MaxLength:null,HasDefault:"YES"}])})).toEqual([fields[0]]);
 expect(()=>sageTableFields([{Name:"Company",DataType:"int",IsNullable:"maybe",MaxLength:null,HasDefault:"YES"}])).toThrow("SAGE_SCHEMA_INVALID");
});
it("injects company/action control, canonicalizes payload and rejects unknown fields or foreign scope",()=>{
 const one=buildSageImport({table:"TmpIME_Articulos",action:"update",values:{CodigoArticulo:"A",DescripcionArticulo:"Part"}},fields),two=buildSageImport({table:"TmpIME_Articulos",action:"update",values:{DescripcionArticulo:"Part",CodigoArticulo:"A"}},fields);
 expect(()=>buildSageImport({table:"TmpIME_Articulos",action:"update",values:{CodigoArticulo:"A",CodigoEmpresaOrigen:"2"}},[...fields,{name:"CodigoEmpresaOrigen",dataType:"smallint",nullable:false,maxLength:null,hasDefault:true}])).toThrow("SAGE_COMPANY_SCOPE_INVALID");
 expect(one.id).toBe(two.id);expect(one.payload.tables[0].values).toMatchObject({CodigoEmpresa:"1",TipoImportacionIME:"2"});
 for(const values of [{CodigoEmpresa:"2",CodigoArticulo:"A"},{CodigoArticulo:"A",sql:"DROP"},{CodigoArticulo:"A",IdProcesoIME:"foreign"}])expect(()=>buildSageImport({table:"TmpIME_Articulos",action:"create",values},fields)).toThrow();
});
it("validates live string/number limits and required field presence before a provider call",()=>{
 for(const values of [{CodigoArticulo:5},{CodigoArticulo:"x".repeat(21)},{DescripcionArticulo:"missing key"}])expect(()=>buildSageImport({table:"TmpIME_Articulos",action:"create",values},fields)).toThrow();
 const q=[...fields,{name:"Cantidad",dataType:"decimal",nullable:false,maxLength:null,hasDefault:true}];
 expect(()=>buildSageImport({table:"TmpIME_Articulos",action:"create",values:{CodigoArticulo:"A",Cantidad:"1;DROP"}},q)).toThrow();
});
it("rejects normalized impossible calendar dates and clock overflows while accepting real leap dates",()=>{
 const dated=[...fields,{name:"FechaDocumento",dataType:"datetime",nullable:false,maxLength:null,hasDefault:true}];
 for(const date of ["2026-02-30","2026-02-29 12:00:00","2026-04-31T01:00:00","2026-11-03 24:00:00","2026-11-03 12:60:00","2026-11-03 12:00:60"]){
  expect(()=>buildSageImport({table:"TmpIME_Articulos",action:"update",values:{CodigoArticulo:"A",FechaDocumento:date}},dated)).toThrow("SAGE_FIELD_VALUE_INVALID");
 }
 for(const date of ["2028-02-29","2028-02-29 23:59:59.1234567","2026-11-03T12:30:00"]){
  expect(buildSageImport({table:"TmpIME_Articulos",action:"update",values:{CodigoArticulo:"A",FechaDocumento:date}},dated).payload.tables[0].values.FechaDocumento).toBe(date);
 }
});
it("documents require real nested lines, not separate top-level row/table injections",()=>{
 expect(()=>buildSageImport({table:"TmpIME_CabeceraDocumento",action:"create",values:{CodigoArticulo:"A"}},fields,fields)).toThrow("SAGE_LINES_REQUIRED");
 const p=buildSageImport({table:"TmpIME_CabeceraDocumento",action:"create",values:{CodigoArticulo:"A"},lines:[{CodigoArticulo:"B"}]},fields,fields).payload;
 expect(p.tables).toHaveLength(1);expect(p.tables[0].lines).toEqual([{line:{CodigoArticulo:"B",CodigoEmpresa:"1",TipoImportacionIME:"0"}}]);
});
