export type CRMActor = {installationId:string;userId:string;threadId:string;turnId:string;expiresAt:string;backgroundExecution:boolean};
export type CRMSelectionInput = {selectionRef:string;revision:string;recordRefs:string[]};
type Base = {actor:CRMActor;authorize:()=>Promise<boolean>;env?:NodeJS.ProcessEnv;now?:number};
export function crmConnectionStatus(options:Base):Promise<unknown>;
export function readSelectedFacts(options:Base & {input:CRMSelectionInput}):Promise<unknown>;
export function dispatchSelectedContacts(options:Base & {input:CRMSelectionInput;dataRoot:string;fetcher?:typeof fetch}):Promise<unknown>;
