import { describe, expect, it } from "vitest";
import { isSettingsPatch } from "@/settings/contracts";

describe("settings patch contract", () => {
  it("accepts only administrative app changes and employee notifications", () => {
    expect(isSettingsPatch({ target: "installation-app", appId: "web-search", enabled: true })).toBe(true);
    expect(isSettingsPatch({ target: "notifications", values: { approvals: false, sound: true } })).toBe(true);
  });

  it("rejects unknown apps, fields and empty mutations", () => {
    expect(isSettingsPatch({ target: "installation-app", appId: "managed-browser", enabled: true })).toBe(false);
    expect(isSettingsPatch({ target: "user-app", appId: "web-search", enabled: true })).toBe(false);
    expect(isSettingsPatch({ target: "notifications", values: {} })).toBe(false);
    expect(isSettingsPatch({ target: "notifications", values: { browserPush: true } })).toBe(false);
    expect(isSettingsPatch({ target: "installation-app", appId: "web-search", enabled: true, userId: "other" })).toBe(false);
  });
});
