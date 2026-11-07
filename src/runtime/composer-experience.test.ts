import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveServerComposerExperience } from "@/runtime/composer-experience";
import { normalizeComposerExperience } from "@/lib/composer-experience";
import { scheduledTurnOptions } from "@/automations/execution-context";

vi.mock("server-only", () => ({}));

describe("server composer experiences", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("enforces the installation model for every interactive experience", () => {
    vi.stubEnv("AIBRAIN_SERVER_MODEL", "gpt-6-luna");
    vi.stubEnv("AIBRAIN_SERVER_REASONING_EFFORT", "medium");
    for (const experience of ["smart", "expert"] as const) {
      expect(resolveServerComposerExperience(experience)).toEqual({ model: "gpt-6-luna", effort: "medium" });
    }
  });
  it("rejects incomplete installation policies", () => {
    vi.stubEnv("AIBRAIN_SERVER_MODEL", "gpt-6-luna");
    vi.stubEnv("AIBRAIN_SERVER_REASONING_EFFORT", "");
    expect(() => resolveServerComposerExperience("smart")).toThrow("Invalid installation model policy");
  });
  it("applies the same policy to scheduled turns", () => {
    vi.stubEnv("AIBRAIN_SERVER_MODEL", "gpt-6-luna");
    vi.stubEnv("AIBRAIN_SERVER_REASONING_EFFORT", "medium");
    expect(scheduledTurnOptions({ skillsAuthorized: true, connectorMentions: [] }))
      .toMatchObject({ model: "gpt-6-luna", effort: "medium", webSearch: true });
  });
  it("continues legacy fast requests as Inteligente", () => {
    const experience = normalizeComposerExperience("fast");
    expect(experience).toBe("smart");
    expect(resolveServerComposerExperience(experience!)).toEqual({ model: "gpt-6.1-terra", effort: "medium" });
  });
  it("maps product choices to private provider settings on the server", () => {
    expect(resolveServerComposerExperience("smart")).toEqual({ model: "gpt-6.1-terra", effort: "medium" });
    expect(resolveServerComposerExperience("expert")).toEqual({ model: "gpt-6.1-sol", effort: "medium" });
  });
});
