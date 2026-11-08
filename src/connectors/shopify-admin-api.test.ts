import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { ShopifyAdminClient, SHOPIFY_ADMIN_SCOPES, SHOPIFY_ADMIN_FILE_REQUEST_MAX_BYTES, hasRequiredShopifyAdminScopes } from "./shopify-admin-api";
import { SHOPIFY_SHOP } from "./shopify-contracts";
const identity = (scopes: readonly string[] = SHOPIFY_ADMIN_SCOPES, shop = SHOPIFY_SHOP) => ({ shop: { myshopifyDomain: shop }, currentAppInstallation: { accessScopes: scopes.map(handle => ({ handle })) } });
const query = "query Products($first:Int!){products(first:$first){nodes{id title}}}";
const mutation = "mutation Prices($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$productId,variants:$variants){productVariants{id price} userErrors{field message code}}}";

it("requires actual product/theme/file write grants, accepts Shopify implicit read grants", () => {
  expect(hasRequiredShopifyAdminScopes(["write_products", "write_themes", "write_files"])).toBe(true);
  expect(hasRequiredShopifyAdminScopes(SHOPIFY_ADMIN_SCOPES)).toBe(true);
  expect(hasRequiredShopifyAdminScopes(["read_products", "read_themes", "read_files"])).toBe(false);
  expect(hasRequiredShopifyAdminScopes(["write_products", "write_themes"])).toBe(false);
  expect(hasRequiredShopifyAdminScopes([...SHOPIFY_ADMIN_SCOPES, "write_products"])).toBe(false);
  expect(SHOPIFY_ADMIN_SCOPES).not.toContain("write_orders");
});
it("checks live tenant and grants before every operation and blocks writes on mismatch", async () => {
  for (const data of [identity(SHOPIFY_ADMIN_SCOPES, "other.myshopify.com"), identity(["read_products"])]) {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data }));
    await expect(new ShopifyAdminClient("test-token", fetcher).execute({ query: mutation })).rejects.toThrow(/ADMIN_(STORE_MISMATCH|SCOPES_REQUIRED)/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string).query).not.toContain("mutation");
  }
});
it("executes general queries and product variant mutations with variables at the fixed store", async () => {
  const requests: { query: string; variables?: unknown; operationName?: string }[] = [];
  const client = new ShopifyAdminClient("private-token", async (url, options) => {
    expect(String(url)).toBe(`https://${SHOPIFY_SHOP}/admin/api/2026-07/graphql.json`);
    expect(options?.redirect).toBe("error"); expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect((options?.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe("private-token");
    const body = JSON.parse(options?.body as string); requests.push(body);
    return Response.json({ data: body.query.includes("currentAppInstallation") ? identity() : body.query.startsWith("mutation") ? { productVariantsBulkUpdate: { productVariants: [{ id: "gid://shopify/ProductVariant/1", price: "99.00" }], userErrors: [] } } : { products: { nodes: [{ id: "gid://shopify/Product/1", title: "Watch" }] } } });
  });
  await expect(client.execute({ query, variables: { first: 1 } })).resolves.toMatchObject({ operationType: "query", readbackRequired: false, data: { products: { nodes: [{ title: "Watch" }] } } });
  const variables = { productId: "gid://shopify/Product/1", variants: [{ id: "gid://shopify/ProductVariant/1", price: "99.00" }] };
  await expect(client.execute({ query: mutation, variables, operationName: "Prices" })).resolves.toMatchObject({ operationType: "mutation", readbackRequired: true });
  expect(requests).toHaveLength(4); expect(requests[3]).toEqual({ query: mutation, variables, operationName: "Prices" });
});
it("does not treat GraphQL or mutation userErrors as success, preserves useful sanitized errors", async () => {
  for (const result of [
    { errors: [{ message: "Denied private-token access_token=other-secret", extensions: { code: "ACCESS_DENIED" } }] },
    { data: { productVariantsBulkUpdate: { userErrors: [{ field: ["variants", "0", "price"], message: "Invalid price private-token", code: "INVALID" }] } } },
    { data: { productVariantsBulkUpdate: { issues: [{ field: ["price"], message: "Invalid price" }] } } },
  ]) {
    const client = new ShopifyAdminClient("private-token", async (_url, options) => Response.json(JSON.parse(options?.body as string).query.includes("currentAppInstallation") ? { data: identity() } : result));
    const request = { query: mutation.replace("userErrors{", "issues:userErrors{") };
    // The unaliased response is also rejected even if the requested field was aliased.
    const error: unknown = await client.execute(request).catch(e => e);
    expect(error).toBeInstanceOf(Error); if (!(error instanceof Error)) throw Error("Expected provider rejection");
    expect(error.message).toMatch(/ADMIN_(GRAPHQL|USER)_ERRORS/);
    expect(error.message).not.toMatch(/private-token|other-secret/);
    expect(error.message).toMatch(/Denied|Invalid price/);
  }
});
it("redacts network failures and rejects failed HTTP, oversized, and malformed responses", async () => {
  const fetchers: (typeof fetch)[] = [async () => { throw Error("private-token"); }, async () => new Response("private-token", { status: 500 }), async () => Response.json({ data: { huge: "x".repeat(1_000_001) } }), async () => new Response("not-json")];
  for (const fetcher of fetchers) await expect(new ShopifyAdminClient("private-token", fetcher).identity()).rejects.toThrow("MODTIME_SHOPIFY_ADMIN_PROVIDER_FAILED");
  await expect(new ShopifyAdminClient("private-token", async () => new Response("", { status: 401 })).identity()).rejects.toThrow("REAUTH_REQUIRED");
});
it("selects one named operation, supports fragments/comments/strings, rejects subscription or ambiguous operations before I/O", async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => Response.json({ data: JSON.parse(options?.body as string).query.includes("currentAppInstallation") ? identity() : { products: { nodes: [] } } }));
  const client = new ShopifyAdminClient("test-token", fetcher);
  for (const input of [{ query: "query A{shop{name}} query B{shop{name}}" }, { query: "subscription Watch{shop{name}}" }, { query: "query A{shop{name}}", operationName: "B" }, { query: "query {shop{name}" }]) await expect(client.execute(input)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  await client.execute({ query: 'fragment Info on Product { id } # mutation Fake\nquery A($filter:String="mutation { test }"){products(first:1,query:$filter){nodes{...Info}}} query B{shop{name}}', operationName: "A" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("bounds inputs without network calls", async () => {
  const fetcher = vi.fn<typeof fetch>(); const client = new ShopifyAdminClient("test", fetcher);
  await expect(client.execute({ query: "x".repeat(256_001) })).rejects.toThrow("INPUT_INVALID");
  await expect(client.execute({ query, variables: { payload: "x".repeat(512_001) } })).rejects.toThrow("INPUT_TOO_LARGE");
  expect(fetcher).not.toHaveBeenCalled();
});

it("permits larger bounded workspace-file payloads only through server dispatch metadata", async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => Response.json({ data: JSON.parse(options?.body as string).query.includes("currentAppInstallation") ? identity() : { shop: { name: "MODTIME" } } }));
  const client = new ShopifyAdminClient("test", fetcher);
  const input = { query: "query{shop{name}}", variables: { png: "a".repeat(600_000) } };
  await expect(client.execute(input)).rejects.toThrow("INPUT_TOO_LARGE");
  await expect(client.execute({ ...input, workspaceRequestFile: true })).rejects.toThrow("INPUT_INVALID");
  expect(fetcher).not.toHaveBeenCalled();
  await expect(client.execute(input, { workspaceRequestFile: true })).resolves.toMatchObject({ data: { shop: { name: "MODTIME" } } });
  fetcher.mockClear();
  await expect(client.execute({ query: input.query, variables: { png: "a".repeat(SHOPIFY_ADMIN_FILE_REQUEST_MAX_BYTES) } }, { workspaceRequestFile: true })).rejects.toThrow("INPUT_TOO_LARGE");
  expect(fetcher).not.toHaveBeenCalled();
});
