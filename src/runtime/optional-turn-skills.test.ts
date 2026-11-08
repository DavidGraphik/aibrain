import { describe, expect, it, vi } from "vitest";
import { AppServerRequestTimeoutError } from "./transport/app-server-rpc-router";
import { optionalTurnSkills } from "./optional-turn-skills";

describe("optional turn skills", () => {
  const timeout = () => new AppServerRequestTimeoutError("skills/list", "skills-fixture", 10_000);
  it("reconciles existing work without issuing optional inventory RPCs", async () => {
    const load = vi.fn(async () => { throw timeout(); });
    expect(await optionalTurnSkills({ explicit: false, inherit: true, recovering: true, load, unavailable: vi.fn() })).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });
  it("allows ordinary inherited-skill turns to continue with no skills after an inventory timeout", async () => {
    const unavailable = vi.fn();
    expect(await optionalTurnSkills({ explicit: false, inherit: true, recovering: false,
      load: async () => { throw timeout(); }, unavailable })).toEqual([]);
    expect(unavailable).toHaveBeenCalledOnce();
  });
  it("fails closed on explicit selections even during recovery", async () => {
    const unavailable = vi.fn();
    await expect(optionalTurnSkills({ explicit: true, inherit: true, recovering: true,
      load: async () => { throw timeout(); }, unavailable })).rejects.toBeInstanceOf(AppServerRequestTimeoutError);
    expect(unavailable).not.toHaveBeenCalled();
  });
  it("does not hide unrelated authorization or transport errors", async () => {
    await expect(optionalTurnSkills({ explicit: false, inherit: true, recovering: false,
      load: async () => { throw new Error("catalog denied"); }, unavailable: vi.fn() })).rejects.toThrow("catalog denied");
  });
});
