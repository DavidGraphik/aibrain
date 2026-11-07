import "server-only";
import { boundedJson } from "./shopify-api";
import { SHOPIFY_SHOP, shopifyFail } from "./shopify-contracts";

export const SHOPIFY_ADMIN_SCOPES = ["read_products", "write_products", "read_themes", "write_themes", "read_files", "write_files"] as const;
export const ADMIN_SCOPES = SHOPIFY_ADMIN_SCOPES;
export const SHOPIFY_ADMIN_FILE_REQUEST_MAX_BYTES = 12 * 1024 * 1024;
/** Server-only dispatch metadata; never accepted inside a model request. */
export type ShopifyAdminExecutionOptions = { workspaceRequestFile: true };
export type ShopifyAdminInput = { query: string; variables?: Record<string, unknown>; operationName?: string };
export type ShopifyAdminResult = { data: Record<string, unknown>; operationType: "query" | "mutation"; readbackRequired: boolean };

/** Shopify can omit a redundant read scope when its write grant includes it. */
export function hasRequiredShopifyAdminScopes(value: unknown): value is string[] {
  const scopes: unknown = typeof value === "string" ? value.split(",").map(s => s.trim()) : value;
  if (!Array.isArray(scopes) || scopes.some(s => typeof s !== "string" || !/^(read|write)_[a-z_]+$/.test(s)) || new Set(scopes).size !== scopes.length) return false;
  return SHOPIFY_ADMIN_SCOPES.every(scope => scopes.includes(scope) || scope.startsWith("read_") && scopes.includes(scope.replace(/^read_/, "write_")));
}

// This lexer only selects the operation and locates error aliases. Shopify remains
// the GraphQL parser/schema authority; it executes exactly one selected operation.
function tokens(document: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < document.length;) {
    const ch = document[i];
    if (/[\s,\uFEFF]/.test(ch)) { i++; continue; }
    if (ch === "#") { while (i < document.length && !/[\r\n]/.test(document[i])) i++; continue; }
    if (ch === '"') {
      const block = document.startsWith('"""', i); i += block ? 3 : 1; let closed = false;
      while (i < document.length) {
        if (document[i] === "\\") { i += block && document.startsWith('\\"""', i) ? 4 : 2; continue; }
        if (document.startsWith(block ? '"""' : '"', i)) { i += block ? 3 : 1; closed = true; break; }
        i++;
      }
      if (!closed) shopifyFail("ADMIN_DOCUMENT_INVALID");
      out.push('"string"'); continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(document.slice(i));
    if (name) { out.push(name[0]); i += name[0].length; } else { out.push(ch); i++; }
  }
  return out;
}
function operation(input: ShopifyAdminInput) {
  const t = tokens(input.query), operations: { type: string; name?: string }[] = [];
  let braces = 0, parentheses = 0, header = false;
  for (let i = 0; i < t.length; i++) {
    const token = t[i];
    if (!braces && !parentheses && !header) {
      if (["query", "mutation", "subscription"].includes(token)) {
        operations.push({ type: token, name: /^[A-Za-z_][A-Za-z0-9_]*$/.test(t[i + 1] ?? "") ? t[i + 1] : undefined }); header = true;
      } else if (token === "fragment") header = true;
      else if (token === "{") operations.push({ type: "query" });
    }
    if (token === "(") parentheses++;
    if (token === ")") parentheses--;
    if (token === "{") braces++;
    if (token === "}") { braces--; if (!braces && !parentheses) header = false; }
    if (braces < 0 || parentheses < 0) shopifyFail("ADMIN_DOCUMENT_INVALID");
  }
  if (braces || parentheses) shopifyFail("ADMIN_DOCUMENT_INVALID");
  const selected = input.operationName ? operations.filter(op => op.name === input.operationName) : operations;
  if (selected.length !== 1 || !["query", "mutation"].includes(selected[0].type)) shopifyFail("ADMIN_OPERATION_REQUIRED");
  const errorKeys = new Set(["userErrors"]);
  for (let i = 0; i < t.length - 2; i++) if (t[i + 1] === ":" && t[i + 2] === "userErrors") errorKeys.add(t[i]);
  return { type: selected[0].type as "query" | "mutation", errorKeys };
}

export class ShopifyAdminClient {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {
    if (!token || /\s/.test(token)) shopifyFail("ADMIN_CREDENTIAL_INVALID");
  }
  private sanitize(message: string) {
    return message.split(this.token).join("[redacted]")
      .replace(/\bshp(?:at|ca|pa|ss)_[A-Za-z0-9_-]+\b/gi, "[redacted]")
      .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/((?:access_token|refresh_token|client_secret|authorization)\s*[=:]\s*)[^\s&,;]+/gi, "$1[redacted]")
      .slice(0, 500);
  }
  private failure(code: string, errors: unknown): never {
    const rows = Array.isArray(errors) ? errors : [];
    const details = rows.slice(0, 5).map(row => {
      if (!row || typeof row !== "object") return "Provider error";
      const e = row as Record<string, unknown>;
      return this.sanitize([typeof e.message === "string" ? e.message : "Provider error", typeof e.code === "string" ? e.code : typeof (e.extensions as Record<string, unknown> | undefined)?.code === "string" ? String((e.extensions as Record<string, unknown>).code) : "", Array.isArray(e.field) ? e.field.filter(v => typeof v === "string").join(".") : ""].filter(Boolean).join(" | "));
    }).join("; ");
    throw new Error(`MODTIME_SHOPIFY_${code}${details ? `: ${details}` : ""}`);
  }
  private async request(input: ShopifyAdminInput, errorKeys = new Set(["userErrors"])) {
    let payload;
    try {
      payload = await boundedJson(await this.fetcher(`https://${SHOPIFY_SHOP}/admin/api/2026-07/graphql.json`, {
        method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000),
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": this.token }, body: JSON.stringify(input),
      }), 1_000_000);
    } catch (e) {
      shopifyFail(e instanceof Error && e.message === "MODTIME_SHOPIFY_REAUTH_REQUIRED" ? "REAUTH_REQUIRED" : "ADMIN_PROVIDER_FAILED");
    }
    if (payload.errors !== undefined && (!Array.isArray(payload.errors) || payload.errors.length)) this.failure("ADMIN_GRAPHQL_ERRORS", payload.errors);
    if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) shopifyFail("ADMIN_RESPONSE_INVALID");
    const visit = (value: unknown, depth = 0): void => {
      if (depth > 128) shopifyFail("ADMIN_RESPONSE_INVALID");
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (errorKeys.has(key) && (!Array.isArray(child) || child.length)) this.failure("ADMIN_USER_ERRORS", child);
        visit(child, depth + 1);
      }
    };
    visit(payload.data);
    // Provider data is useful to the model, but the server's credential never is.
    return JSON.parse(JSON.stringify(payload.data).split(this.token).join("[redacted]")) as Record<string, unknown>;
  }
  async identity() {
    const data = await this.request({ query: "query { shop { myshopifyDomain } currentAppInstallation { accessScopes { handle } } }" });
    const shop = data.shop as { myshopifyDomain?: string };
    const app = data.currentAppInstallation as { accessScopes?: { handle?: string }[] };
    const scopes = Array.isArray(app?.accessScopes) ? app.accessScopes.map(s => s?.handle) : null;
    if (shop?.myshopifyDomain !== SHOPIFY_SHOP) shopifyFail("ADMIN_STORE_MISMATCH");
    if (!hasRequiredShopifyAdminScopes(scopes)) shopifyFail("ADMIN_SCOPES_REQUIRED");
    return { shop: SHOPIFY_SHOP, scopes };
  }
  async verify() { return this.identity(); }
  async execute(value: unknown, options?: ShopifyAdminExecutionOptions): Promise<ShopifyAdminResult> {
    const input = value as ShopifyAdminInput;
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["query", "variables", "operationName"].includes(k)) ||
      typeof input.query !== "string" || !input.query.trim() || Buffer.byteLength(input.query) > 256_000 ||
      input.variables !== undefined && (!input.variables || typeof input.variables !== "object" || Array.isArray(input.variables)) ||
      input.operationName !== undefined && (typeof input.operationName !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.operationName))) shopifyFail("ADMIN_INPUT_INVALID");
    let serialized: string;
    try { serialized = JSON.stringify(input); } catch { shopifyFail("ADMIN_INPUT_INVALID"); }
    if (Buffer.byteLength(serialized) > (options?.workspaceRequestFile === true ? SHOPIFY_ADMIN_FILE_REQUEST_MAX_BYTES : 512_000)) shopifyFail("ADMIN_INPUT_TOO_LARGE");
    const selected = operation(input);
    await this.identity();
    const data = await this.request(input, selected.errorKeys);
    return { data, operationType: selected.type, readbackRequired: selected.type === "mutation" };
  }
}
