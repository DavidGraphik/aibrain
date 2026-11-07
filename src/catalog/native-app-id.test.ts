import { describe, expect, it } from "vitest";
import { CATALOG_ID, isCatalogCommand, isCatalogResource, isCatalogRule, isNativeAppId, type CatalogResource } from "./contracts";

const resource: CatalogResource = { id: "personal-mail", kind: "app", label: "Mail",
  credentialMode: "personal-oauth", managedBy: "company", sharedResource: false,
  appId: "connector_00000000000000000000000000000001", connectorId: null, mcp: null };

describe("native provider app identifiers", () => {
  it.each(["connector_00000000000000000000000000000001", "asdk_app_synthetic_123", "11111111-1111-4111-8111-111111111111", "native_mail", "gmail"])("preserves an exact provider key segment: %s", appId => {
    expect(isNativeAppId(appId)).toBe(true);
    expect(isCatalogResource({ ...resource, appId })).toBe(true);
    expect(isCatalogCommand({ action: "upsert-resource", resource: { ...resource, appId } })).toBe(true);
  });

  it.each(["_default", "", "connector_../foreign", "apps.connector_x.enabled", "connector_x.enabled", "connector_x:enabled", "connector_x/foreign", "connector_x\\foreign", "connector_x\n", "connector_x\u0000", "connector_x\u202e", "connector_x\"].enabled=true", "connector_x'", "connector_x[enabled]", "x".repeat(129)])("rejects reserved settings, paths and keypath injection: %s", appId => {
    expect(isNativeAppId(appId)).toBe(false);
    expect(isCatalogResource({ ...resource, appId })).toBe(false);
  });

  it("keeps internal resource/rule identifiers on their original slug contract", () => {
    const providerId = resource.appId!;
    expect(CATALOG_ID.test(providerId)).toBe(false);
    expect(isCatalogResource({ ...resource, id: providerId })).toBe(false);
    const rule = { id: "personal-mail-read", resourceId: resource.id, scope: "user", subjectId: "00000000-0000-4000-8000-000000000001", effect: "allow", operations: ["read"] };
    expect(isCatalogRule(rule)).toBe(true);
    expect(isCatalogRule({ ...rule, id: providerId })).toBe(false);
    expect(isCatalogRule({ ...rule, resourceId: providerId })).toBe(false);
    expect(isCatalogResource({ ...resource, appId: null, kind: "connector", connectorId: providerId })).toBe(false);
  });
});
