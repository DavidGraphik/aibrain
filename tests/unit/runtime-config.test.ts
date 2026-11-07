import { afterEach, describe, expect, it, vi } from "vitest";
import { readRuntimeConfig } from "@/runtime/config";

afterEach(() => {
  vi.unstubAllEnvs();
});

function production() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("AIBRAIN_AUTH_MODE", "supabase");
  vi.stubEnv("AIBRAIN_ENABLE_PREVIEW_DEMO", "");
}

describe("runtime configuration", () => {
  it("fails closed when production does not explicitly select Codex", () => {
    production();
    vi.stubEnv("CHAT_RUNTIME", "");
    expect(() => readRuntimeConfig("example-company"))
      .toThrow("CHAT_RUNTIME=codex és obligatori en producció.");

    vi.stubEnv("CHAT_RUNTIME", "demo");
    expect(() => readRuntimeConfig("example-company"))
      .toThrow("CHAT_RUNTIME=codex és obligatori en producció.");
  });

  it("rejects unknown runtime names instead of treating them as demo", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CHAT_RUNTIME", "codxe");
    expect(() => readRuntimeConfig("example-company"))
      .toThrow("CHAT_RUNTIME ha de ser codex o demo.");
  });

  it("uses Codex in production when it is explicitly configured", () => {
    production();
    vi.stubEnv("CHAT_RUNTIME", "codex");
    expect(readRuntimeConfig("example-company").mode).toBe("codex");
  });

  it("allows demo only in development or an explicitly enabled Vercel preview", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CHAT_RUNTIME", "");
    expect(readRuntimeConfig("example-company").mode).toBe("demo");

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("AIBRAIN_AUTH_MODE", "demo");
    vi.stubEnv("AIBRAIN_ENABLE_PREVIEW_DEMO", "1");
    vi.stubEnv("CHAT_RUNTIME", "demo");
    expect(readRuntimeConfig("example-company").mode).toBe("demo");

    // Vercel may inherit CHAT_RUNTIME=codex from the deployment image. The
    // explicit Preview demo gate remains authoritative and never affects prod.
    vi.stubEnv("CHAT_RUNTIME", "codex");
    expect(readRuntimeConfig("example-company").mode).toBe("demo");
  });
});
