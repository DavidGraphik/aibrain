// @vitest-environment jsdom
import {act, cleanup, renderHook} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {initialRuntimeStatus} from '@/lib/runtime-status';
import {useRuntimeStatus} from './use-runtime-status';
const unavailable={...initialRuntimeStatus,codex:'unavailable',ready:false};
const connected={...initialRuntimeStatus,codex:'connected',ready:true};
const input: {hydrated:boolean;online:boolean;projectId:string|null;retry:number}={hydrated:true,online:true,projectId:null,retry:0};
const response=(value:unknown)=>({ok:true,json:async()=>value});
beforeEach(()=>{vi.useFakeTimers();Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
it('recovers after the initial three failed probes without a reload or user task',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(response(unavailable)).mockResolvedValueOnce(response(unavailable)).mockResolvedValueOnce(response(unavailable)).mockResolvedValue(response(connected));vi.stubGlobal('fetch',fetcher);
 const {result}=renderHook(()=>useRuntimeStatus(input));
 await act(async()=>{});expect(result.current.ready).toBe(false);
 await act(async()=>vi.advanceTimersByTimeAsync(2000));await act(async()=>vi.advanceTimersByTimeAsync(4000));
 expect(fetcher).toHaveBeenCalledTimes(3);expect(result.current.codex).toBe('unavailable');
 await act(async()=>vi.advanceTimersByTimeAsync(30000));expect(fetcher).toHaveBeenCalledTimes(4);expect(result.current.ready).toBe(true);
 await act(async()=>vi.advanceTimersByTimeAsync(300000));expect(fetcher).toHaveBeenCalledTimes(4);
 expect(fetcher.mock.calls.every(([url])=>url==='/api/runtime/status')).toBe(true);
});
it('stops retries while hidden and recovers when the user returns',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(response(unavailable)).mockResolvedValue(response(connected));vi.stubGlobal('fetch',fetcher);
 const {result}=renderHook(()=>useRuntimeStatus(input));await act(async()=>{});
 act(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
 await act(async()=>vi.advanceTimersByTimeAsync(300000));expect(fetcher).toHaveBeenCalledTimes(1);
 await act(async()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));});expect(result.current.ready).toBe(true);expect(fetcher).toHaveBeenCalledTimes(2);
});
it('coalesces focus events and never accepts a prior project response after navigation',async()=>{
 let resolve!:(v:unknown)=>void; const fetcher=vi.fn().mockImplementationOnce(()=>new Promise(r=>{resolve=r;})).mockResolvedValue(response(unavailable));vi.stubGlobal('fetch',fetcher);
 const {result,rerender}=renderHook(p=>useRuntimeStatus(p),{initialProps:input as typeof input&{projectId:string|null}});
 act(()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('focus'));});expect(fetcher).toHaveBeenCalledTimes(1);
 rerender({...input,projectId:'new-project'});await act(async()=>{});await act(async()=>resolve(response(connected)));expect(result.current.ready).toBe(false);expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
});
it('does not probe offline and clears pending retries after unmount',async()=>{
 const fetcher=vi.fn().mockResolvedValue(response(unavailable));vi.stubGlobal('fetch',fetcher);const offline=renderHook(()=>useRuntimeStatus({...input,online:false}));await act(async()=>{});expect(fetcher).not.toHaveBeenCalled();offline.unmount();
 const live=renderHook(()=>useRuntimeStatus(input));await act(async()=>{});expect(fetcher).toHaveBeenCalledTimes(1);live.unmount();await act(async()=>vi.advanceTimersByTimeAsync(300000));act(()=>window.dispatchEvent(new Event('focus')));expect(fetcher).toHaveBeenCalledTimes(1);
});
it('recovers after a request that stays unresolved even when aborted and ignores its late result',async()=>{
 let resolveFirst!:(v:unknown)=>void;
 const fetcher=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{resolveFirst=resolve;})).mockResolvedValue(response(connected));vi.stubGlobal('fetch',fetcher);
 const {result}=renderHook(()=>useRuntimeStatus(input));
 await act(async()=>vi.advanceTimersByTimeAsync(40000));
 expect(result.current.ready).toBe(false);expect(result.current.codex).toBe('unavailable');expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
 await act(async()=>vi.advanceTimersByTimeAsync(2000));
 expect(fetcher).toHaveBeenCalledTimes(2);expect(result.current.ready).toBe(true);
 await act(async()=>resolveFirst(response(unavailable)));
 expect(result.current.ready).toBe(true);
 await act(async()=>vi.advanceTimersByTimeAsync(300000));expect(fetcher).toHaveBeenCalledTimes(2);
});
it('coalesces focus checks while healthy and does not start healthy polling',async()=>{
 let resolveFocus!:(v:unknown)=>void;
 const fetcher=vi.fn().mockResolvedValueOnce(response(connected)).mockImplementationOnce(()=>new Promise(resolve=>{resolveFocus=resolve;}));vi.stubGlobal('fetch',fetcher);
 const {result}=renderHook(()=>useRuntimeStatus(input));await act(async()=>{});expect(result.current.ready).toBe(true);
 act(()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('focus'));});
 expect(fetcher).toHaveBeenCalledTimes(2);
 await act(async()=>resolveFocus(response(connected)));await act(async()=>vi.advanceTimersByTimeAsync(300000));
 expect(result.current.ready).toBe(true);expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([401,403])('clears a previously ready state on HTTP %s without trusting its body',async status=>{
 const forbiddenBody=vi.fn().mockResolvedValue(connected);
 const fetcher=vi.fn().mockResolvedValueOnce(response(connected)).mockResolvedValue({ok:false,status,json:forbiddenBody});vi.stubGlobal('fetch',fetcher);
 const {result}=renderHook(()=>useRuntimeStatus(input));await act(async()=>{});expect(result.current.ready).toBe(true);
 await act(async()=>window.dispatchEvent(new Event('focus')));
 expect(result.current.ready).toBe(false);expect(result.current.codex).toBe('unavailable');expect(forbiddenBody).not.toHaveBeenCalled();
});
it('clears a prior sign-in diagnosis when a later observation cannot reach the service',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(response({...unavailable,authenticationRequired:true})).mockRejectedValue(new Error('offline'));
 vi.stubGlobal('fetch',fetcher);const {result}=renderHook(()=>useRuntimeStatus(input));await act(async()=>{});
 expect(result.current.authenticationRequired).toBe(true);
 await act(async()=>window.dispatchEvent(new Event('focus')));
 expect(result.current).toMatchObject({codex:'unavailable',ready:false,authenticationRequired:false});
});
