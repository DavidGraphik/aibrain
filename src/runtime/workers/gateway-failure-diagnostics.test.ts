import { expect,it } from "vitest";
import { gatewayFailureDiagnostic } from "./gateway-failure-diagnostics";
it("records bounded structural failure evidence without untrusted messages, paths, stderr or credentials",()=>{
 const error=Object.assign(new Error("Bearer private-secret providerbody /private/mailbox"),{code:"STORAGE_LOCK_OWNERSHIP_LOST",cause:Object.assign(new Error("password=secret"),{code:"EACCES"})});
 const receipt=gatewayFailureDiagnostic("stdout-processing",error,0);
 expect(receipt).toEqual({schemaVersion:1,occurredAt:"1970-01-01T00:00:00.000Z",stage:"stdout-processing",errorType:"Error",code:"STORAGE_LOCK_OWNERSHIP_LOST",causeCode:"EACCES"});
 expect(JSON.stringify(receipt)).not.toMatch(/secret|private|password|providerbody|mailbox/);
 expect(JSON.stringify(receipt).length).toBeLessThan(512);
});
it("retains child exit evidence and refuses unrecognized error metadata",()=>{
 const error=Object.assign(new Error("secret"),{name:"private-token",code:"PRIVATE_SECRET"});
 expect(gatewayFailureDiagnostic("child-exit",error,0,{code:137,signal:"SIGKILL"})).toMatchObject({exitCode:137,signal:"SIGKILL",errorType:"unknown",code:null});
 expect(gatewayFailureDiagnostic("child-exit",error,0,{code:null,signal:"private-secret" as NodeJS.Signals})).toMatchObject({exitCode:null,signal:null});
});
