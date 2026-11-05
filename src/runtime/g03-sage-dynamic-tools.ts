import type { DynamicToolCallParams } from "../../contracts/codex/0.162.1/types/v2/DynamicToolCallParams";
import type { DynamicToolCallResponse } from "../../contracts/codex/0.162.1/types/v2/DynamicToolCallResponse";
import type { AuthSession } from "@/auth/types";
import { g03SageReadForIdentity } from "@/connectors/g03-sage-service";
import { g03SageOperation } from "@/connectors/g03-sage-operation-service";
import { SageError, sageRecord } from "@/connectors/g03-sage-api";
import { G03_SAGE_NAMESPACE } from "./g03-sage-tool-contract";
export { G03_SAGE_NAMESPACE, G03_SAGE_DYNAMIC_TOOLS } from "./g03-sage-tool-contract";
export async function handleG03SageTool(params: DynamicToolCallParams, c: { installationId: string; userId: string; session: AuthSession | null; runtimeThreadId: string; runtimeTurnId: string; selected: boolean; executeAllowed: boolean; allowWrites?:boolean; requestId?:string }): Promise<DynamicToolCallResponse> {
  const result = (success:boolean,value:unknown):DynamicToolCallResponse => ({success,contentItems:[{type:"inputText",text:JSON.stringify(value)}]});
  if (params.namespace !== G03_SAGE_NAMESPACE || !["discover","read","operations","schema","prepare","execute","operation"].includes(params.tool) || c.installationId !== "g03-production" || !c.selected || !c.executeAllowed || c.session?.provider !== "local" || c.session.tenant.id !== c.installationId || c.session.user.id !== c.userId || params.threadId !== c.runtimeThreadId || params.turnId !== c.runtimeTurnId || ["prepare","execute"].includes(params.tool)&&(c.allowWrites!==true||typeof c.requestId!=="string"||!c.requestId.length)) return result(false,{error:"SAGE_TURN_DENIED"});
  const args=params.arguments;
  const keys:Record<string,string[]>={discover:[],read:["query","parameters","skip","take"],operations:[],schema:["table"],prepare:["table","action","values","lines","reason"],execute:["operationId"],operation:["operationId"]};
  const required:Record<string,string[]>={discover:[],read:["query","parameters"],operations:[],schema:["table"],prepare:["table","action","values","reason"],execute:["operationId"],operation:["operationId"]};
  if(!sageRecord(args)||Object.keys(args).some(k=>!keys[params.tool].includes(k))||required[params.tool].some(k=>!Object.hasOwn(args,k)))return result(false,{error:"SAGE_ARGUMENTS_INVALID"});
  try {
    return result(true,["discover","read"].includes(params.tool)?await g03SageReadForIdentity(c.installationId,c.userId,params.tool as "discover"|"read",args):await g03SageOperation(c.installationId,c.userId,params.tool as "operations"|"schema"|"prepare"|"execute"|"operation",args,{threadId:c.runtimeThreadId,turnId:c.runtimeTurnId,requestId:c.requestId}));
  }
  catch(error) { return result(false,{error:error instanceof SageError ? error.code : "SAGE_UNAVAILABLE",effectUnconfirmed:params.tool==="execute",notice:params.tool==="execute"?"El envío puede haber ocurrido. Consultar operation; nunca repetir ni crear otra operación para el mismo efecto sin comprobar SAGE.":"No inventes datos, permisos ni cambios en SAGE."}); }
}
