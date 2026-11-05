// @vitest-environment jsdom
import { expect,it,vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { appDocument,APP_CSP } from './sandbox';
import config from '../../next.config';
it('loads the database bridge before executable user code in a properly closed script',()=>{
 const parsed=new DOMParser().parseFromString(appDocument('<script>window.programLoaded=typeof window.aibrain.data === "function";</script>','qa-channel'),'text/html');
 const scripts=[...parsed.querySelectorAll('script')];expect(scripts).toHaveLength(2);
 const scope={window:{} as {programLoaded?:boolean},parent:{postMessage:vi.fn()},addEventListener:vi.fn(),setTimeout:vi.fn()};
 for(const script of scripts)runInNewContext(script.textContent??'',scope);
 expect(scope.window.programLoaded).toBe(true);
});
it('overrides framing headers for exactly the sandbox route and retains main-app framing denial',async()=>{const rules=await config.headers!();const common=rules.find(r=>r.source==='/:path*')!;const preview=rules.find(r=>r.source==='/api/g03/apps/preview')!;expect(common.headers.find(h=>h.key==='X-Frame-Options')?.value).toBe('DENY');expect(preview.headers.find(h=>h.key==='Content-Security-Policy')?.value).toBe(APP_CSP);expect(preview.headers.find(h=>h.key==='X-Frame-Options')?.value).toBe('SAMEORIGIN');expect(APP_CSP).toContain("connect-src 'none'");expect(APP_CSP).toContain('sandbox allow-scripts allow-forms');expect(APP_CSP).toContain("form-action 'none'");expect(APP_CSP).not.toContain('allow-same-origin');});
