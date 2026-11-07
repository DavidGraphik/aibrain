type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Reuses one serialized, idempotent chat request for every transport reattach. */
export function createChatReattachRequest(body: string, fetcher: FetchLike = fetch) {
  return (signal: AbortSignal) => fetcher("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body,
  });
}
