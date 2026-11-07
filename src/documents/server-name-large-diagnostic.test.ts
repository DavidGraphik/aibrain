import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./server-user-access', async importOriginal => ({ ...await importOriginal<typeof import('./server-user-access')>(), serverUserRoots: vi.fn(async () => ['server-g03/M/Allowed']) }));
import { ServerDocumentFiles } from './server-files';
const entry = (path: string, kind = 'file') => ({ scope: 'company', path, kind, size: 1 });
const scratchRoots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of scratchRoots.splice(0)) rmSync(root,{recursive:true,force:true}); });
describe('large synthetic G03 search diagnostic', () => {
  it('preserves a late matching branch beyond the former bounded queue', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'g03-name-large-')); chmodSync(scratch,0o700); scratchRoots.push(scratch);
    const network = { validateSyncRoots: vi.fn(async () => {}), config: { installationId: 'g03-production', paths: { dataRoot: scratch } } };
    const files = new ServerDocumentFiles(network as never, { userId: 'qa-synthetic' });
    vi.spyOn(files, 'navigation').mockResolvedValue({ available: true, results: [entry('server-g03/M/Allowed', 'directory')] });
    const browsed = new Set<string>();
    const sourceCapability = vi.fn(async () => ({ available: false, error: 'FILENAME_SEARCH_UNSUPPORTED' }));
    vi.spyOn(ServerDocumentFiles.prototype as unknown as { call(roots: unknown, operation: string, input: { query: string }): Promise<object | null> }, 'call').mockImplementation(async (_roots, operation, input) => {
      if (operation === 'filename_search') return sourceCapability();
      expect(operation).toBe('browse');
      const q = input.query; browsed.add(q);
      if (q === 'server:/M/Allowed' || q.startsWith('server:/M/Allowed?offset=')) {
        const offset = Number(q.split('offset=')[1] ?? 0);
        return { available: true, sourceChecked: true, results: Array.from({length: 50}, (_, n) => entry(`server-g03/M/Allowed/D${String(offset+n).padStart(4,'0')}`, 'directory')), limited: offset < 2450, ...(offset < 2450 ? {nextQuery:`server:/M/Allowed?offset=${offset+50}`} : {}) };
      }
      return { available: true, sourceChecked: true, results: q.endsWith('/D2499') ? [entry('server-g03/M/Allowed/D2499/target.pdf')] : [] };
    });
    let found = false;
    let result = await files.search([], 'name:target in:server:/M/Allowed');
    for (let i=0; i<100; i++) {
      if (JSON.stringify(result?.results).includes("target.pdf")) found=true;
      if (!result?.nextQuery) break;
      result=await files.search([], String(result.nextQuery));
    }
    expect(result).toMatchObject({limited:false,nextQuery:null,coverage:{complete:true}});
    expect(browsed.has('server:/M/Allowed/D2499')).toBe(true);
    expect(found).toBe(true);
    expect(sourceCapability).toHaveBeenCalledTimes(1);
  });
});
