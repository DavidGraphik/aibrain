import { expect, it } from "vitest";
import { connectedAppConfig, hasAppliedConnectedAppConfig, markConnectedAppConfigApplied } from "./connected-app-config";

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
  expect(connectedAppConfig([])).toEqual({ apps: { _default: expect.objectContaining({ enabled: false }) } });
  expect(connectedAppConfig(["mail"]).apps).toEqual({
    _default: expect.objectContaining({ enabled: false }),
    mail: expect.objectContaining({ enabled: true, approvals_reviewer: "auto_review" }),
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
