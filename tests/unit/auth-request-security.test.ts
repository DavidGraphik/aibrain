import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSameOriginMutation } from "@/auth/request-security";

const installation = path.join(
  process.cwd(),
  "config/installations/development.example.json",
);

afterEach(() => vi.unstubAllEnvs());

describe("isSameOriginMutation", () => {
  it("uses InstallationConfig.publicUrl and rejects foreign origins", async () => {
    vi.stubEnv("AIBRAIN_INSTALLATION_CONFIG", installation);
    expect(await isSameOriginMutation(new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    }))).toBe(true);
    expect(await isSameOriginMutation(new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: { origin: "https://evil.example.test" },
    }))).toBe(false);
  });

  it("accepts browser same-origin metadata but fails closed for cross-site", async () => {
    vi.stubEnv("AIBRAIN_INSTALLATION_CONFIG", installation);
    expect(await isSameOriginMutation(new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    }))).toBe(true);
    expect(await isSameOriginMutation(new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    }))).toBe(false);
  });
});
