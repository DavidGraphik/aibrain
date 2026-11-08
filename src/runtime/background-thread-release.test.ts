import { afterEach, describe, expect, it, vi } from 'vitest';
import { releaseBackgroundThread } from './background-thread-release';
import { AppServerRequestTimeoutError } from './transport/app-server-rpc-router';
import type { AppServerRequest, JsonValue, TransportHealth } from './transport/contracts';
const purpose='background-release:own-turn:own-unique-request',threadId='own-thread';
const defer=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};};
afterEach(()=>vi.useRealTimers());
function fixture(){
 const late=defer<JsonValue>(),signal=new AbortController(),onRecovered=vi.fn();
 const state:TransportHealth={healthy:true,state:'connected',endpoint:'ws://127.0.0.1:1234',sessionId:'own-session',connectionId:'own-connection',reconnectAttempt:0,pendingRequests:0,lastEventId:null,lastEventSequence:null,lastConnectedAt:null,lastMessageAt:null,lastHeartbeatAt:null,lastError:null};
 const transport={health:vi.fn(async()=>({...state})),recoverResponse:vi.fn(async(_request:AppServerRequest)=>({id:purpose,result:{status:'unsubscribed'}}))};
 const request=vi.fn(async()=>{throw new AppServerRequestTimeoutError('thread/unsubscribe',purpose,5000,late.promise);});
 const client={request,handle:{installationId:'own-tenant',userId:'own-user',workerId:'own-worker',transport:transport as never}};
 const run=()=>releaseBackgroundThread({client,threadId,purpose,signal:signal.signal,onRecovered});
 return{late,signal,onRecovered,state,transport,request,client,run};
}
describe('background writer release recovers only its exact late durable ACK',()=>{
 it('waits537ms for the same late ACK and reads its private receipt without another dispatch',async()=>{
  vi.useFakeTimers();const f=fixture();const result=f.run();await vi.advanceTimersByTimeAsync(537);f.late.resolve({status:'unsubscribed'});await result;
  expect(f.request).toHaveBeenCalledExactlyOnceWith('thread/unsubscribe',{threadId},purpose,5000);
  expect(f.transport.recoverResponse).toHaveBeenCalledExactlyOnceWith({clientRequestId:purpose,kind:'rpc-request',rpc:{method:'thread/unsubscribe',id:purpose,params:{threadId}}});expect(f.onRecovered).toHaveBeenCalledOnce();
 });
 it('accepts an ordinary confirmed ACK without demanding recovery metadata or journal lookup',async()=>{
  const f=fixture();f.request.mockResolvedValueOnce({status:'notSubscribed'} as never);await f.run();expect(f.transport.recoverResponse).not.toHaveBeenCalled();expect(f.onRecovered).not.toHaveBeenCalled();
 });
 it.each(['sessionId','connectionId','endpoint']as const)('rejects a late ACK after %s changed',async field=>{
  const f=fixture();const result=expect(f.run()).rejects.toThrow('SCOPE_CHANGED');await Promise.resolve();f.state[field]='foreign-or-stale';f.late.resolve({status:'unsubscribed'});await result;expect(f.onRecovered).not.toHaveBeenCalled();expect(f.transport.recoverResponse).not.toHaveBeenCalled();
 });
 it('rejects a switched user/client transport even if the old RPC returns success',async()=>{
  const f=fixture();const result=expect(f.run()).rejects.toThrow('SCOPE_CHANGED');await Promise.resolve();f.client.handle.userId='another-user';f.late.resolve({status:'unsubscribed'});await result;expect(f.onRecovered).not.toHaveBeenCalled();
 });
 it('never accepts a foreign request timeout',async()=>{
  const f=fixture();f.request.mockRejectedValueOnce(new AppServerRequestTimeoutError('thread/unsubscribe','another-request',5000,f.late.promise));await expect(f.run()).rejects.toThrow('timed out');expect(f.transport.recoverResponse).not.toHaveBeenCalled();
 });
 it('requires an authoritative matching receipt rather than trusting stream success alone',async()=>{
  const f=fixture();f.transport.recoverResponse.mockResolvedValueOnce(null as never);f.late.resolve({status:'unsubscribed'});await expect(f.run()).rejects.toThrow('RECEIPT_INVALID');expect(f.onRecovered).not.toHaveBeenCalled();
 });
 it('rejects a receipt for a foreign request',async()=>{
  const f=fixture();f.transport.recoverResponse.mockResolvedValueOnce({id:'foreign',result:{status:'unsubscribed'}});f.late.resolve({status:'unsubscribed'});await expect(f.run()).rejects.toThrow('RECEIPT_INVALID');
 });
 it('preserves the gateway canonical-hash rejection of changed thread parameters',async()=>{
  const f=fixture();f.transport.recoverResponse.mockRejectedValueOnce(Error('Recovery request does not match its durable receipt.'));f.late.resolve({status:'unsubscribed'});await expect(f.run()).rejects.toThrow('does not match');expect(f.onRecovered).not.toHaveBeenCalled();
 });
 it('rejects conflicting stream and journal ACKs',async()=>{
  const f=fixture();f.transport.recoverResponse.mockResolvedValueOnce({id:purpose,result:{status:'notLoaded'}});f.late.resolve({status:'unsubscribed'});await expect(f.run()).rejects.toThrow('RECEIPT_INVALID');
 });
 it('cannot extend the caller deadline while awaiting a late ACK',async()=>{
  const f=fixture();const result=expect(f.run()).rejects.toThrow('HOST_EXECUTION_TIMEOUT');await Promise.resolve();f.signal.abort(Error('HOST_EXECUTION_TIMEOUT'));await result;f.late.resolve({status:'unsubscribed'});expect(f.onRecovered).not.toHaveBeenCalled();
 });
 it('fails closed at the bounded recovery window without resending or accepting a later ACK',async()=>{
  vi.useFakeTimers();const f=fixture();const result=expect(f.run()).rejects.toBeInstanceOf(AppServerRequestTimeoutError);await vi.advanceTimersByTimeAsync(5000);await result;f.late.resolve({status:'unsubscribed'});await Promise.resolve();expect(f.onRecovered).not.toHaveBeenCalled();expect(f.request).toHaveBeenCalledOnce();
 });
 it('fails closed when session/connection identity is unavailable',async()=>{
  const f=fixture();delete f.state.sessionId;f.late.resolve({status:'unsubscribed'});await expect(f.run()).rejects.toBeInstanceOf(AppServerRequestTimeoutError);expect(f.transport.recoverResponse).not.toHaveBeenCalled();
 });
});
