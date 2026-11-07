import type { Order } from './contracts';

const CODE_PREFIX = 'client-code:';

/** A separately named selector is exact: an abbreviation must never include another client by substring. */
export function productionClientCodeQuery(query: string): string | null {
  return query.startsWith(CODE_PREFIX) && query.length > CODE_PREFIX.length ? query.slice(CODE_PREFIX.length) : null;
}

function letters(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Suggestions are deliberately not customer identity assertions. */
export function productionClientCodeCandidates(orders: readonly Pick<Order, 'client'>[], query: string) {
  if (!/^[\p{L}][\p{L}\s.'-]{2,59}$/u.test(query.trim())) return null;
  const name = letters(query);
  if (name.length < 3 || name.length > 60) return null;
  const counts = new Map<string, number>();
  for (const order of orders) {
    if (typeof order.client !== 'string' || !order.client || order.client.length > 60) continue;
    counts.set(order.client, (counts.get(order.client) ?? 0) + 1);
  }
  const possible = [...counts].filter(([code]) => {
    const initials = letters(code);
    if (initials.length < 2 || initials.length >= name.length || initials.length > 10 || initials[0] !== name[0]) return false;
    let position = 0;
    for (const letter of name) if (letter === initials[position]) position++;
    return position === initials.length;
  }).sort(([a], [b]) => a.localeCompare(b));
  if (!possible.length) return null;
  return { status: 'unverified_candidates' as const, evidence: 'letter_subsequence_only' as const,
    warning: 'Possible abbreviations only, not verified client identities. Do not claim equivalence or combine clients without an authoritative source or explicit user-provided mapping.',
    truncated: possible.length > 10,
    candidates: possible.slice(0, 10).map(([code, orderRows]) => ({ code, orderRows })) };
}
