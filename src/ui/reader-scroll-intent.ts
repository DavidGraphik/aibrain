/** Called in scroll capture, before the follow hook consumes its scroll marker. */
export function readerScrolledAway(
  element: { scrollTop: number; scrollHeight: number; clientHeight: number },
  follow: { lastScrollTop?: number; ignoreScrollToTop?: number },
): boolean {
  if (element.scrollTop === follow.ignoreScrollToTop) return false;
  const previousTop = Math.max(
    follow.lastScrollTop ?? element.scrollTop,
    follow.ignoreScrollToTop ?? element.scrollTop,
  );
  return element.scrollTop < previousTop
    && element.scrollHeight - element.scrollTop - element.clientHeight >= 96;
}
