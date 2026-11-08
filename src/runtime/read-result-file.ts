import "server-only";
import path from "node:path";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import type { DynamicToolCallResponse } from "../../contracts/codex/0.162.1/types/v2/DynamicToolCallResponse";
import { persistImmutableDocument } from "./generated-document-artifacts";
import { readRegularFileWithin } from "@/security/safe-file";
import { G03_SAGE_NAMESPACE } from "./g03-sage-tool-contract";
import { TRINALUM_NAMESPACE } from "./trinalum-tool-contract";

const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
// Server-owned effect metadata for these exact registered handlers. A successful
// handler has already validated the command, provider route, actor and arguments.
const readPolicies: Readonly<Record<string, Readonly<Record<string, (args: unknown) => boolean>>>> = {
  [G03_SAGE_NAMESPACE]: { discover: () => true, read: () => true, read_batch: () => true },
  [TRINALUM_NAMESPACE]: {
    attio_api: args => record(args) && args.command === "read",
    sibema_api: args => record(args) && args.command === "read",
  },
};
export function ownedReadResultPolicy(namespace: string, tool: string, args: unknown) {
  return Object.hasOwn(readPolicies, namespace) && Object.hasOwn(readPolicies[namespace], tool) && readPolicies[namespace][tool](args);
}
export type ReadResultFileContext = {
  installationId: string; userId: string; projectId: string; threadId: string; turnId: string; callId: string;
  usersRoot: string; workspaceRoot: string; projectWorkspace: string; fileDelivery?: boolean;
};
function need(ok: unknown): asserts ok { if (!ok) throw Error("TOOL_RESULT_CAPTURE_UNAVAILABLE"); }
async function capture(bytes: Buffer, c: ReadResultFileContext) {
  need(/^[a-z][a-z0-9-]{0,119}$/u.test(c.installationId) && [c.userId,c.projectId,c.threadId,c.turnId].every(v => uuid.test(v)) &&
    typeof c.callId === "string" && c.callId.length > 0 && c.callId.length <= 512);
  need(path.isAbsolute(c.usersRoot) && path.join(c.usersRoot,c.userId,"workspace") === c.workspaceRoot && path.join(c.workspaceRoot,"projects",c.projectId) === c.projectWorkspace);
  const root = await lstat(c.projectWorkspace);
  need(root.isDirectory() && !root.isSymbolicLink() && await realpath(c.projectWorkspace) === c.projectWorkspace && root.uid === process.getuid?.());
  let directory = c.projectWorkspace;
  for (const part of [".tool-results",c.turnId]) {
    directory = path.join(directory,part);
    await mkdir(directory,{mode:0o700}).catch(error => { if (error.code !== "EEXIST") throw error; });
    const st = await lstat(directory);
    need(st.isDirectory() && !st.isSymbolicLink() && await realpath(directory) === directory && st.uid === root.uid && (st.mode & 0o777) === 0o700);
  }
  const st = await lstat(directory), fileName = `${hash(JSON.stringify([c.installationId,c.userId,c.projectId,c.threadId,c.turnId,c.callId]))}.json`;
  await persistImmutableDocument({path:directory,device:st.dev,inode:st.ino,dataRoot:c.projectWorkspace},fileName,bytes,bytes.length);
  const target = path.join(directory,fileName);
  const handle = await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
  try { const file = await handle.stat();need(file.isFile() && file.uid === root.uid && file.nlink === 1);await handle.chmod(0o400); }
  finally { await handle.close(); }
  const observed = await readRegularFileWithin(c.projectWorkspace,path.relative(c.projectWorkspace,target),bytes.length);
  const after = await lstat(c.projectWorkspace), file = await lstat(target);
  need(after.dev === root.dev && after.ino === root.ino && file.nlink === 1 && file.uid === root.uid && observed.equals(bytes));
  return {relativePath:path.relative(c.projectWorkspace,target).split(path.sep).join("/"),bytes:bytes.length,sha256:hash(bytes)};
}
function shape(value: unknown) {
  const arrays: Array<{jsonPointer:string;count:number}> = [];
  const visit = (v: unknown, pointer: string, depth: number) => {
    if (Array.isArray(v)) { if (arrays.length < 16) arrays.push({jsonPointer:pointer,count:v.length});return; }
    if (depth < 4 && record(v)) for (const [key,child] of Object.entries(v).filter(([key]) => key.length <= 128).slice(0,32)) if (pointer.length + key.length <= 510) visit(child,`${pointer}/${key.replaceAll("~","~0").replaceAll("/","~1")}`,depth+1);
  };
  visit(value,"",0);
  const keys = record(value)?Object.keys(value):[];
  const visibleKeys = keys.filter(key => key.length <= 128).slice(0,32);
  return {type:Array.isArray(value)?"array":"object",keys:visibleKeys,keysTruncated:visibleKeys.length !== keys.length,arrayCounts:arrays};
}
/** One pre-RPC boundary for owned dynamic tools; original bytes stay in the file. */
export async function finalizeOwnedReadResult(
  response: unknown, call: {namespace:string;tool:string;arguments:unknown}, context: ReadResultFileContext,
): Promise<unknown> {
  if (context.fileDelivery === true || !ownedReadResultPolicy(call.namespace,call.tool,call.arguments) || !record(response) || response.success !== true ||
      !Array.isArray(response.contentItems) || response.contentItems.length !== 1) return response;
  const item = response.contentItems[0];
  if (!record(item) || item.type !== "inputText" || typeof item.text !== "string" || Buffer.byteLength(item.text,"utf8") <= 65536) return response;
  let value: unknown;
  try { value = JSON.parse(item.text); } catch { return response; }
  if (!record(value) && !Array.isArray(value)) return response;
  try {
    const file = await capture(Buffer.from(item.text,"utf8"),context);
    return {success:true,contentItems:[{type:"inputText",text:JSON.stringify({kind:"private-json-result",untrustedData:true,...file,mediaType:"application/json",wholeResponseSaved:true,
      sourceCoverage:"Unchanged in saved JSON; file capture does not establish complete provider coverage.",shape:shape(value)})}]} satisfies DynamicToolCallResponse;
  } catch {
    return {success:false,contentItems:[{type:"inputText",text:'{"error":"TOOL_RESULT_CAPTURE_UNAVAILABLE","inlineFallback":false}'}]} satisfies DynamicToolCallResponse;
  }
}
