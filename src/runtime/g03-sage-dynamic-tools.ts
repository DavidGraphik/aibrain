import type { DynamicToolCallParams } from "../../contracts/codex/0.162.1/types/v2/DynamicToolCallParams";
import type { DynamicToolCallResponse } from "../../contracts/codex/0.162.1/types/v2/DynamicToolCallResponse";
import type { AuthSession } from "@/auth/types";
import { g03SageReadForIdentity, g03SageReadBatchForIdentity } from "@/connectors/g03-sage-service";
import { g03SageOperation } from "@/connectors/g03-sage-operation-service";
import { SageError, sageRecord } from "@/connectors/g03-sage-api";
import { G03_SAGE_NAMESPACE } from "./g03-sage-tool-contract";
export { G03_SAGE_NAMESPACE, G03_SAGE_DYNAMIC_TOOLS } from "./g03-sage-tool-contract";
// Reads can be safely abandoned without replaying a provider mutation. A
// bounded result lets the ordered event journal advance after Stop, even if
// an upstream read or access check never settles. Write paths remain untouched.
async function boundedSageRead(c: { installationId: string; userId: string; signal?: AbortSignal },
  tool: "discover" | "read" | "read_batch", args: Record<string, unknown>) {
  if (c.signal?.aborted) throw new SageError("SAGE_READ_CANCELLED");
  const controller = new AbortController();
  let cancel!: () => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => { controller.abort(); reject(new SageError("SAGE_READ_CANCELLED")); };
    c.signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new SageError("SAGE_READ_TIMEOUT")); }, 30_000);
  });
  try {
    return await Promise.race([(tool === "read_batch" ? g03SageReadBatchForIdentity(c.installationId, c.userId, args, controller.signal) : g03SageReadForIdentity(c.installationId, c.userId, tool, args, controller.signal)), cancelled]);
  } finally {
    clearTimeout(timer);
    c.signal?.removeEventListener("abort", cancel);
  }
}
export async function handleG03SageTool(params: DynamicToolCallParams, c: { installationId: string; userId: string; session: AuthSession | null; runtimeThreadId: string; runtimeTurnId: string; selected: boolean; executeAllowed: boolean; allowWrites?:boolean; requestId?:string; signal?:AbortSignal }): Promise<DynamicToolCallResponse> {
  const result = (success:boolean,value:unknown):DynamicToolCallResponse => ({success,contentItems:[{type:"inputText",text:JSON.stringify(value)}]});
  if (params.namespace !== G03_SAGE_NAMESPACE || !["discover","read","read_batch","operations","schema","prepare","execute","operation"].includes(params.tool) || c.installationId !== "g03-production" || !c.selected || !c.executeAllowed || c.session?.provider !== "local" || c.session.tenant.id !== c.installationId || c.session.user.id !== c.userId || !Number.isFinite(Date.parse(c.session.expiresAt)) || Date.parse(c.session.expiresAt) <= Date.now() || params.threadId !== c.runtimeThreadId || params.turnId !== c.runtimeTurnId || ["prepare","execute"].includes(params.tool)&&(c.allowWrites!==true||typeof c.requestId!=="string"||!c.requestId.length)) return result(false,{error:"SAGE_TURN_DENIED"});
  const args=params.arguments;
  const keys:Record<string,string[]>={discover:[],read:["query","parameters","skip","take"],read_batch:["query","parameters","skip","take"],operations:[],schema:["table"],prepare:["table","action","values","lines","reason"],execute:["operationId"],operation:["operationId"]};
  const required:Record<string,string[]>={discover:[],read:["query","parameters"],read_batch:["query"],operations:[],schema:["table"],prepare:["table","action","values","reason"],execute:["operationId"],operation:["operationId"]};
  if(!sageRecord(args)||Object.keys(args).some(k=>!keys[params.tool].includes(k))||required[params.tool].some(k=>!Object.hasOwn(args,k)))return result(false,{error:"SAGE_ARGUMENTS_INVALID"});
  try {
    return result(true,["discover","read","read_batch"].includes(params.tool)?await boundedSageRead(c,params.tool as "discover"|"read"|"read_batch",args):await g03SageOperation(c.installationId,c.userId,params.tool as "operations"|"schema"|"prepare"|"execute"|"operation",args,{threadId:c.runtimeThreadId,turnId:c.runtimeTurnId,requestId:c.requestId}));
  }
  catch(error) { return result(false,{error:error instanceof SageError ? error.code : "SAGE_UNAVAILABLE",effectUnconfirmed:params.tool==="execute",notice:params.tool==="execute"?"El envío puede haber ocurrido. Consultar operation; nunca repetir ni crear otra operación para el mismo efecto sin comprobar SAGE.":"No inventes datos, permisos ni cambios en SAGE."}); }
}
