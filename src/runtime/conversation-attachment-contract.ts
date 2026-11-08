import type { DynamicToolSpec } from '../../contracts/codex/0.162.1/types/v2/DynamicToolSpec';
import type { JsonValue } from '../../contracts/codex/0.162.1/types/serde_json/JsonValue';
const tool=(name:string,description:string,properties:Record<string,JsonValue>,required:string[])=>({type:'function' as const,name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
// Attachment operations are composed with the session-authorized history tools.
export const CONVERSATION_ATTACHMENT_DYNAMIC_TOOLS: readonly DynamicToolSpec[] = Object.freeze([{
 type:'namespace',name:'aibrain_conversations',
 description:'Find and open your own original human-uploaded attachments from prior chats. Metadata only: no chat bodies, project workspace files or other employees. Original copies can be exposed only in your current private owned project; source and destination permissions are checked again.',
 tools:[
  tool('search_attachments','Find an original you previously uploaded, by filename substring and optional actual human-message date range (since inclusive, before exclusive). Includes archived own chats. Continue the SAME filters and returned cursor while needed; partial coverage/errors do not prove absence. Returns exact references for open_attachment, never document contents.',{
   fileName:{type:'string',minLength:2,maxLength:120},since:{type:'string',maxLength:35},before:{type:'string',maxLength:35},limit:{type:'integer',minimum:1,maximum:20},cursor:{type:'string',maxLength:512},
  },['fileName']),
  tool('open_attachment','Expose the unchanged original from an exact own human-upload reference returned by search_attachments in this current private chat. Checks current source/destination access, message membership, staged identity, size and hash. Repeat reuses the same private copy. This does not read its pages or save it as project-wide memory. For PDF contents use read_private_file with returned artifact.id.',{
   threadId:{type:'string',format:'uuid'},messageId:{type:'string',format:'uuid'},uploadId:{type:'string',format:'uuid'},
  },['threadId','messageId','uploadId']),
 ],
}]);

// G03 reuses metadata search but never exposes Trinalum's copying operation.
// This reference is a turn-scoped read capability, not a new uploaded file.
export const G03_HISTORICAL_PDF_TOOLS = [
 tool('search_attachments','Find your own original human-uploaded attachments by filename, including archived chats. Continue the same cursor and do not infer absence from partial coverage. Returns exact references, not document contents.',{
  fileName:{type:'string',minLength:2,maxLength:120},since:{type:'string',maxLength:35},before:{type:'string',maxLength:35},limit:{type:'integer',minimum:1,maximum:20},cursor:{type:'string',maxLength:512},
 },['fileName']),
 tool('reference_historical_pdf','Link the exact original PDF you uploaded in a prior own conversation to the current turn, without copying it or modifying the source chat. Use only an exact result from search_attachments. The server rechecks both conversations, current permissions and original hash on every access. Then use inspect_attachment and translation tools with the returned filename. To resume later, link the same exact original again before translation_status; saved progress remains bound to this destination chat and source hash.',{
  threadId:{type:'string',format:'uuid'},messageId:{type:'string',format:'uuid'},uploadId:{type:'string',format:'uuid'},
 },['threadId','messageId','uploadId']),
] as const;
