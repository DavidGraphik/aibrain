import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { codexManagedAppPreflightDependencies } from "@/connectors/preflight-server";

describe("codex managed app preflight server boundary", () => {
  it("loads the server-only application entrypoint only through the explicit test mock", () => {
    expect(codexManagedAppPreflightDependencies).toBeTypeOf("function");
  });
});
