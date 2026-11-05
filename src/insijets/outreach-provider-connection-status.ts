import {OUTREACH_PROVIDER_ENV_NAMES as names} from './outreach-provider-adapters.ts';
export type OutreachProviderConnectionStatus={provider:'apollo'|'prospeo'|'clay';name:string;use:string;adapterPrepared:true;credentialPresent:boolean;bindingReferencePresent:boolean;clientOwnedBindingVerified:false;executionAllowed:false;status:'awaiting-client-account'|'configuration-review-required';nextAction:string};
/** Returns presence only, never credentials or a claim that an account has been verified. */
export function outreachProviderConnections(environment:Record<string,string|undefined>=process.env){
 const bindingReferencePresent=Boolean(environment[names.bindingsFile]);
 const specifications=[
  {provider:'apollo' as const,name:'Apollo',use:'Company and selected-person research/enrichment',credentialPresent:Boolean(environment[names.apolloKey])},
  {provider:'prospeo' as const,name:'Prospeo',use:'Approved contact enrichment and fallback',credentialPresent:Boolean(environment[names.prospeoKey])},
  {provider:'clay' as const,name:'Clay',use:'Optional deeper enrichment for Tier 1 only',credentialPresent:Boolean(environment[names.clayWebhook]&&environment[names.clayToken])},
 ];
 const items:OutreachProviderConnectionStatus[]=specifications.map(item=>({...item,adapterPrepared:true,bindingReferencePresent,clientOwnedBindingVerified:false,executionAllowed:false,status:item.credentialPresent?'configuration-review-required':'awaiting-client-account',nextAction:item.credentialPresent?'Client administrator verifies account ownership, permitted operations, mapping and limits before approval.':`Example Representative connects the Example Charter-owned ${item.name} account through the client-controlled setup.`}));
 return {items,independentVerification:'Separate approved verification binding remains required; enrichment flags alone do not establish independent validation.',accountOwner:'Example Charter / Example Representative',realLookupEnabled:false,providerRequestsMadeByThisStatus:false,creditSpendEnabled:false,readinessEvidence:'Server credential/reference presence only. No account or production connection has been verified by this status view.'};
}
