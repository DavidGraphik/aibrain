import library from './outreach-demo-library.json' with {type:'json'};
/** Source-preserved review templates. No recipient, account binding or dispatch. */
export type CampaignDraft = {id:string;name:string;audience:'historical'|'new-icp';persona:string;locale:string;subject:string;steps:{offset:number;offsetUnit:'calendar-days';body:string;subject?:string;threadRule?:string}[];sourceReference:string;cadenceOriginal:string;sourceDate:string;notes?:string[];version:number;reviewState:'draft';sendEnabled:false};
export const DEMO_CAMPAIGNS:CampaignDraft[]=library as CampaignDraft[];
export const OUTREACH_READINESS={
 mode:'local-preparation',crmConnected:false,pilotReady:false,leadExtractionEnabled:false,sendEnabled:false,notificationDeliveryEnabled:false,schedulerInstalled:false,
 gates:[
  {id:'crm',label:'Example Representative completes HubSpot migration and confirms portal; restricted connection and real acceptance pending',state:'pending'},
  {id:'contract',label:'Written CRM operation/field/conflict agreement',state:'pending'},
  {id:'historical',label:'Example Representative-controlled historical eligibility, languages and exclusions',state:'pending'},
  {id:'targeting',label:'Reconcile annotated ICP mix, sources and budget before extraction',state:'pending'},
  {id:'mailboxes',label:'Fresh mailbox connection, actual authentication headers and independent placement',state:'pending'},
  {id:'approval',label:'Exact final audience, account, copy, signature and attachments approved before sending',state:'pending'},
  {id:'replies',label:'Real provider reply/opt-out stop and Example Representative alert receipt',state:'pending'},
  {id:'ownership',label:'Client-owned infrastructure and limited removable support access',state:'pending'}
 ]
} as const;
