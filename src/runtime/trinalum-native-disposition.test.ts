import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { ChatAction } from "./trinalum-chat-actions";
import type { ConnectorReconciliationProof } from "./approval-store";
import { checkedNativeDisposition, nativeAttioActors, nativeAttioHashes } from "./trinalum-native-disposition";
vi.mock("server-only", () => ({}));
const installationId="trinalum-production",userId="11111111-1111-4111-8111-111111111111";
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
function fixture(){
 const now=Date.now(),id="web-"+"a".repeat(64),threadId="synthetic-thread",turnId="synthetic-turn";
 const action:ChatAction={version:1,id,installationId,userId,threadId,sourceTurnId:turnId,sourceMessageId:"synthetic-human-message",operation:"attio_action",input:{type:"create_company",request:{values:{name:"Synthetic David QA",domains:["synthetic.invalid"]}}},locator:{installationId,userId,threadId,turnId,itemId:id,approvalId:id},fingerprint:hash("immutable action"),bindingHash:hash("binding"),permissionFingerprint:hash("permission"),prepared:{},preview:"Synthetic exact action",displayedAt:null,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+60_000).toISOString()};
 const proof={proofVersion:1,proofCategory:"definitive-rejection",installationId,userId,operation:"attio_action",actionId:action.id,requestedBy:"David",...nativeAttioHashes(action,"David"),nativeRecordSha256:hash("native exact rejected record"),nativeStatus:"rejected",approvedAt:new Date(now-20).toISOString(),approvedBy:"David",dispatchedAt:new Date(now-10).toISOString(),definitiveRejection:true,providerStatus:400,providerCode:"validation_type",error:{status:400,code:"validation_type"},executedAt:null,providerResultPresent:false,resultPresent:false,readbackPresent:false,otherClaimHeld:false,dispatchGuarantee:"attio-durable-before-mutation-v1",legacyHistoryCertified:false,checkedAt:new Date(now).toISOString(),expiresAt:new Date(now+30_000).toISOString()} as ConnectorReconciliationProof;
 return {action,proof};
}
describe("David native Attio validation disposition",()=>{
 it("accepts the exact connected David identity and canonical native actor",()=>{
  const {action,proof}=fixture();
  expect(nativeAttioActors["operator@example.invalid"]).toBe("David");
  expect(checkedNativeDisposition(proof,action,"operator@example.invalid","definitive-rejection")).toMatchObject({requestedBy:"David",nativeStatus:"rejected",providerStatus:400});
 });
 it.each(["other@example.test","operator-personal@example.invalid","manager@example.invalid",undefined])("does not treat %s as the David actor",email=>{
  const {action,proof}=fixture();expect(()=>checkedNativeDisposition(proof,action,email,"definitive-rejection")).toThrow();
 });
 it.each(["requestedBy","approvedBy","installationId","userId","actionId","requestHash","effectHash"])("rejects a changed %s instead of bypassing identity or hashes",key=>{
  const {action,proof}=fixture();const changed={...proof,[key]:key.endsWith("Hash")?"0".repeat(64):key==="requestedBy"||key==="approvedBy"?"Miguel":key==="installationId"?"foreign-tenant":key==="actionId"?"web-"+"b".repeat(64):"22222222-2222-4222-8222-222222222222"};
  expect(()=>checkedNativeDisposition(changed,action,"operator@example.invalid","definitive-rejection")).toThrow();
 });
});
