import{mkdtemp,mkdir,rm}from"node:fs/promises";
import{tmpdir}from"node:os";
import path from"node:path";
import{randomUUID}from"node:crypto";
import{expect,it}from"vitest";
import{DurableTurnSubmission,TurnSubmissionRecoveryRequired}from"./turn-submission-store";
import{stopOrphanedUnsubmittedTurn}from"./orphaned-turn-stop";
it("holds the runner lease through tombstone+projection, fences late callbacks and concurrent new admission",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"orphan-stop-"));const userId=randomUUID(),threadId=randomUUID(),assistantMessageId=randomUUID(),projectId=randomUUID(),userRoot=path.join(root,userId),workspace=path.join(userRoot,"workspace","projects",projectId);await mkdir(workspace,{recursive:true,mode:0o700});
 const options={installationId:"stop-lab",userId,threadId,assistantMessageId,userRoot,workspace,projectId,binding:"a".repeat(64)};
 const old=await DurableTurnSubmission.open(options);await old.close();
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
 const stopping=stopOrphanedUnsubmittedTurn({installationId:"stop-lab",usersRoot:root,userId,threadId,assistantMessageId,projectId},async()=>{enter();await gate;});
 try {
  await entered;
  await expect(DurableTurnSubmission.open(options)).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);
  await expect(old.bindThread("late-gateway-callback")).rejects.toBeDefined();
  release();expect(await stopping).toBe(true);
  const recovery=await DurableTurnSubmission.open({...options,recoveryOnly:true});expect(recovery.cancelledBeforeDispatch).toBe(true);expect(recovery.runtimeThreadId).toBeNull();
  await expect(recovery.startThreadOnce({},"fresh-create")).rejects.toBeInstanceOf(TurnSubmissionRecoveryRequired);await recovery.close();
 }finally{release();await stopping.catch(()=>{});await rm(root,{recursive:true,force:true});}
});
