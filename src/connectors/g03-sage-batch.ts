import { SageError, sageRecord, sageReadArguments, type SageReader } from './g03-sage-api';

type Page = Awaited<ReturnType<SageReader['read']>>;
type ReadPage = (query: unknown, parameters: unknown, skip: number, take: number, signal: AbortSignal) => Promise<Page>;
const MAX_PAGES = 6;
// Six native pages are each limited to128KiB; the remaining256KiB covers batch metadata.
const MAX_BYTES = 1024 * 1024;
const MAX_MS = 20_000;

/** Bounded general query pagination. The continuation is an offset, not an access grant. */
export async function collectSagePages(read: ReadPage, query: unknown, parameters: unknown, skip: unknown, take: unknown, signal?: AbortSignal) {
  const request = sageReadArguments(query, parameters, skip, take);
  let effectiveTake = request.take;
  let offset = request.skip, nextOffset: number | null = offset, pages = 0, bytes = 0, limitReached = false;
  let last: Page | null = null, reason: string | null = null, previousPageBytes = 0;
  const items: unknown[] = [], pageMetadata: Array<{skip:number;take:number;nativeLineFields:unknown}> = [], started = Date.now();
  // The first page establishes the native take and warms the caller's reader.
  // Speculation consumes the same six-request budget, even when discarded.
  let attempts = 0;
  const launch = (pageOffset: number, pageTake: number) => {
    const controller = new AbortController();
    const promise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        const remaining = MAX_MS - (Date.now() - started);
        if (remaining <= 0) throw new SageError('SAGE_BATCH_TIMEOUT');
        const page = await Promise.race([read(query, parameters, pageOffset, pageTake, controller.signal), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { reject(new SageError('SAGE_BATCH_TIMEOUT')); controller.abort(); }, remaining);
          abort = () => { reject(new SageError('SAGE_READ_CANCELLED')); controller.abort(); };
          signal?.addEventListener('abort', abort, {once:true});
          controller.signal.addEventListener('abort', () => reject(new SageError('SAGE_READ_CANCELLED')), {once:true});
          if (signal?.aborted) abort();
        })]);
        return {ok:true as const, page};
      } catch (error) { return {ok:false as const, error}; }
      finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
    })();
    attempts++;
    return {offset:pageOffset, take:pageTake, controller, promise};
  };
  while (attempts < MAX_PAGES && nextOffset !== null && !reason) {
    signal?.throwIfAborted();
    if (Date.now() - started >= MAX_MS) { reason = 'time_budget'; break; }
    const wave: ReturnType<typeof launch>[] = [];
    const width = pages === 0 ? 1 : Math.min(2, MAX_PAGES - attempts);
    for (let index = 0; index < width; index++) {
      if (pages > 0 && bytes + previousPageBytes * (index + 1) > MAX_BYTES) break;
      const predicted = offset + index * effectiveTake;
      // Reuse the native offset guard; never speculate beyond its provider cap.
      try { sageReadArguments(query, parameters, predicted, effectiveTake); }
      catch (error) { if (index === 0) throw error; break; }
      wave.push(launch(predicted, effectiveTake));
    }
    if (!wave.length) { reason = 'response_budget'; break; }
    try {
      for (const pending of wave) {
        // A prior native take reduction invalidates the speculative offset.
        if (nextOffset === null || pending.offset !== offset) break;
        const result = await pending.promise;
        signal?.throwIfAborted();
        if (!result.ok) {
          const error = result.error;
          if (error instanceof SageError && error.code === 'SAGE_BATCH_TIMEOUT') { reason = 'time_budget'; break; }
          if (pages > 0 && error instanceof SageError && ['SAGE_PROVIDER_UNAVAILABLE','SAGE_RESPONSE_TOO_LARGE','SAGE_AUTH_REQUIRED'].includes(error.code)) { reason = error.code; break; }
          throw error;
        }
        const page = result.page;
        if (!Array.isArray(page.items) || !Number.isSafeInteger(page.take) || page.take < 1 || page.take > pending.take || page.skip !== offset ||
          !(page.nextOffset === null || page.nextOffset === offset + page.take) || typeof page.complete !== 'boolean' || typeof page.limitReached !== 'boolean' ||
          page.complete !== (page.nextOffset === null && !page.limitReached)) throw new SageError('SAGE_PROVIDER_RESPONSE_INVALID');
        const pageBytes = Buffer.byteLength(JSON.stringify(page.items));
        if (bytes + pageBytes > MAX_BYTES) { reason = 'response_budget'; break; }
        items.push(...page.items); pageMetadata.push({skip:page.skip,take:page.take,nativeLineFields:sageRecord(page.nativeLineFields) ? page.nativeLineFields : null});
        bytes += pageBytes; previousPageBytes = pageBytes; pages++; last = page;
        effectiveTake = page.take; nextOffset = page.nextOffset; limitReached = page.limitReached;
        if (nextOffset !== null) offset = nextOffset;
      }
    } finally {
      for (const pending of wave) pending.controller.abort();
      await Promise.all(wave.map(pending => pending.promise));
    }
  }
  const complete = last?.complete === true && nextOffset === null && !limitReached;
  return {source:'SAGE',sourceChecked:Boolean(last),companyCode:last?.companyCode ?? null,companyName:last?.companyName ?? null,query:request.queryName,parameters,items,fromOffset:request.skip,nextOffset,complete,limitReached,
    pages,reason:reason ?? (!complete && nextOffset !== null ? 'page_budget' : null),
    coverage:{snapshot:false,globalComplete:false,reachedEndOfQuery:complete,completeFromBeginning:complete && request.skip === 0,atMostPages:MAX_PAGES,maxPageRequests:MAX_PAGES,pageRequests:attempts,maxParallelPages:2,maxBytes:MAX_BYTES,maxMilliseconds:MAX_MS,checkedAt:last?.checkedAt ?? null},
    pageMetadata,
    notice:'complete indica únicamente que se llegó al final de la consulta y parámetros indicados, desde fromOffset; no acredita cobertura global ni fechas fuera del intervalo. Si fromOffset es mayor que cero, también hacen falta las páginas anteriores. Sigue nextOffset con la misma consulta y parámetros. Si limitReached, subdivide el intervalo sin solapamientos. No es una captura instantánea; campos ausentes son desconocidos.'};
}
