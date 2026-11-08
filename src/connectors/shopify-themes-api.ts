import "server-only";
import { setTimeout as pause } from "node:timers/promises";
import { boundedJson } from "./shopify-api";
import { SHOPIFY_SHOP, exactShopifyProfileScopes, shopifyFail } from "./shopify-contracts";

export const SHOPIFY_THEMES_ID = "modtime-shopify-themes";
export const MODTIME_DRAFT_THEMES = ["162490319097", "188630040825"] as const;
export const THEME_SCOPES = ["read_themes", "write_themes"] as const;
export const THEME_FILE_LIMIT = 256_000;
export type DraftTheme = { id: string; name: string; role: "UNPUBLISHED" };
export interface ThemeProvider {
  drafts(): Promise<DraftTheme[]>;
  read(themeId: string, filename: string): Promise<string>;
  write(themeId: string, filename: string, content: string, beforeMutation?: () => Promise<void>): Promise<void>;
}
export function draftId(value: unknown): string {
  if (typeof value !== "string" || !MODTIME_DRAFT_THEMES.includes(value as typeof MODTIME_DRAFT_THEMES[number])) shopifyFail("DRAFT_THEME_REQUIRED");
  return value;
}
export function themeFilename(value: unknown): string {
  if (typeof value !== "string" || value.length > 180 || value.includes("..") || !/^(?:(?:layout|snippets|blocks)\/[a-zA-Z0-9][a-zA-Z0-9_.-]*\.liquid|(?:templates\/(?:customers\/)?|sections\/)[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(?:json|liquid)|locales\/[a-zA-Z0-9][a-zA-Z0-9_.-]*\.json|config\/settings_(?:data|schema)\.json|assets\/[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(?:js|css|json|svg)(?:\.liquid)?)$/.test(value)) shopifyFail("THEME_FILE_DENIED");
  return value;
}
const gid = (id: string) => `gid://shopify/OnlineStoreTheme/${draftId(id)}`;
export class ShopifyThemesClient implements ThemeProvider {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  private async query(query: string, variables: Record<string, unknown> = {}) {
    let p;
    try { p = await boundedJson(await this.fetcher(`https://${SHOPIFY_SHOP}/admin/api/2026-07/graphql.json`, {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": this.token }, body: JSON.stringify({ query, variables }),
    }), 1_000_000); } catch { shopifyFail("THEME_PROVIDER_FAILED"); }
    if (p.errors || !p.data || typeof p.data !== "object") shopifyFail("THEME_PROVIDER_DENIED");
    return p.data as Record<string, unknown>;
  }
  async drafts() {
    const data = await this.query(`query { shop { myshopifyDomain } currentAppInstallation { accessScopes { handle } } a:theme(id:"${gid(MODTIME_DRAFT_THEMES[0])}"){id name role} b:theme(id:"${gid(MODTIME_DRAFT_THEMES[1])}"){id name role} }`);
    const identity = data.shop as { myshopifyDomain?: string }, app = data.currentAppInstallation as { accessScopes?: { handle: string }[] };
    if (identity?.myshopifyDomain !== SHOPIFY_SHOP || !Array.isArray(app?.accessScopes) || !exactShopifyProfileScopes(app.accessScopes.map(s => s?.handle), { clientId: "", scopes: THEME_SCOPES, directory: "shopify-themes" })) shopifyFail("THEME_IDENTITY_OR_SCOPES_MISMATCH");
    return [data.a, data.b].map((row, i) => {
      const t = row as { id?: string; name?: string; role?: string };
      if (t?.id !== gid(MODTIME_DRAFT_THEMES[i]) || t.role !== "UNPUBLISHED" || typeof t.name !== "string") shopifyFail("DRAFT_THEME_REQUIRED");
      return { id: MODTIME_DRAFT_THEMES[i], name: t.name, role: "UNPUBLISHED" as const };
    });
  }
  async files(themeId: string) {
    draftId(themeId);
    const filenames: string[] = [], seen = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const data = await this.query("query($id:ID!,$after:String){theme(id:$id){id role files(first:100,after:$after){nodes{filename} pageInfo{hasNextPage endCursor}}}}", { id: gid(themeId), after });
      const t = data.theme as { id?: string; role?: string; files?: { nodes?: { filename?: string }[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } };
      if (t?.id !== gid(themeId) || t.role !== "UNPUBLISHED") shopifyFail("DRAFT_THEME_REQUIRED");
      if (!Array.isArray(t.files?.nodes) || t.files.nodes.length > 100 || typeof t.files.pageInfo?.hasNextPage !== "boolean") shopifyFail("THEME_FILE_UNAVAILABLE");
      for (const row of t.files.nodes) {
        if (typeof row.filename !== "string" || seen.has(row.filename)) shopifyFail("THEME_FILE_UNAVAILABLE");
        seen.add(row.filename);
        try { filenames.push(themeFilename(row.filename)); } catch { /* Binary assets are not editable text. */ }
      }
      if (!t.files.pageInfo.hasNextPage) return filenames.sort();
      const cursor = t.files.pageInfo.endCursor;
      if (typeof cursor !== "string" || !cursor || cursor === after || cursor.length > 1000) shopifyFail("THEME_FILE_UNAVAILABLE");
      after = cursor;
    }
    shopifyFail("THEME_FILE_LIST_TOO_LARGE");
  }
  async read(themeId: string, filename: string) {
    themeFilename(filename);
    const data = await this.query(`query($id:ID!,$files:[String!]!){theme(id:$id){id role files(first:1,filenames:$files){nodes{filename body{... on OnlineStoreThemeFileBodyText{content}}} pageInfo{hasNextPage}}}}`, { id: gid(themeId), files: [filename] });
    const t = data.theme as { id?: string; role?: string; files?: { nodes?: { filename?: string; body?: { content?: string } }[]; pageInfo?: { hasNextPage?: boolean } } };
    const files = t?.files;
    if (t?.id !== gid(themeId) || t.role !== "UNPUBLISHED") shopifyFail("DRAFT_THEME_REQUIRED");
    if (!Array.isArray(files?.nodes) || files.nodes.length !== 1 || files.pageInfo?.hasNextPage !== false || files.nodes[0]?.filename !== filename || typeof files.nodes[0].body?.content !== "string") shopifyFail("THEME_FILE_UNAVAILABLE");
    const content = files.nodes[0].body.content;
    if (Buffer.byteLength(content) > THEME_FILE_LIMIT) shopifyFail("THEME_FILE_TOO_LARGE");
    return content;
  }
  async write(themeId: string, filename: string, content: string, beforeMutation?: () => Promise<void>) {
    themeFilename(filename); draftId(themeId);
    if (Buffer.byteLength(content) > THEME_FILE_LIMIT) shopifyFail("THEME_FILE_TOO_LARGE");
    // Recheck live role immediately before the single-file write; no publish mutation exists.
    await this.read(themeId, filename);
    await beforeMutation?.();
    const data = await this.query(`mutation($id:ID!,$files:[OnlineStoreThemeFilesUpsertFileInput!]!){themeFilesUpsert(themeId:$id,files:$files){userErrors{code} upsertedThemeFiles{filename} job{id}}}`, { id: gid(themeId), files: [{ filename, body: { type: "TEXT", value: content } }] });
    const p = data.themeFilesUpsert as { userErrors?: unknown[]; upsertedThemeFiles?: { filename?: string }[]; job?: { id?: string } | null };
    if (!Array.isArray(p?.userErrors) || p.userErrors.length) shopifyFail("THEME_WRITE_DENIED");
    if (p.job?.id) {
      if (typeof p.job.id !== "string" || p.job.id.length > 256) shopifyFail("THEME_WRITE_INDETERMINATE");
      for (let attempt = 0; attempt < 6; attempt++) {
        const result = await this.query("query($id:ID!){job(id:$id){id done}}", { id: p.job.id });
        const job = result.job as { id?: string; done?: boolean };
        if (job?.id !== p.job.id || typeof job.done !== "boolean") shopifyFail("THEME_WRITE_INDETERMINATE");
        if (job.done) return; // Engine still requires a new exact file readback.
        await pause(500);
      }
      shopifyFail("THEME_WRITE_INDETERMINATE");
    }
    if (p.upsertedThemeFiles?.length !== 1 || p.upsertedThemeFiles[0].filename !== filename) shopifyFail("THEME_WRITE_INDETERMINATE");
  }
}
