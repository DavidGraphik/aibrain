import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "@/runtime/config";
import { buildWorkerEnvironment } from "@/runtime/worker-environment";

const config: RuntimeConfig = {
  tenantId: "qa",
  mode: "codex",
  codexBinary: "/usr/local/bin/codex",
  codexHome: "/var/lib/aibrain/users/user-a/codex-home",
  workspace: "/var/lib/aibrain/users/user-a/workspace",
  model: null,
  approvalPolicy: "on-request",
  sandbox: "workspace-write",
};

describe("buildWorkerEnvironment", () => {
  it("passes only runtime-safe process values and uses the private Codex home", () => {
    const environment = buildWorkerEnvironment(config, {
      NODE_ENV: "production",
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      SUPABASE_SECRET_KEY: "must-not-leak",
      AIBRAIN_SESSION_SECRET: "must-not-leak",
      OPENAI_API_KEY: "must-not-leak",
      RANDOM_TOKEN: "must-not-leak",
    });

    expect(environment).toMatchObject({
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      HOME: config.codexHome,
      CODEX_HOME: config.codexHome,
      XDG_CONFIG_HOME: path.join(config.codexHome!, ".config"),
    });
    expect(Object.keys(environment)).not.toEqual(
      expect.arrayContaining([
        "SUPABASE_SECRET_KEY",
        "AIBRAIN_SESSION_SECRET",
        "OPENAI_API_KEY",
        "RANDOM_TOKEN",
      ]),
    );
  });
});
