import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const scratchRoots: string[] = [];
import { afterEach, describe, expect, it, vi } from 'vitest';
const policy = vi.hoisted(() => ({ roots: ['server-g03/M/Allowed'] as string[] }));
vi.mock('./server-user-access', async importOriginal => ({ ...await importOriginal<typeof import('./server-user-access')>(), serverUserRoots: vi.fn(async () => policy.roots) }));
import { ServerDocumentFiles } from './server-files';
import { handleCompanyFilesDynamicToolCall } from '@/runtime/enterprise-documents/dynamic-tools';
const entry = (path: string, kind = 'file') => ({ scope: 'company', path, kind, size: 1 });
function fixture(reply: (query: string) => object, userId = 'qa-user-1') {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'g03-name-search-')); chmodSync(scratch, 0o700); scratchRoots.push(scratch);
  const network = { validateSyncRoots: vi.fn(async () => {}), search: vi.fn(async () => { throw Error('Scoped server paths must not reach local text search'); }), config: { installationId: 'g03-production', paths: { dataRoot: scratch } } };
  const files = new ServerDocumentFiles(network as never, { userId });
  vi.spyOn(files, 'navigation').mockResolvedValue({ available: true, results: [entry('server-g03/M/Allowed', 'directory')] });
  // Model a legacy descriptor's capability result separately from a source
  // request. The real descriptor/Unix-socket gate is covered by source-filename-search.
  const sourceCapability = vi.fn(async () => ({ available: false, error: 'FILENAME_SEARCH_UNSUPPORTED' }));
  const transport = vi.fn(async (_roots: unknown, operation: string, input: { query: string }) => {
    expect(['browse', 'inventory']).toContain(operation);
    return reply(input.query);
  });
  vi.spyOn(ServerDocumentFiles.prototype as unknown as { call(roots: unknown, operation: string, input: { query: string }): Promise<object | null> }, 'call')
    .mockImplementation(async (roots: unknown, operation: string, input: { query: string }) => operation === 'filename_search'
      ? sourceCapability() : transport(roots, operation, input));
  return { files, transport, sourceCapability, network };
}
afterEach(() => { for (const root of scratchRoots.splice(0)) rmSync(root, {recursive:true,force:true}); vi.restoreAllMocks(); policy.roots = ['server-g03/M/Allowed']; });
describe('G03 bounded live filename search', () => {
  it('walks authorized directories and pages, matches decoded names and reports coverage', async () => {
    const f = fixture(query => query.endsWith('?offset=50')
      ? { available: true, sourceChecked: true, results: [entry('server-g03/M/Allowed/PROGRAMA%20417.xls')] }
      : query === 'server:/M/Allowed/Sub'
        ? { available: true, sourceChecked: true, results: [entry('server-g03/M/Allowed/Sub/417.pdf')] }
        : { available: true, sourceChecked: true, results: [entry('server-g03/M/Allowed/Sub', 'directory'), entry('server-g03/M/Private/417.txt')], limited: true, nextQuery: 'server:/M/Allowed?offset=50' });
    expect(await f.files.search([], '417')).toMatchObject({ available: true, limited: false, results: [expect.objectContaining({ path: 'server-g03/M/Allowed/PROGRAMA%20417.xls' }), expect.objectContaining({ path: 'server-g03/M/Allowed/Sub/417.pdf' })], coverage: { pages: 3, complete: true } });
    expect(f.transport.mock.calls.every(args => (args[2] as {query: string}).query.startsWith('server:/M/Allowed'))).toBe(true);
    expect(f.sourceCapability).toHaveBeenCalledTimes(1);
  });
  it('keeps an advertised source failure without silently browsing the old tree', async () => {
    const f = fixture(() => { throw Error('Source failure must not fall back'); });
    f.sourceCapability.mockResolvedValue({ available: false, error: 'SEARCH_SOURCE_BUSY' });
    expect(await f.files.search([], 'name:417 in:server:/M/Allowed')).toMatchObject({ available: false, error: 'SEARCH_SOURCE_BUSY' });
    expect(f.transport).not.toHaveBeenCalled();
  });
  it('accepts a relay-encoded continuation for a scoped path containing spaces and accents', async () => {
    const base = 'server:/M/Allowed/PROGRAMAS%20CNC/M%C3%A0quina';
    const f = fixture(query => query.endsWith('?offset=50')
      ? { available: true, sourceChecked: true, results: [entry('server-g03/M/Allowed/PROGRAMAS%20CNC/M%C3%A0quina/417', 'file')] }
      : { available: true, sourceChecked: true, results: [], limited: true, nextQuery: base + '?offset=50' });
    expect(await f.files.search([], 'name:417 in:server:/M/Allowed/PROGRAMAS CNC/Màquina')).toMatchObject({ available: true, limited: false, results: [expect.objectContaining({ path: 'server-g03/M/Allowed/PROGRAMAS%20CNC/M%C3%A0quina/417' })], coverage: { pages: 2, complete: true } });
    expect(f.transport.mock.calls.map(args => (args[2] as {query: string}).query)).toEqual([base, base + '?offset=50']);
  });
  it.each([
    'server:/M/Private?offset=50',
    'server:/M/Allowed/Other?offset=50',
    'server:/M/Allowed?offset=bad',
    'server:/M/Allowed?offset=50&path=Private',
    'server:/M/Allowed?offset=0',
    'server:/M/Allowed?offset=100',
    'server:/M/Allowed/%2E%2E/Private?offset=50',
    'server:/M/Allowed%2FPrivate?offset=50',
  ])('does not follow a changed, malformed or nonsequential continuation %s', async nextQuery => {
    const f = fixture(() => ({ available: true, sourceChecked: true, results: [], limited: true, nextQuery }));
    expect(await f.files.search([], '417')).toMatchObject({ available: true, results: [], limited: true, coverage: { pages: 1, complete: false } });
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it('routes the actual scoped runtime request before local text validation and finds page nine', async () => {
    const base = 'server:/M/Allowed/PROGRAMAS%20CNC/MORI%20SEIKI%20DURA%20VERTICAL%205100';
    const f = fixture(query => {
      const offset = Number(query.split('offset=')[1] ?? 0);
      return { available: true, sourceChecked: true, results: offset === 400 ? [entry('server-g03/M/Allowed/PROGRAMAS%20CNC/MORI%20SEIKI%20DURA%20VERTICAL%205100/417')] : [], limited: offset < 400, nextQuery: offset < 400 ? base + '?offset=' + (offset + 50) : null };
    });
    const result = await handleCompanyFilesDynamicToolCall({ namespace: 'aibrain_company_files', tool: 'search', threadId: 'thread', turnId: 'turn', callId: 'call', arguments: { query: 'name:417 in:server:/M/Allowed/PROGRAMAS CNC/MORI SEIKI DURA VERTICAL 5100', limit: 100 } } as never,
      { network: f.network, roots: [], serverFiles: f.files, runtimeThreadId: 'thread', runtimeTurnId: 'turn' } as never);
    expect(result.success).toBe(true);
    const payload = JSON.parse((result.contentItems[0] as {text:string}).text);
    expect(payload.server).toMatchObject({ available: true, limited: false, coverage: { pages: 9, complete: true } });
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].path).toContain('/417');
    expect(f.network.search).not.toHaveBeenCalled();
    expect(f.transport.mock.calls).toHaveLength(9);
    expect(f.transport.mock.calls.every(args => (args[2] as {query:string;limit:number}).limit === 50)).toBe(true);
  });
  it('retains a timed-out page as an explicit bounded continuation', async () => {
    const f = fixture(() => ({ available: false }));
    expect(await f.files.search([], 'name:417 in:server:/M/Allowed')).toMatchObject({ available: false, sourceChecked: false,
      error: 'SEARCH_SOURCE_OFFLINE', limited: true, nextQuery: expect.stringMatching(/^name-cursor:/),
      coverage: { pages: 0, pendingCount: 1, pendingQueries: [], complete: false } });
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it('resumes only the validated pending page and discloses excluded earlier pages', async () => {
    const f = fixture(() => ({ available: true, sourceChecked: true, results: [entry('server-g03/M/Allowed/417')] }));
    expect(await f.files.search([], 'name:417 in:server:/M/Allowed?offset=400')).toMatchObject({ available: true, limited: true, nextQuery: null, coverage: { pages: 1, priorPagesExcluded: true, remainingInScopeComplete: true, complete: false } });
    expect((f.transport.mock.calls[0][2] as {query: string}).query).toBe('server:/M/Allowed?offset=400');
    expect(f.sourceCapability).not.toHaveBeenCalled();
  });
  it('caps traversal and gives explicit partial coverage instead of false absence', async () => {
    const f = fixture(query => ({ available: true, sourceChecked: true, results: [entry(query.split('?')[0].replace('server:/', 'server-g03/') + '/Sub', 'directory')], limited: true, nextQuery: query.split('?')[0] + '?offset=' + (Number(query.split('offset=')[1] ?? 0) + 50) }));
    expect(await f.files.search([], 'missing')).toMatchObject({ available: true, results: [], limited: true, coverage: { pages: 40, complete: false } });
    expect(f.transport).toHaveBeenCalledTimes(40);
  });
  it('rejects ungranted scope and suppresses collected metadata after revocation', async () => {
    const f = fixture(() => { policy.roots = []; return { available: true, sourceChecked: true, results: [entry('server-g03/M/Allowed/417.xls')] }; });
    expect(await f.files.search([], 'name:417 in:server:/M/Private')).toMatchObject({ available: false, results: [] });
    expect(f.transport).not.toHaveBeenCalled();
    expect(await f.files.search([], '417')).toMatchObject({ available: false });
  });
  it('finishes a 31-directory synthetic tree in one tool call without parallel relay requests', async () => {
    let active = 0, maximumActive = 0;
    const f = fixture(async query => {
      maximumActive = Math.max(maximumActive, ++active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return { available: true, sourceChecked: true, results: query === 'server:/M/Allowed'
        ? Array.from({ length: 30 }, (_, n) => entry(`server-g03/M/Allowed/D${n}`, 'directory'))
        : query.endsWith('/D27') ? [entry('server-g03/M/Allowed/D27/5127134.pdf')] : [] };
    });
    const result = await f.files.search([], 'name:5127134 in:server:/M/Allowed');
    expect(result).toMatchObject({ limited: false, nextQuery: null, coverage: { complete: true, pages: 31, maxPages: 40, maxMilliseconds: 25000 },
      results: [expect.objectContaining({ path: 'server-g03/M/Allowed/D27/5127134.pdf' })] });
    expect(maximumActive).toBe(1);
    expect(f.transport).toHaveBeenCalledTimes(31);
  });
  it('finds an authorized file below eight nested directories without falsely claiming complete coverage', async () => {
    const base = 'server:/M/Allowed';
    const f = fixture(query => {
      const depth = query.slice(base.length).split('/').filter(Boolean).length;
      const parent = query.replace('server:/', 'server-g03/');
      return { available: true, sourceChecked: true, results: depth < 12
        ? [entry(`${parent}/D${depth}`, 'directory')]
        : [entry(`${parent}/5127134.pdf`)] };
    });
    const result = await f.files.search([], 'name:5127134 in:server:/M/Allowed');
    expect(result).toMatchObject({ limited: false, coverage: { complete: true, pages: 13, maxDepth: null },
      results: [expect.objectContaining({ path: expect.stringContaining('D11/5127134.pdf') })] });
    expect(f.transport).toHaveBeenCalledTimes(13);
  });
  it('continues every pending sibling after the bounded per-call budget', async () => {
    const base = 'server:/M/Allowed';
    const dirs = Array.from({ length: 50 }, (_, n) => `Dir${String(n).padStart(2, '0')}`);
    const f = fixture(query => ({ available: true, sourceChecked: true,
      results: query === base ? dirs.map(name => entry(`server-g03/M/Allowed/${name}`, 'directory'))
        : query.endsWith('/Dir47') ? [entry('server-g03/M/Allowed/Dir47/5127134.pdf')] : [] }));
    const first = await f.files.search([], 'name:5127134 in:server:/M/Allowed', 1);
    expect(first).toMatchObject({ limited: true, nextQuery: expect.stringMatching(/^name-cursor:/), coverage: { pages: 40, pendingCount: 11 } });
    const second = await f.files.search([], String(first?.nextQuery), 1);
    expect(second).toMatchObject({ limited: true, results: [expect.objectContaining({ path: 'server-g03/M/Allowed/Dir47/5127134.pdf' })] });
    const third = await f.files.search([], String(second?.nextQuery), 1);
    expect(third).toMatchObject({ limited: false, coverage: { complete: true }, results: [] });
    expect(f.transport).toHaveBeenCalledTimes(51);
  });
  it('buffers all matches in a directory, supports safe replay and binds cursor to user and roots', async () => {
    const f = fixture(() => ({ available: true, sourceChecked: true, results: [
      entry('server-g03/M/Allowed/417-A'), entry('server-g03/M/Allowed/417-B'), entry('server-g03/M/Allowed/417-C'),
    ] }));
    const first = await f.files.search([], 'name:417 in:server:/M/Allowed', 1);
    expect(first).toMatchObject({ results: [expect.objectContaining({ path: 'server-g03/M/Allowed/417-A' })], limited: true, coverage: { bufferedMatches: 2 } });
    const cursor = String(first?.nextQuery);
    const second = await f.files.search([], cursor, 1);
    expect(second).toMatchObject({ results: [expect.objectContaining({ path: 'server-g03/M/Allowed/417-B' })], limited: true });
    expect(await f.files.search([], cursor, 1)).toMatchObject({ results: second?.results, nextQuery: second?.nextQuery });
    expect(f.transport).toHaveBeenCalledTimes(3);
    expect(f.sourceCapability).toHaveBeenCalledTimes(1);
    const other = new ServerDocumentFiles(f.network as never, { userId: 'qa-user-2' });
    vi.spyOn(other, 'navigation').mockResolvedValue({ available: true, results: [entry('server-g03/M/Allowed', 'directory')] });
    expect(await other.search([], String(second?.nextQuery), 1)).toMatchObject({ available: false, error: 'SEARCH_CURSOR_EXPIRED_OR_DENIED' });
    const third = await f.files.search([], String(second?.nextQuery), 1);
    expect(third).toMatchObject({ results: [expect.objectContaining({ path: 'server-g03/M/Allowed/417-C' })], limited: false, coverage: { complete: true } });
    policy.roots = [];
    expect(await f.files.search([], cursor, 1)).toMatchObject({ available: false, error: 'SEARCH_CURSOR_EXPIRED_OR_DENIED' });
  });
  it('withholds buffered filenames when Windows no longer returns them', async () => {
    let access=true;
    const f=fixture(() => ({available:true,sourceChecked:true,results:access ? [entry('server-g03/M/Allowed/417-public'),entry('server-g03/M/Allowed/417-PRIVATE-REVOKED')] : []}));
    const first=await f.files.search([], 'name:417 in:server:/M/Allowed',1);
    access=false;
    const next=await f.files.search([],String(first?.nextQuery),1);
    expect(JSON.stringify(next)).not.toContain('PRIVATE-REVOKED');
    expect(next).toMatchObject({available:false,limited:true,error:'SEARCH_SOURCE_RECHECK'});
  });
  it('resumes an issued legacy cursor without renegotiating a newly available source capability', async () => {
    const f = fixture(() => ({ available: true, sourceChecked: true, results: [
      entry('server-g03/M/Allowed/417-A'), entry('server-g03/M/Allowed/417-B'),
    ] }));
    const first = await f.files.search([], 'name:417 in:server:/M/Allowed', 1);
    f.sourceCapability.mockImplementation(async () => { throw Error('An issued cursor must keep its original backend'); });
    const resumed = await f.files.search([], String(first?.nextQuery), 1);
    expect(resumed).toMatchObject({ results: [expect.objectContaining({ path: 'server-g03/M/Allowed/417-B' })],
      limited: false, coverage: { complete: true } });
    expect(f.sourceCapability).toHaveBeenCalledTimes(1);
  });
  it('withholds replayed filenames after Windows access is revoked', async () => {
    let access=true;
    const f=fixture(() => ({available:true,sourceChecked:true,results:access ? [entry('server-g03/M/Allowed/417-public'),entry('server-g03/M/Allowed/417-PRIVATE-REVOKED')] : []}));
    const first=await f.files.search([], 'name:417 in:server:/M/Allowed',1);
    const cursor=String(first?.nextQuery);
    const second=await f.files.search([],cursor,1);
    expect(JSON.stringify(second)).toContain('PRIVATE-REVOKED');
    access=false;
    const replay=await f.files.search([],cursor,1);
    expect(JSON.stringify(replay)).not.toContain('PRIVATE-REVOKED');
    expect(replay).toMatchObject({available:false,limited:true,error:'SEARCH_SOURCE_RECHECK'});
  });
  it('does not expose previously observed folder names in progress metadata', async () => {
    const f=fixture(query => query === 'server:/M/Allowed' ? {available:true,sourceChecked:true,
      results:Array.from({length:50},(_,i)=>entry(`server-g03/M/Allowed/PRIVATE-FOLDER-${i}`,'directory'))} : {available:false,error:'WINDOWS_PATH_UNAVAILABLE'});
    const result=await f.files.search([], 'name:target in:server:/M/Allowed');
    expect(result).toMatchObject({limited:true,coverage:{pendingQueries:[],directories:[]}});
    expect(JSON.stringify(result)).not.toContain('PRIVATE-FOLDER');
  });
  it('keeps the entire page and drains other branches if cursor quota is reached', async () => {
    const realLength = Buffer.byteLength.bind(Buffer);
    const length = vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) =>
      typeof value === 'string' && value.includes('/OVERFLOW_TEST') ? 3 * 1024 * 1024 : realLength(value, encoding));
    const f = fixture(query => ({available:true,sourceChecked:true,results:
      query === 'server:/M/Allowed' ? [entry('server-g03/M/Allowed/A','directory'),entry('server-g03/M/Allowed/B','directory')] :
      query === 'server:/M/Allowed/A' ? [entry('server-g03/M/Allowed/A/OVERFLOW_TEST','directory')] :
      query.endsWith('/OVERFLOW_TEST') ? [entry('server-g03/M/Allowed/A/OVERFLOW_TEST/417.pdf')] : []}));
    const first=await f.files.search([], 'name:417 in:server:/M/Allowed');
    expect(first).toMatchObject({limited:true,error:'SEARCH_QUOTA_PAUSED',nextQuery:expect.stringMatching(/^name-cursor:/),
      coverage:{pendingQueries:[],pendingCount:2}});
    length.mockRestore();
    const next=await f.files.search([],String(first?.nextQuery));
    expect(next).toMatchObject({limited:false,coverage:{complete:true},results:[expect.objectContaining({path:'server-g03/M/Allowed/A/OVERFLOW_TEST/417.pdf'})]});
  });
  it('keeps a temporarily unavailable branch for later retry instead of losing it', async () => {
    let calls = 0;
    const f = fixture(() => ++calls === 1 ? { available: false, error: 'WINDOWS_PATH_UNAVAILABLE' } :
      { available: true, sourceChecked: true, results: [entry('server-g03/M/Allowed/417')] });
    const first = await f.files.search([], 'name:417 in:server:/M/Allowed');
    expect(first).toMatchObject({limited:true,nextQuery:expect.stringMatching(/^name-cursor:/)});
    const later = await f.files.search([], String(first?.nextQuery));
    expect(later).toMatchObject({limited:false,coverage:{complete:true},results:[expect.objectContaining({path:'server-g03/M/Allowed/417'})]});
  });
  it('continues a temporary timeout without falsely marking recovered traversal incomplete', async () => {
    let calls = 0;
    const f = fixture(() => ++calls === 1 ? { available: false } : { available: true, sourceChecked: true, results: [entry('server-g03/M/Allowed/417')] });
    const first = await f.files.search([], 'name:417 in:server:/M/Allowed');
    const second = await f.files.search([], String(first?.nextQuery));
    expect(second).toMatchObject({ available: true, limited: false, coverage: { complete: true }, results: [expect.objectContaining({ path: 'server-g03/M/Allowed/417' })] });
  });
  it('routes an opaque continuation through the actual runtime tool without local text search', async () => {
    const f = fixture(query => ({ available: true, sourceChecked: true, results: query === 'server:/M/Allowed'
      ? Array.from({ length: 45 }, (_, n) => entry(`server-g03/M/Allowed/D${n}`, 'directory')) : [] }));
    const first = await f.files.search([], 'name:no-hit in:server:/M/Allowed');
    const laterTurn = new ServerDocumentFiles(f.network as never, { userId: 'qa-user-1' });
    vi.spyOn(laterTurn, 'navigation').mockResolvedValue({ available: true, results: [entry('server-g03/M/Allowed', 'directory')] });
    const result = await handleCompanyFilesDynamicToolCall({ namespace: 'aibrain_company_files', tool: 'search', threadId: 'thread', turnId: 'later-turn', callId: 'call', arguments: { query: first?.nextQuery } } as never,
      { network: f.network, roots: [], serverFiles: laterTurn, runtimeThreadId: 'thread', runtimeTurnId: 'later-turn' } as never);
    expect(result.success).toBe(true);
    expect(JSON.parse((result.contentItems[0] as {text:string}).text).server).toMatchObject({ available: true, limited: false, coverage: { complete: true } });
    expect(f.network.search).not.toHaveBeenCalled();
  });
  it('reports a stale or forged cursor without pretending that the search is complete', async () => {
    const f = fixture(() => { throw Error('Expired cursor must not browse'); });
    expect(await f.files.search([], 'name-cursor:00000000-0000-4000-8000-000000000000')).toMatchObject({
      available: false, limited: true, error: 'SEARCH_CURSOR_EXPIRED_OR_DENIED',
    });
    expect(f.transport).not.toHaveBeenCalled();
  });
  it('expires a real cursor after ten minutes without browsing again', async () => {
    const initialTime = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(initialTime);
    const f = fixture(() => ({ available: false }));
    const first = await f.files.search([], 'name:417 in:server:/M/Allowed');
    now.mockReturnValue(initialTime + 600_001);
    expect(await f.files.search([], String(first?.nextQuery))).toMatchObject({ available: false, error: 'SEARCH_CURSOR_EXPIRED_OR_DENIED' });
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it('keeps every branch in searches requiring more than sixteen continuations', async () => {
    const f = fixture(query => {
      const depth = query.split('/').length - 3;
      const count = depth === 0 ? 49 : depth === 1 ? 15 : 0;
      return { available: true, sourceChecked: true, results: Array.from({ length: count }, (_, n) => entry(`${query.replace('server:/', 'server-g03/')}/D${n}`, 'directory')) };
    });
    let result = await f.files.search([], 'name:missing in:server:/M/Allowed');
    let continuations = 0;
    while (result?.nextQuery && continuations < 30) {
      result = await f.files.search([], String(result.nextQuery));
      continuations++;
    }
    expect(continuations).toBeGreaterThan(16);
    expect(f.transport).toHaveBeenCalledTimes(785);
    expect(result).toMatchObject({ limited: false, coverage: { complete: true } });
  });
  it('rejects a sibling outside the requested subtree even if the user can access it', async () => {
    const f = fixture(() => ({ available: true, sourceChecked: true, results: [entry('server-g03/M/Allowed/Other/417.pdf')] }));
    expect(await f.files.search([], 'name:417 in:server:/M/Allowed/Sub')).toMatchObject({
      results: [], limited: true, nextQuery: null, coverage: { complete: false, snapshot: false },
    });
  });
  it('explains the G03 inventory rejection without treating it as an empty folder', async () => {
    const f = fixture(() => ({ available: false, error: 'SERVER_REQUEST_DENIED' }));
    expect(await f.files.inventory([], { scope: 'company', path: 'server-g03/M/Allowed' })).toMatchObject({
      available: false, error: 'SERVER_REQUEST_DENIED', warning: expect.stringContaining('no implementa inventario recursivo'),
    });
  });
});
