import { it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { ShopifyThemesClient, MODTIME_DRAFT_THEMES } from "./shopify-themes-api";
const id = "162490319097", file = "layout/theme.liquid";
const read = { theme: { id: `gid://shopify/OnlineStoreTheme/${id}`, role: "UNPUBLISHED", files: { nodes: [{ filename: file, body: { content: "original" } }], pageInfo: { hasNextPage: false } } } };
it("accepts implicit theme read access but rejects read-only, duplicate and foreign live grants", async () => {
  for (const scopes of [["write_themes"], ["read_themes", "write_themes"], ["read_themes"], ["write_themes", "write_themes"], ["write_themes", "write_orders"]]) {
    const client = new ShopifyThemesClient("synthetic", async () => Response.json({ data: {
      shop: { myshopifyDomain: "c7f82c-f0.myshopify.com" }, currentAppInstallation: { accessScopes: scopes.map(handle => ({ handle })) },
      ...Object.fromEntries(MODTIME_DRAFT_THEMES.map((themeId, i) => [i ? "b" : "a", { id: `gid://shopify/OnlineStoreTheme/${themeId}`, name: "Draft", role: "UNPUBLISHED" }])),
    } }));
    if (scopes.includes("write_themes") && new Set(scopes).size === scopes.length && scopes.every(s => ["read_themes", "write_themes"].includes(s))) await expect(client.drafts()).resolves.toHaveLength(2);
    else await expect(client.drafts()).rejects.toThrow("THEME_IDENTITY_OR_SCOPES_MISMATCH");
  }
});
it("rejects unknown/live themes and files before a network request, and a live provider role before writing", async () => {
  const fetcher = vi.fn(async () => Response.json({ data: read })); const client = new ShopifyThemesClient("synthetic-token", fetcher);
  await expect(client.read("162192523513", file)).rejects.toThrow("DRAFT_THEME_REQUIRED"); await expect(client.read(id, "secrets.txt")).rejects.toThrow("FILE_DENIED"); expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockImplementation(async () => Response.json({ data: { theme: { ...read.theme, role: "MAIN" } } }));
  await expect(client.write(id, file, "new")).rejects.toThrow("DRAFT_THEME_REQUIRED"); expect(fetcher).toHaveBeenCalledTimes(1);
});
it("uses one fixed-store single-file mutation, polls an async job, and never publishes", async () => {
  const requests: { url: string; body: { query: string; variables: Record<string, unknown> } }[] = [];
  const client = new ShopifyThemesClient("synthetic-token", async (url, options) => {
    const body = JSON.parse(options?.body as string); requests.push({ url: String(url), body });
    const data = body.query.startsWith("mutation") ? { themeFilesUpsert: { userErrors: [], upsertedThemeFiles: [], job: { id: "gid://shopify/Job/123" } } } : body.query.includes("job(") ? { job: { id: "gid://shopify/Job/123", done: true } } : read;
    return Response.json({ data });
  });
  await client.write(id, file, "new");
  expect(requests.filter(r => r.body.query.startsWith("mutation"))).toHaveLength(1);
  expect(requests[1].body.variables.files).toEqual([{ filename: file, body: { type: "TEXT", value: "new" } }]);
  expect(requests.every(r => r.url === "https://c7f82c-f0.myshopify.com/admin/api/2026-07/graphql.json")).toBe(true);
  expect(JSON.stringify(requests)).not.toMatch(/themePublish|themeUpdate|shopUpdate|write_content/);
});
it("redacts provider errors and fails on incomplete bodies without returning partial content", async () => {
  const client = new ShopifyThemesClient("private-token", async () => Response.json({ errors: [{ message: "private-token" }] }));
  await expect(client.read(id, file)).rejects.toThrow("THEME_PROVIDER_DENIED");
  const incomplete = new ShopifyThemesClient("test", async () => Response.json({ data: { theme: { ...read.theme, files: { nodes: [] } } } })); await expect(incomplete.read(id, file)).rejects.toThrow("FILE_UNAVAILABLE");
});

it("paginates the existing file inventory and excludes binary media", async () => {
  const requests: unknown[] = [];
  const client = new ShopifyThemesClient("synthetic", async (_url, options) => {
    const { variables } = JSON.parse(options?.body as string); requests.push(variables);
    const first = variables.after === null;
    return Response.json({ data: { theme: { id: read.theme.id, role: "UNPUBLISHED", files: { nodes: (first ? ["assets/hero.mp4", "assets/theme.css"] : ["templates/index.json"]).map(filename => ({ filename })), pageInfo: { hasNextPage: first, endCursor: first ? "page1" : null } } } } });
  });
  expect(await client.files(id)).toEqual(["assets/theme.css", "templates/index.json"]);
  expect(requests).toHaveLength(2);
});
it("refuses repeated cursors, duplicates and a published role during inventory", async () => {
  for (const role of ["MAIN", "UNPUBLISHED"]) {
    const client = new ShopifyThemesClient("synthetic", async () => Response.json({ data: { theme: { id: read.theme.id, role, files: { nodes: [{ filename: "assets/theme.css" }], pageInfo: { hasNextPage: true, endCursor: "same" } } } } }));
    await expect(client.files(id)).rejects.toThrow();
  }
});
it("rechecks interactive authority after provider role lookup and before the mutation", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: read }));
  const client = new ShopifyThemesClient("synthetic", fetcher);
  await expect(client.write(id, file, "new", async () => { throw Error("INTERACTIVE_CHAT_REQUIRED"); })).rejects.toThrow("INTERACTIVE_CHAT_REQUIRED");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string).query).not.toContain("mutation");
});
