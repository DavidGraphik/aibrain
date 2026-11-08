import{afterEach,expect,it,vi}from"vitest";
import{ColdThreadRecoveryTimeoutError,withColdThreadRecoveryDeadline}from"./cold-thread-recovery";
afterEach(()=>vi.useRealTimers());
it.each(["resume","read"])("bounds a hanging cold %s without creating or dispatching another model turn",async()=>{
 vi.useFakeTimers();let expired=false;const create=vi.fn(),dispatch=vi.fn();const history=[{content:"saved original"}];const before=JSON.stringify(history);
 const result=withColdThreadRecoveryDeadline(async()=>{await new Promise(()=>{});create();dispatch();},()=>{expired=true;});
 const assertion=expect(result).rejects.toBeInstanceOf(ColdThreadRecoveryTimeoutError);
 await vi.advanceTimersByTimeAsync(90_000);await assertion;
 expect(expired).toBe(true);expect(create).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();expect(JSON.stringify(history)).toBe(before);
});
it("clears its deadline after a normal metadata result and never expires a later model request",async()=>{
 vi.useFakeTimers();const expired=vi.fn();expect(await withColdThreadRecoveryDeadline(async()=>"same-thread",expired)).toBe("same-thread");await vi.advanceTimersByTimeAsync(100_000);expect(expired).not.toHaveBeenCalled();
});
it.each([false,true])("cancels hanging metadata before its deadline, without invoking a cancelled operation (preaborted=%s)",async preaborted=>{
 vi.useFakeTimers();const controller=new AbortController(),expired=vi.fn(),started=vi.fn();
 if(preaborted)controller.abort();
 const pending=withColdThreadRecoveryDeadline(async()=>{started();return await new Promise(()=>{});},expired,90_000,controller.signal);
 const assertion=expect(pending).rejects.toMatchObject({name:"AbortError"});
 if(!preaborted){await Promise.resolve();controller.abort();}
 await assertion;expect(expired).toHaveBeenCalledOnce();if(preaborted)expect(started).not.toHaveBeenCalled();
});
