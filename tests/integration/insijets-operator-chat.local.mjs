import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import operatorChat from '../../src/insijets/operator-sourcing-chat.ts';
const {handleOperatorChatTool,operatorChatToolsForTurn,OPERATOR_CHAT_NAMESPACE}=operatorChat;

test('authenticated foreground chat tools → installation-bound API/store → real local public inventory → inert drafts', {skip:!process.env.INSIJETS_LOCAL_MULTISOURCE_DATA_ROOT}, async()=>{
 const session={provider:'local',user:{id:'local-qa-luca',name:'Local Luca QA fixture',email:'cms-owner@example.invalid'},tenant:{id:'insijets-demo',name:'InsiJets'},expiresAt:new Date(Date.now()+600000).toISOString()};
 const context={session,installationId:'insijets-demo',dataRoot:path.resolve(process.env.INSIJETS_LOCAL_MULTISOURCE_DATA_ROOT),brainOrigin:'http://127.0.0.1:4190',localReviewEnabled:true,directoryEnabled:true,backgroundExecution:false,sourceThreadId:'local-operator-chat-qa',sourceTurnId:'local-operator-turn'};
 const tools=operatorChatToolsForTurn(context);assert.equal(tools[0].name,OPERATOR_CHAT_NAMESPACE);assert.deepEqual(tools[0].tools.map(t=>t.name),['search_operators','search_aircraft','shortlist','prepare_drafts']);
 for(const denied of [{...context,session:null},{...context,backgroundExecution:true},{...context,localReviewEnabled:false},{...context,directoryEnabled:false},{...context,sourceTurnId:''},{...context,installationId:'other-tenant'},{...context,session:{...session,tenant:{id:'other-tenant',name:'Other'}}}]){
  assert.deepEqual(operatorChatToolsForTurn(denied),[]);
  await assert.rejects(handleOperatorChatTool('search_operators',{}, {...denied,dataRoot:'/must-not-open-foreign-data'}),/ACCESS_DENIED/);
 }
 await assert.rejects(handleOperatorChatTool('search_operators',{dataRoot:'/model-selected'},context),/ARGUMENTS_DENIED/);
 await assert.rejects(handleOperatorChatTool('send',{},context),/ARGUMENTS_DENIED/);
 await assert.rejects(handleOperatorChatTool('search_aircraft',{limit:300},context),/LIMIT/);
 await assert.rejects(handleOperatorChatTool('search_operators',{query:123},context),/INVALID_TEXT/);
 await assert.rejects(handleOperatorChatTool('shortlist',{originAirport:'Paris',destinationAirport:'Geneva',passengers:6},context),/AIRPORT_CODE/);
 const operators=await handleOperatorChatTool('search_operators',{query:'Gestair'},context);
 assert.equal(operators.summary.sourceOperatorEntities,6496);assert(operators.result.rows.some(row=>row.source==='Aviapages public listing'));
 const aircraft=await handleOperatorChatTool('search_aircraft',{query:'ASTON',airport:'LFPB',minSeats:6},context);assert.equal(aircraft.result.total,4);
 const faa=await handleOperatorChatTool('search_aircraft',{query:'N700FX'},context);assert(faa.result.rows.some(row=>row.source==='FAA user-supplied workbook'));
 const trip={originAirport:'LFPB',destinationAirport:'LSGG',passengers:6,limit:30};
 const shortlist=await handleOperatorChatTool('shortlist',trip,context);assert(shortlist.shortlist.length>0);assert.equal(shortlist.preparation,undefined);
 const drafts=await handleOperatorChatTool('prepare_drafts',trip,context);assert.equal(drafts.preparation.drafts.length,23);assert.equal(drafts.preparation.sendEnabled,false);assert(drafts.preparation.missingInputs.includes('sender'));assert(drafts.preparation.drafts.every(d=>d.approval===null&&d.status.includes('NOT SENT')));
 for(const result of [operators,aircraft,faa,shortlist,drafts]){assert.equal(result.crmHistoryRead,false);assert.equal(result.outlookAccess,false);assert.equal(result.emailsSent,0);}
 // Verify the tested registration helper/handler is wired at the real worker seam.
 const worker=await readFile(new URL('../../src/runtime/worker-codex-turn.ts',import.meta.url),'utf8');assert(worker.includes('operatorChatToolsForTurn(operatorChatContext)'));assert(worker.includes('namespace === OPERATOR_CHAT_NAMESPACE'));assert(worker.includes('handleOperatorChatTool(String(request.params.tool), request.params.arguments, operatorChatContext)'));
 const receipt={kind:'LOCAL SCRIPTED CHAT TOOL ACCEPTANCE',modelInferenceExercised:false,realBrowserChatExercised:false,sourceCounts:operators.summary.sourceCounts,toolNamespace:OPERATOR_CHAT_NAMESPACE,tools:tools[0].tools.map(t=>t.name),aircraftFilterRows:aircraft.result.total,FAAProvenancePreserved:true,shortlistGroups:shortlist.shortlist.length,drafts:drafts.preparation.drafts.length,wrongTenantDenied:true,backgroundDenied:true,disabledDenied:true,modelSuppliedDataRootDenied:true,CRMHistoryRead:false,OutlookAccess:false,emailsSent:0,productionActivated:false};
 if(process.env.INSIJETS_CHAT_EVIDENCE_DIRECTORY){const destination=path.resolve(process.env.INSIJETS_CHAT_EVIDENCE_DIRECTORY);await mkdir(destination,{recursive:true});await writeFile(path.join(destination,'operator-chat-local-acceptance.json'),JSON.stringify(receipt,null,2));}
});
