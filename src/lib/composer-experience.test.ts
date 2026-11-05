import { describe, expect, it } from "vitest";
import { isComposerExperience, normalizeComposerExperience } from "@/lib/composer-experience";

describe("composer experiences", () => {
  it("does not accept provider names as UI modes", () => {
    expect(isComposerExperience("smart")).toBe(true);
    expect(isComposerExperience("expert")).toBe(true);
    expect(isComposerExperience("fast")).toBe(false);
    expect(isComposerExperience("gpt-5.6-sol")).toBe(false);
  });
  it("normalizes old requests without accepting arbitrary modes", () => {
    expect(normalizeComposerExperience("fast")).toBe("smart");
    expect(normalizeComposerExperience("expert")).toBe("expert");
    expect(normalizeComposerExperience("gpt-6.1-sol")).toBeNull();
    expect(normalizeComposerExperience(undefined)).toBeNull();
  });
});
