import { describe, expect, it } from "vitest";
import type { CatalogResource } from "@/catalog/contracts";
import { connectorMentionDeveloperInstructions, projectConnectorMention } from "@/connectors/mentions-contract";

const gmail: CatalogResource = {
  id: "gmail", kind: "connector", label: "Gmail", credentialMode: "personal-oauth", managedBy: "company",
  sharedResource: false, appId: null, connectorId: "gmail", mcp: null,
};

describe("connector mentions", () => {
  it("projects OAuth state without exposing credentials and labels unavailable providers honestly", () => {
    expect(projectConnectorMention(gmail, new Map())).toMatchObject({ id: "gmail", status: "requires_login", canRead: false });
    expect(projectConnectorMention(gmail, new Map([["gmail", { status: "connected", statusCode: null }]]))).toMatchObject({ status: "connected", canRead: true });
    expect(projectConnectorMention(gmail, new Map([["gmail", { status: "not_configured", statusCode: "GMAIL_GOOGLE_CLOUD_NOT_CONFIGURED" }]]))).toMatchObject({ status: "admin_setup_required", canRead: false });
    expect(projectConnectorMention(gmail, new Map([["gmail", { status: "revoked", statusCode: "CONNECTOR_BINDING_REVOKED" }]]))).toMatchObject({ status: "unavailable", canRead: false });
  });

  it("creates a server-owned turn scope rather than relying on the visible @ label", () => {
    const instructions = connectorMentionDeveloperInstructions([{ resource: gmail, mention: projectConnectorMention(gmail, new Map()) }]);
    expect(instructions).toContain('"id":"gmail"');
    expect(instructions).toContain("solamente estas fuentes conectadas");
    expect(instructions).not.toContain("credentialRef");
  });

  it("leaves native app operations to Codex instead of declaring an empty adapter toolset", () => {
    const native: CatalogResource = { ...gmail, id: "native-mail", kind: "app", appId: "native_mail", connectorId: null };
    const instructions = connectorMentionDeveloperInstructions([
      { resource: native, mention: projectConnectorMention(native, new Map([[native.id, { status: "connected", statusCode: null }]])) },
      { resource: gmail, mention: projectConnectorMention(gmail, new Map()) },
    ]);
    const inventory = JSON.parse(instructions.split("BEGIN AIBRAIN CONNECTOR MENTIONS\n")[1].split("\nEND AIBRAIN CONNECTOR MENTIONS")[0]);
    expect(inventory[0]).toMatchObject({ id: "native-mail", kind: "app", label: "Gmail" });
    expect(inventory[0]).not.toHaveProperty("readTools");
    expect(inventory[0]).not.toHaveProperty("sensitiveWriteTools");
    expect(inventory[0]).not.toHaveProperty("toolNamespace");
    expect(inventory[1]).toMatchObject({ id: "gmail", readTools: [], sensitiveWriteTools: [] });
    expect(instructions).toContain("catálogo de herramientas del runtime");
    expect(instructions).toContain("servidor codex_apps con nombres que empiezan por mcp__codex_apps__");
    expect(instructions).not.toContain("native_mail");
  });
});

it('exposes Sage as pending without enabling execution', async () => {
  const { G03_SAGE_RESOURCE, G03_SAGE_HEALTH } = await import('./g03-catalog');
  expect(projectConnectorMention(G03_SAGE_RESOURCE, new Map([[G03_SAGE_RESOURCE.id, G03_SAGE_HEALTH]]))).toMatchObject({ status: 'admin_setup_required', canRead: false, statusCode: 'G03_SAGE_API_PENDING' });
});

it("keeps authorized Sage callable after a transient probe without labelling it connected",async()=>{
 const {G03_SAGE_RESOURCE}=await import("./g03-catalog");
 for(const statusCode of ["SAGE_HEALTH_PENDING","SAGE_PROVIDER_UNAVAILABLE"]){
  const mention=projectConnectorMention(G03_SAGE_RESOURCE,new Map([[G03_SAGE_RESOURCE.id,{status:"unavailable",statusCode,accessVerified:true}]]));
  expect(mention).toMatchObject({status:"unavailable",statusCode,canRead:true});
  const instructions=connectorMentionDeveloperInstructions([{resource:G03_SAGE_RESOURCE,mention}]);
  expect(instructions).toContain('"providerAvailability":"unavailable"');
  expect(instructions).toContain('A failed bounded health probe is not an access revocation.');
 }
});
it("does not convert unproved, revoked or foreign-provider availability into Sage permission",async()=>{
 const {G03_SAGE_RESOURCE}=await import("./g03-catalog");
 for(const health of [{status:"unavailable",statusCode:"SAGE_HEALTH_PENDING"},{status:"unavailable",statusCode:"SAGE_PROVIDER_UNAVAILABLE",accessVerified:false},{status:"not_configured",statusCode:"SAGE_ACCESS_DENIED",accessVerified:true}]){
  expect(projectConnectorMention(G03_SAGE_RESOURCE,new Map([[G03_SAGE_RESOURCE.id,health]]))).toMatchObject({canRead:false});
 }
 expect(projectConnectorMention(gmail,new Map([["gmail",{status:"unavailable",statusCode:"PROVIDER_TIMEOUT",accessVerified:true}]]))).toMatchObject({canRead:false});
});
