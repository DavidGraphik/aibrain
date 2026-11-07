import { describe, expect, it, vi } from "vitest";
import { COMPOSIO_NAMESPACE, composioToolsForTurn } from "./composio-dynamic-tools";

vi.mock("server-only", () => ({}));

describe("Composio tool catalogue admission", () => {
  it.each([undefined, [], ["native-app", "gmail"], ["composio-other"]])(
    "does not advertise configuration without an exact callable per-user connection (%j)",
    available => {
      expect(composioToolsForTurn([{ slug: "example_crm" }], available)).toEqual([]);
    },
  );

  it("keeps actual authorized providers and restricts both schemas to their available toolkits", () => {
    const configured = [{ slug: "example_crm" }, { slug: "example_mail" }, { slug: "example_crm" }];
    const before = structuredClone(configured);
    const specs = composioToolsForTurn(configured, ["composio-example-crm", "composio-not-configured"]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ type: "namespace", name: COMPOSIO_NAMESPACE });
    const namespace = specs[0];
    if (namespace.type !== "namespace") throw Error("Expected the Composio namespace");
    expect(namespace.tools.map(tool => tool.name)).toEqual(["list_tools", "read"]);
    for (const tool of namespace.tools) {
      expect(tool).toMatchObject({ inputSchema: { properties: { toolkit: { type: "string", enum: ["example_crm"] } } } });
    }
    expect(namespace.description).toContain("native tools directly");
    expect(configured).toEqual(before);
  });

  it("removes revoked connections on the next snapshot without retaining another user's inventory", () => {
    const configured = [{ slug: "example_crm" }, { slug: "example_mail" }];
    expect(composioToolsForTurn(configured, ["composio-example-crm"])).toHaveLength(1);
    expect(composioToolsForTurn(configured, [])).toEqual([]);
    expect(composioToolsForTurn(configured, ["composio-example-mail"])).toMatchObject([
      { tools: [{ inputSchema: { properties: { toolkit: { enum: ["example_mail"] } } } }, {}] },
    ]);
    expect(composioToolsForTurn(undefined, ["composio-example-crm"])).toEqual([]);
  });
});
