import { describe, expect, it } from "vitest";
import { hostAnalysisConfig, hostAnalysisToolAllowed } from "./host-analysis-policy";
describe("host analysis server-only capability ceiling", () => {
  it("allows only Production read and mutate in a support preview, irrespective of other policy flags", () => {
    const policy={businessReads:true,webSearch:true,supportPreview:{installationId:'g03-qa',userId:'u',sessionHash:'a'.repeat(64),supportActorEmail:'actor@example.test',supportExpiresAt:'2099-01-01',publicThreadId:'t',previewAppId:'p'}};
    for(const tool of ['read','mutate']) expect(hostAnalysisToolAllowed(policy,'aibrain_g03_production',tool)).toBe(true);
    for(const [namespace,tool] of [['aibrain_g03_production','receiving'],['aibrain_g03_apps','design_apply'],['aibrain_g03_sage','execute'],['aibrain_mail','send'],['aibrain_documents','inspect_attachment'],['aibrain_browser','open'],['trinalum_business','attio_search']])
      expect(hostAnalysisToolAllowed(policy,namespace,tool)).toBe(false);
    expect(hostAnalysisConfig(policy,['private_mcp'])).toMatchObject({web_search:'disabled','features.shell_tool':false,'features.apps':false,'features.browser_use':false,'features.multi_agent':false,'mcp_servers.private_mcp.enabled':false});
  });
  it("permits original attachment inspection and the exact business read allowlist only", () => {
    const policy = { webSearch: true, businessReads: true };
    expect(hostAnalysisToolAllowed(policy, "aibrain_documents", "inspect_attachment")).toBe(true);
    expect(hostAnalysisToolAllowed(policy, "trinalum_business", "attio_search")).toBe(true);
    expect(hostAnalysisToolAllowed(policy, "trinalum_business", "sibema_read")).toBe(true);
    for (const [namespace, tool] of [["trinalum_business", "mail_read"], ["trinalum_business", "mail_search"], ["trinalum_business", "attio_action"], ["trinalum_business", "sibema_action"], ["trinalum_business", "mail_draft"], ["aibrain_browser", "open"], ["aibrain_documents", "create"], ["aibrain_outlook", "search"], ["aibrain_gmail", "send"], ["aibrain_memory", "create"], ["aibrain_automations", "create"]]) expect(hostAnalysisToolAllowed(policy, namespace, tool)).toBe(false);
    expect(hostAnalysisToolAllowed({ ...policy, businessReads: false }, "trinalum_business", "attio_search")).toBe(false);
  });
  it("disables native commands, inherited apps/MCP and agents independently of prompts", () => {
    expect(hostAnalysisConfig({ webSearch: false, businessReads: false }, ["private_mcp", "gmail"])).toEqual({
      web_search: "disabled", "features.shell_tool": false, "features.apps": false,
      "features.browser_use": false, "features.multi_agent": false, apps: { _default: { enabled: false } },
      "mcp_servers.private_mcp.enabled": false, "mcp_servers.gmail.enabled": false,
    });
  });
  it("permits the actual ERP discovery call and fixed read/catalog commands without granting writes", () => {
    const policy = { businessReads: true, webSearch: true };
    for (const input of [
      { command: "discover" },
      { command: "discover", path: "/offers", method: "GET" },
      { command: "discover", query: {search:"customer offers orders",customer_id:781} },
      { command: "schema", path: "/offers/{id}", method: "GET" },
      { command: "read", path: "/offers/110" },
      { command: "read", method: "GET", path: "/customers", query: { search: "Synthetic customer", size: 10 } },
      { command: "catalog" },
      { command: "catalog", references: ["APYRAL 40CD", "NABALOX NO 713-10 RF"] },
    ]) expect(hostAnalysisToolAllowed(policy, "trinalum_business", "sibema_api", input)).toBe(true);
    expect(hostAnalysisToolAllowed({ ...policy, businessReads: false }, "trinalum_business", "sibema_api", { command: "catalog" })).toBe(false);
  });
  it("rejects unvalidated ERP commands, mutations, unexpected keys and native routes fail closed", () => {
    const policy = { businessReads: true, webSearch: true };
    for (const input of [undefined, null, [], {},
      { command: "execute" }, { command: "prepare" }, { command: "read", path: "/offers/110", method: "PUT" },
      { command: "schema", path: "/offers", method: "POST" }, { command: "discover", method: "DELETE" },
      { command: "catalog", method: "GET" }, { command: "catalog", references: Array(101).fill("A") },
      { command: "catalog", references: ["A%"] }, { command: "catalog", references: [2] },
      { command: "read", path: "/offers", body: {} }, { command: "read", path: "/offers", action: "delete" },
      { command: "read", path: "https://example.com/offers" }, { command: "read", path: "/offers?foo=bar" },
      { command: "read", path: "/../offers" }, { command: "read", path: "/offers", query: [] },
      { command: "discover", url: "/rest/product/create" }, { command: "schema" },
      { command: "discover", query: [] }, {command:"discover",body:{customer_id:781}},
    ]) expect(hostAnalysisToolAllowed(policy, "trinalum_business", "sibema_api", input)).toBe(false);
    expect(hostAnalysisToolAllowed(policy, "trinalum_business", "sibema_action", { type: "update_offer" })).toBe(false);
    expect(hostAnalysisToolAllowed(policy, "aibrain_browser", "open", { url: "https://example.com" })).toBe(false);
  });
});
