import { expect, it } from "vitest";
import { connectedAppConfig, hasAppliedConnectedAppConfig, markConnectedAppConfigApplied, previousConnectedAppPolicies } from "./connected-app-config";

it("preserves native provider IDs as literal app keys with only enumerated read tools enabled", () => {
  const id = "connector_00000000000000000000000000000001";
  const config = connectedAppConfig([id], { [id]: { allowed: ["search"], known: ["search", "send"] } });
  expect(config.apps).toMatchObject({ [id]: { enabled: true, default_tools_enabled: false, destructive_enabled: false, open_world_enabled: false,
    tools: { search: { enabled: true, approval_mode: "writes" }, send: { enabled: false, approval_mode: "writes" } } } });
  expect(config.apps._default.enabled).toBe(false);
  expect(Object.keys(config.apps)).toEqual(["_default", id]);
});

it("refreshes loaded threads when connections change, disappear or the worker restarts", () => {
  const client = {};
  expect(hasAppliedConnectedAppConfig(client, "thread", [])).toBe(false);
  markConnectedAppConfigApplied(client, "thread", []);
  expect(hasAppliedConnectedAppConfig(client, "thread", [])).toBe(true);
  expect(hasAppliedConnectedAppConfig(client, "thread", ["mail"])).toBe(false);
  markConnectedAppConfigApplied(client, "thread", ["mail", "files"]);
  expect(hasAppliedConnectedAppConfig(client, "thread", ["files", "mail", "mail"])).toBe(true);
  expect(hasAppliedConnectedAppConfig(client, "thread", [])).toBe(false);
  expect(hasAppliedConnectedAppConfig({}, "thread", ["mail", "files"])).toBe(false);
  expect(hasAppliedConnectedAppConfig(client, "other-thread", ["mail", "files"])).toBe(false);
  expect(connectedAppConfig([])).toMatchObject({ "features.apps": false, apps: { _default: expect.objectContaining({ enabled: false }) } });
  expect(connectedAppConfig(["mail"]).apps).toEqual({
    _default: expect.objectContaining({ enabled: false }),
    mail: expect.objectContaining({ enabled: false, approvals_reviewer: "auto_review" }),
  });
});


it("uses a supported reviewer even for disabled defaults without enabling destructive or open-world apps", () => {
  for (const ids of [[], ["mail"], ["mail", "files", "mail"]]) {
    const config = connectedAppConfig(ids);
    expect(config.apps._default).toEqual({ enabled: false, approvals_reviewer: "auto_review",
      destructive_enabled: false, open_world_enabled: false, default_tools_approval_mode: "writes" });
    for (const app of Object.values(config.apps)) {
      expect(app.approvals_reviewer).toBe("auto_review");
      expect(app.destructive_enabled).toBe(false);
      expect(app.open_world_enabled).toBe(false);
    }
  }
});

it("bounds native app tools and refreshes loaded threads after tool or write policy changes", () => {
  const tools = { mail: { allowed: ["search"], known: ["search", "send"] } };
  const config = connectedAppConfig(["mail"], tools);
  expect(config["features.apps"]).toBe(true);
  expect(connectedAppConfig([], { mail: { allowed: [], known: ["search"] } })["features.apps"]).toBe(false);
  expect(connectedAppConfig(["mail"], tools)["features.apps"]).toBe(true);
  expect((config.apps as Record<string, unknown>).mail).toMatchObject({ default_tools_enabled: false, tools: { search: { enabled: true } } });
  const client = {};
  markConnectedAppConfigApplied(client, "thread", ["mail"], {}, tools);
  expect(hasAppliedConnectedAppConfig(client, "thread", ["mail"], {}, tools)).toBe(true);
  expect(hasAppliedConnectedAppConfig(client, "thread", ["mail"], {}, { mail: { allowed: ["search", "send"], known: ["search", "send"] } })).toBe(false);
  expect(hasAppliedConnectedAppConfig(client, "thread", ["mail"], { "mcp_servers.crm.enabled": false }, tools)).toBe(false);
});

it("overrides saved app and per-tool enables explicitly, including names with slashes", () => {
  const policies = {
    mail: { allowed: ["messages/read"], known: ["messages/read", "messages/send", "legacy/send"] },
    foreign: { allowed: [], known: ["files/read"] },
  };
  const config = connectedAppConfig(["mail"], policies);
  expect(config.apps).toMatchObject({
    mail: { enabled: true, default_tools_enabled: false, tools: {
      "messages/read": { enabled: true }, "messages/send": { enabled: false }, "legacy/send": { enabled: false },
    } },
    foreign: { enabled: false, default_tools_enabled: false, tools: { "files/read": { enabled: false } } },
  });
  const client = {};
  markConnectedAppConfigApplied(client, "thread", ["mail"], {}, policies);
  expect(hasAppliedConnectedAppConfig(client, "thread", ["mail"], {}, { ...policies,
    foreign: { allowed: [], known: ["files/read", "new/previously-enabled"] },
  })).toBe(false);
});

it("metadata loss or a revoked app never inherits a previous blanket tool enable", () => {
  expect(connectedAppConfig(["mail"])).toMatchObject({ "features.apps": false });
  expect(connectedAppConfig(["mail"]).apps).toMatchObject({ mail: { enabled: false, default_tools_enabled: false, tools: {} } });
  expect(connectedAppConfig([], { mail: { allowed: ["search"], known: ["search"] } }).apps)
    .toMatchObject({ mail: { enabled: false, tools: { search: { enabled: false } } } });
});

it("remembers thread-only negative knowledge without carrying grants to another thread or worker", () => {
  const client = {};
  markConnectedAppConfigApplied(client, "thread", ["qa-files"], {}, { "qa-files": { allowed: ["files/read"], known: ["files/read"] } });
  expect(previousConnectedAppPolicies(client, "thread")).toEqual({ "qa-files": { allowed: [], known: ["files/read"] } });
  markConnectedAppConfigApplied(client, "thread", [], {}, {});
  expect(previousConnectedAppPolicies(client, "thread")).toEqual({ "qa-files": { allowed: [], known: ["files/read"] } });
  expect(previousConnectedAppPolicies(client, "foreign-thread")).toEqual({});
  expect(previousConnectedAppPolicies({}, "thread")).toEqual({});
  expect(previousConnectedAppPolicies(client, null)).toEqual({});
  const copy = previousConnectedAppPolicies(client, "thread");
  copy["qa-files"].known = [];
  expect(previousConnectedAppPolicies(client, "thread")["qa-files"].known).toEqual(["files/read"]);
});
