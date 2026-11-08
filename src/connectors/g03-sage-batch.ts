import { SageError, sageRecord, sageReadArguments, type SageReader } from './g03-sage-api';

type Page = Awaited<ReturnType<SageReader['read']>>;
type ReadPage = (query: unknown, parameters: unknown, skip: number, take: number, signal: AbortSignal) => Promise<Page>;
const MAX_PAGES = 6;
const MAX_BYTES = 160_000;
const MAX_MS = 20_000;

/** Bounded general query pagination. The continuation is an offset, not an access grant. */
export async function collectSagePages(read: ReadPage, query: unknown, parameters: unknown, skip: unknown, take: unknown, signal?: AbortSignal) {
  const request = sageReadArguments(query, parameters, skip, take);
  let offset = request.skip, nextOffset: number | null = offset, pages = 0, bytes = 0, limitReached = false;
  let last: Page | null = null, reason: string | null = null, previousPageBytes = 0;
  const items: unknown[] = [], pageMetadata: Array<{skip:number;take:number;nativeLineFields:unknown}> = [], started = Date.now();
  while (pages < MAX_PAGES && nextOffset !== null) {
    signal?.throwIfAborted();
    // Yield the exact continuation before fetching another page that is likely
    // to be discarded. The byte estimate is scheduling, never completeness.
    if (pages > 0 && bytes + previousPageBytes > MAX_BYTES) { reason = 'response_budget'; break; }
    const remaining = MAX_MS - (Date.now() - started);
    if (remaining <= 0) { reason = 'time_budget'; break; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    let page: Page, timedOut = false;
    const pageController = new AbortController();
    try {
      page = await Promise.race([read(query, parameters, offset, request.take, pageController.signal), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { timedOut = true; pageController.abort(); reject(new SageError('SAGE_BATCH_TIMEOUT')); }, remaining);
        abort = () => { pageController.abort(); reject(new SageError('SAGE_READ_CANCELLED')); };
        signal?.addEventListener('abort', abort, {once:true});
        if (signal?.aborted) abort();
      })]);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timedOut || error instanceof SageError && error.code === 'SAGE_BATCH_TIMEOUT') { reason = 'time_budget'; break; }
      if (pages > 0 && error instanceof SageError && ['SAGE_PROVIDER_UNAVAILABLE','SAGE_RESPONSE_TOO_LARGE','SAGE_AUTH_REQUIRED'].includes(error.code)) { reason = error.code; break; }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
    if (!Array.isArray(page.items) || !Number.isSafeInteger(page.take) || page.take < 1 || page.skip !== offset ||
      !(page.nextOffset === null || page.nextOffset === offset + page.take) || typeof page.complete !== 'boolean' || typeof page.limitReached !== 'boolean' ||
      page.complete !== (page.nextOffset === null && !page.limitReached)) throw new SageError('SAGE_PROVIDER_RESPONSE_INVALID');
    const pageBytes = Buffer.byteLength(JSON.stringify(page.items));
    if (bytes + pageBytes > MAX_BYTES) { reason = 'response_budget'; break; }
    items.push(...page.items); pageMetadata.push({skip:page.skip,take:page.take,nativeLineFields:sageRecord(page.nativeLineFields) ? page.nativeLineFields : null}); bytes += pageBytes; previousPageBytes = pageBytes; pages++; last = page;
    nextOffset = page.nextOffset; limitReached = page.limitReached;
    if (nextOffset !== null) offset = nextOffset;
  }
  const complete = last?.complete === true && nextOffset === null && !limitReached;
  return {source:'SAGE',sourceChecked:Boolean(last),companyCode:last?.companyCode ?? null,companyName:last?.companyName ?? null,query:request.queryName,parameters,items,fromOffset:request.skip,nextOffset,complete,limitReached,
    pages,reason:reason ?? (!complete && nextOffset !== null ? 'page_budget' : null),
    coverage:{snapshot:false,globalComplete:false,reachedEndOfQuery:complete,completeFromBeginning:complete && request.skip === 0,atMostPages:MAX_PAGES,maxBytes:MAX_BYTES,maxMilliseconds:MAX_MS,checkedAt:last?.checkedAt ?? null},
    pageMetadata,
    notice:'complete indica únicamente que se llegó al final de la consulta y parámetros indicados, desde fromOffset; no acredita cobertura global ni fechas fuera del intervalo. Si fromOffset es mayor que cero, también hacen falta las páginas anteriores. Sigue nextOffset con la misma consulta y parámetros. Si limitReached, subdivide el intervalo sin solapamientos. No es una captura instantánea; campos ausentes son desconocidos.'};
}
