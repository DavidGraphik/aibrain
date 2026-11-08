import { expect, it } from "vitest";
import { capacityContinuationKey } from "./capacity-continuation";
import { MODEL_CAPACITY_MESSAGE } from "@/runtime/model-capacity-retry";
import type { AutomationTask } from "./contracts";
import type { ChatMessage } from "@/lib/chat-contract";
const task = { prompt: "Read current maintenance", schedule: {kind:"daily"}, executionContext:{} } as AutomationTask;
const id = (key:string)=>key;
const empty={createdAt:"2026-10-27T00:00:00.000Z",activity:[],plan:[],diff:"",attachments:[],artifacts:[],sources:[],approvals:[],toolResults:[]};
const pair=(key:string,status:ChatMessage["status"]="error",content=MODEL_CAPACITY_MESSAGE):ChatMessage[]=>[
 {...empty,id:`${key}:user`,role:"user",status:"complete",content:task.prompt},
 {...empty,id:`${key}:assistant`,role:"assistant",status,content,approvals:[],toolResults:[]},
];
it("continues partial read-only capacity work with stable bounded receipt identities and preserves evidence",()=>{
 const messages=pair("run");const before=JSON.stringify(messages);
 expect(capacityContinuationKey(task,"run",messages,id)).toBe("run:capacity-continuation:1");
 expect(JSON.stringify(messages)).toBe(before);
 messages.push(...pair("run:capacity-continuation:1"));
 expect(capacityContinuationKey(task,"run",messages,id)).toBe("run:capacity-continuation:2");
 messages.push(...pair("run:capacity-continuation:2"));
 expect(capacityContinuationKey(task,"run",messages,id)).toBe("run:capacity-continuation:2");
});
it.each(["complete","streaming","stopped"] as const)("reuses the same continuation after %s without another submission",status=>{
 expect(capacityContinuationKey(task,"run",[...pair("run"),...pair("run:capacity-continuation:1",status)],id)).toBe("run:capacity-continuation:1");
});
it("never retries uncertain failures, foreign prompts, external jobs or granted effects",()=>{
 for(const content of ["Transport failed","Unknown outcome","429","Provider quota exhausted"])
  expect(capacityContinuationKey(task,"run",pair("run","error",content),id)).toBe("run");
 const altered=pair("run");altered[0].content="Different source";
 expect(capacityContinuationKey(task,"run",altered,id)).toBe("run");
 for(const candidate of [{...task,schedule:{kind:"external"}},{...task,executionContext:{allowedEffects:["mail-draft"]}},{...task,executionContext:{effectGrant:{}}}])
  expect(capacityContinuationKey(candidate as AutomationTask,"run",pair("run"),id)).toBe("run");
 const pending=pair("run");pending[1].toolResults=[{status:"running"}] as ChatMessage["toolResults"];
 expect(capacityContinuationKey(task,"run",pending,id)).toBe("run");
});
