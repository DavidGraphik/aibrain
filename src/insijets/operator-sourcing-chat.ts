import type {AuthSession} from '../auth/types';
import {canAccessInsiJetsCMS} from './cms-access';
import {operatorSourcingResponse} from './operator-sourcing-api';

export const OPERATOR_CHAT_NAMESPACE='insijets_operator_local_review';
export type OperatorChatContext={session:AuthSession|null;installationId:string;dataRoot:string;brainOrigin:string;localReviewEnabled:boolean;directoryEnabled:boolean;backgroundExecution:boolean;sourceThreadId:string;sourceTurnId:string};
const text={type:'string',maxLength:200} as const;
const airport={type:'string',pattern:'^[A-Z0-9]{3,4}$'} as const;
const limit={type:'integer',minimum:1,maximum:30} as const;
const trip={originAirport:airport,destinationAirport:airport,passengers:{type:'integer',minimum:1,maximum:500},originCity:text,repositionCountries:{type:'array',maxItems:20,items:{type:'string',maxLength:100}},limit} as const;
export const OPERATOR_CHAT_TOOLS=[{type:'namespace',name:OPERATOR_CHAT_NAMESPACE,
 description:'LOCAL REVIEW: search the isolated InsiJets multi-source public operator directory and prepare inert availability drafts. No CRM history, live availability, prices, Outlook access or sending.',
 tools:[
  {type:'function',name:'search_operators',description:'Find source operator entities by name across Air Charter Guide, FAA and Aviapages. Identity matches across sources are not confirmed company merges.',inputSchema:{type:'object',properties:{query:text,page:{type:'integer',minimum:1,maximum:10000},limit},additionalProperties:false}},
  {type:'function',name:'search_aircraft',description:'Search published aircraft observations by operator/model/registration, base airport, country and known seats. Missing seat counts are not treated as a fit.',inputSchema:{type:'object',properties:{query:text,airport,country:text,minSeats:{type:'integer',minimum:1,maximum:500},page:{type:'integer',minimum:1,maximum:10000},limit},additionalProperties:false}},
  {type:'function',name:'shortlist',description:'Shortlist published jets for explicit origin and arrival airport codes and passenger count. Ask for airport confirmation when only a city is known. Availability and operational suitability remain unconfirmed.',inputSchema:{type:'object',properties:trip,required:['originAirport','destinationAirport','passengers'],additionalProperties:false}},
  {type:'function',name:'prepare_drafts',description:'Prepare individual local email drafts for a scoped published-operator shortlist. No Outlook call or email send is available. Show exact account, To/Cc/Bcc, subject, body and attachments and obtain David approval before any future sending action.',inputSchema:{type:'object',properties:{...trip,reference:text,sender:{...text,format:'email'},departureISO:text,timeZone:text,flightType:text},required:['originAirport','destinationAirport','passengers'],additionalProperties:false}},
 ]}] as const;

export const operatorChatInstructions='The insijets_operator_local_review tools read only the installation-bound public operator directory. They cannot read historical CRM data or send mail. Ask for explicit airport codes and passenger count before shortlisting. Published fleet data is not live availability, an operational clearance or a quote. Distinguish source entities from confirmed legal-company identities. Drafts remain local and unsent. Missing sender/date/time/timezone stay missing. Show each exact draft before requesting any future sending approval. Use a new conversation for this toolset.';

function allowed(context:OperatorChatContext){return context.localReviewEnabled&&context.directoryEnabled&&!context.backgroundExecution&&Boolean(context.sourceThreadId&&context.sourceTurnId)&&canAccessInsiJetsCMS(context.session,context.installationId);}
export function operatorChatToolsForTurn(context:OperatorChatContext){return allowed(context)?OPERATOR_CHAT_TOOLS:[];}

/** Context is created by the authenticated worker, never supplied by model arguments.
 * Reuses the same bounded API/store as the private search UI. No network call.
 */
export async function handleOperatorChatTool(tool:string,input:unknown,context:OperatorChatContext){
 if(!allowed(context))throw Error('OPERATOR_CHAT_ACCESS_DENIED');
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('OBJECT_REQUIRED');
 const args=input as Record<string,unknown>;
 const schemas=OPERATOR_CHAT_TOOLS[0].tools.find(x=>x.name===tool);
 if(!schemas||Object.keys(args).some(k=>!Object.prototype.hasOwnProperty.call(schemas.inputSchema.properties,k)))throw Error('ARGUMENTS_DENIED');
 for(const key of ['query','country','originCity','reference','sender','departureISO','timeZone','flightType'])if(args[key]!==undefined&&(typeof args[key]!=='string'||(args[key] as string).length>200||/[\u0000-\u001f]/.test(args[key] as string)))throw Error('INVALID_TEXT_ARGUMENT');
 for(const key of ['airport','originAirport','destinationAirport'])if(args[key]!==undefined&&(typeof args[key]!=='string'||! /^[A-Z0-9]{3,4}$/.test(args[key] as string)))throw Error('EXPLICIT_AIRPORT_CODE_REQUIRED');
 for(const [key,maximum]of [['page',10000],['minSeats',500],['passengers',500]] as const)if(args[key]!==undefined&&(!Number.isInteger(args[key])||(args[key] as number)<1||(args[key] as number)>maximum))throw Error('INVALID_NUMERIC_ARGUMENT');
 if(args.limit!==undefined&&(!Number.isInteger(args.limit)||(args.limit as number)<1||(args.limit as number)>30))throw Error('LIMIT_MUST_BE_1_TO_30');
 const configuration={installationId:context.installationId,origin:context.brainOrigin,dataRoot:context.dataRoot,enabled:context.directoryEnabled};
 const searching=tool==='search_operators'||tool==='search_aircraft';
 const url=new URL('/api/insijets/operator-sourcing',context.brainOrigin);
 let request:Request;
 if(searching){
  if(tool==='search_operators')url.searchParams.set('view','operators');
  for(const [key,value]of Object.entries(args)){if(typeof value!=='string'&&typeof value!=='number')throw Error('INVALID_SEARCH_VALUE');url.searchParams.set(key,String(value));}
  if(!url.searchParams.has('limit'))url.searchParams.set('limit','10');
  request=new Request(url);
 }else request=new Request(url,{method:'POST',headers:{Origin:context.brainOrigin,'Content-Type':'application/json'},body:JSON.stringify({limit:10,...args})});
 const response=await operatorSourcingResponse(request,configuration,context.session),result=await response.json();
 if(!response.ok)throw Error(String(result.error||'OPERATOR_LOOKUP_REJECTED'));
 const boundary={localReview:true,source:'Installation-bound public operator directory only',crmHistoryRead:false,outlookAccess:false,emailsSent:0,summary:result.summary};
 if(searching)return {...boundary,result:result.result};
 if(tool==='shortlist')return {...boundary,shortlist:result.shortlist,notice:result.notice};
 return {...boundary,shortlist:result.shortlist,preparation:result.preparation,notice:result.notice};
}
