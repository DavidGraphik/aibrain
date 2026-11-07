import { describe, expect, it } from "vitest";
import { parseAccount } from "./codex-app-server";

describe("Codex account readiness", () => {
  it("recognizes a worker API-key account without inventing entitlements", () => {
    expect(parseAccount({ account: { type: "apiKey" }, requiresOpenaiAuth: true }))
      .toMatchObject({ connected: true, authMode: "apiKey", planType: null,
        models: [], webSearch: false, imageGeneration: false, rateLimit: null });
  });
  it("keeps missing, unknown and unsupported accounts disconnected", () => {
    for (const result of [null, {}, { account: null }, { account: {} },
      { account: { type: "unknown" } }, { account: { type: "amazonBedrock" } }]) {
      expect(parseAccount(result).connected).toBe(false);
    }
  });
  it("preserves existing ChatGPT account behavior", () => {
    expect(parseAccount({ account: { type: "chatgpt", planType: "team" } }))
      .toMatchObject({ connected: true, authMode: "chatgpt", planType: "team" });
  });
  it("identifies sign-in only from an explicit missing provider account", () => {
    expect(parseAccount({ account: null, requiresOpenaiAuth: true }))
      .toMatchObject({ connected: false, authenticationRequired: true });
    for (const value of [null, {}, { account: null }, { account: null, requiresOpenaiAuth: false },
      { account: null, requiresOpenaiAuth: "true" }, { account: { type: "unknown" }, requiresOpenaiAuth: true }]) {
      expect(parseAccount(value).authenticationRequired).not.toBe(true);
    }
    expect(parseAccount({ account: { type: "chatgpt" }, requiresOpenaiAuth: true }).authenticationRequired).not.toBe(true);
  });
});
