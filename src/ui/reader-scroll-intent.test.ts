import { describe, expect, it } from "vitest";
import { readerScrolledAway } from "./reader-scroll-intent";

describe("reader scroll intent", () => {
  const position = (scrollTop: number) => ({ scrollTop, scrollHeight: 1200, clientHeight: 600 });
  it("does not detach on an initial event or downward following after content growth", () => {
    expect(readerScrolledAway(position(396), {})).toBe(false);
    expect(readerScrolledAway(position(396), { lastScrollTop: 200 })).toBe(false);
    expect(readerScrolledAway(position(396), { lastScrollTop: 396 })).toBe(false);
  });
  it("ignores the follow hook's own scroll even when its target is clamped", () => {
    expect(readerScrolledAway(position(396), { lastScrollTop: 600, ignoreScrollToTop: 396 })).toBe(false);
  });
  it("detaches immediately for upward reader movement", () => {
    expect(readerScrolledAway(position(0), { lastScrollTop: 600 })).toBe(true);
  });
  it("handles reader movement coalesced with a pending programmatic scroll", () => {
    expect(readerScrolledAway(position(200), { lastScrollTop: 0, ignoreScrollToTop: 600 })).toBe(true);
  });
  it("keeps following small movements near the end", () => {
    expect(readerScrolledAway(position(550), { lastScrollTop: 600 })).toBe(false);
  });
});
