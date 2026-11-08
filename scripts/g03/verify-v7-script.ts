/** Execute a captured Apps Script only in a bounded, offline mock spreadsheet. */
import vm from 'node:vm';import {readFile,writeFile} from 'node:fs/promises';
import {v7EditEffects,v7ClearsMachine} from '../../src/g03-products/v7-logic';import type {Order} from '../../src/g03-products/contracts';
async function main(){const [sourceFile,output]=process.argv.slice(2);const source=await readFile(sourceFile,'utf8');const context=vm.createContext({});new vm.Script(source).runInContext(context,{timeout:1000});
 const statuses=['LLEST PER SERVIR','PDT. PROVA PRESSIÓ','PDT. PROVA DE PRESSIÓ','PDT. RENTAR','PDT. RECTIFICAT','PER ENVIAR A TRACTAMENT','ENVIAT A TRACTAMENT (PREVI/M)','ENVIAT A TRACTAMENT (POST/M)','PDT. ENVIAR PINTURA','EXTERN','PDT. LLIMAR','PDT. OLI','PDT. ROSCAR','PDT. MUNTATGE HELICOIS','NO COMENÇAT','ENTREGAT','PARAT'];const failures:unknown[]=[];
 for(const status of statuses){context.status=status;const expected=new vm.Script('haDEsborrarMaquina_(status)').runInContext(context,{timeout:1000});if(expected!==v7ClearsMachine(status))failures.push({status});}
 let cases=0;for(const productionStatus of statuses)for(const materialStatus of ['PENDENT','REBUT','PARCIAL','NO DEMANAT','PDT.COMPTAR']){
 const cells=new Map([[6,productionStatus],[15,'2026-10-10'],[16,materialStatus],[21,'M1'],[22,10]] as [number,unknown][]);
 const sheet={getName:()=> 'CONTROL PRODUCCIÓ',getRange:(_r:number,col:number,_rows=1,cols=1)=>({getValue:()=>cells.get(col),setValue:(v:unknown)=>cells.set(col,v),clearContent:()=>{for(let i=0;i<cols;i++)cells.set(col+i,'');},setFormula:()=>{}})};
 context.event={range:{getSheet:()=>sheet,getRow:()=>30,getColumn:()=>16,getValue:()=>materialStatus}};
 new vm.Script('moureReferenciaOT(event)').runInContext(context,{timeout:1000});
 const input={productionStatus,materialStatus,materialEta:'2026-10-10',formulaFields:[]} as unknown as Order;const result=v7EditEffects(input,{materialStatus});cases++;
 if((result.productionStatus??'')!==cells.get(6) || (result.materialEta??'')!==cells.get(15))failures.push({productionStatus,materialStatus});
 }
 await writeFile(output,JSON.stringify({sourceFile,clearingStatusCases:statuses.length,materialEventCases:cases,failures,offlineOnly:true,limitations:['Grid insertion, formatting, archive-copy geometry and maintenance buttons are not executed by this mock']},null,2));console.log(JSON.stringify({clearingStatusCases:statuses.length,materialEventCases:cases,failures:failures.length}));if(failures.length)process.exitCode=1;
}void main();
