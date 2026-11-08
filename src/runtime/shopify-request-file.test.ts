import { afterEach, expect, it, vi } from "vitest";
import { link, mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
vi.mock("server-only", () => ({}));
import { readShopifyRequestFile } from "./shopify-request-file";
import { SHOPIFY_ADMIN_FILE_REQUEST_MAX_BYTES } from "@/connectors/shopify-admin-api";
const roots: string[] = [];
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "shopify-request-"))); roots.push(root);
  const workspace = path.join(root, "actor", "project");
  await mkdir(path.join(workspace, "drafts"), { recursive: true });
  return { root, workspace };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it("loads ordinary PNG bytes encoded in general GraphQL JSON without credentials or a media-specific operation", async () => {
  const { workspace } = await fixture();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/1cAAAAASUVORK5CYII=";
  const input = { query: "mutation Image($themeId:ID!,$files:[OnlineStoreThemeFilesUpsertFileInput!]!){themeFilesUpsert(themeId:$themeId,files:$files){upsertedThemeFiles{filename} userErrors{message}}}", variables: { themeId: "gid://shopify/OnlineStoreTheme/123", files: [{ filename: "assets/image.png", body: { type: "BASE64", value: png } }] }, operationName: "Image" };
  await writeFile(path.join(workspace, "drafts/image.json"), JSON.stringify(input));
  expect(await readShopifyRequestFile(workspace, "drafts/image.json")).toEqual(input);
});
it("accepts a bounded image payload larger than the inline transport limit", async () => {
  const { workspace } = await fixture();
  const input = { query: "query{shop{name}}", variables: { encoded: Buffer.alloc(600_000, 1).toString("base64") } };
  await writeFile(path.join(workspace, "image.json"), JSON.stringify(input));
  expect(await readShopifyRequestFile(workspace, "image.json")).toEqual(input);
});
it("rejects absent trusted workspace, absolute/traversal/control paths and cross-user symlink or hardlink escapes", async () => {
  const { root, workspace } = await fixture();
  const foreign = path.join(root, "foreign.json"); await writeFile(foreign, '{"query":"query{shop{name}}"}');
  await symlink(foreign, path.join(workspace, "foreign.json"));
  await symlink(root, path.join(workspace, "outside"));
  await link(foreign, path.join(workspace, "hardlink.json"));
  await symlink(workspace, path.join(root, "workspace-alias"));
  for (const input of ["../foreign.json", "drafts/../../foreign.json", foreign, "foreign.json", "outside/foreign.json", "hardlink.json", "drafts", "drafts/./image.json", "drafts//image.json", "drafts\\image.json", "x\0.json", "x\n.json", ""]) {
    await expect(readShopifyRequestFile(workspace, input)).rejects.toThrow("REQUEST_FILE_INVALID");
  }
  await expect(readShopifyRequestFile(undefined, "image.json")).rejects.toThrow("REQUEST_FILE_INVALID");
  await expect(readShopifyRequestFile(path.join(root, "workspace-alias"), "image.json")).rejects.toThrow("REQUEST_FILE_INVALID");
});
it("bounds reads and rejects malformed JSON or invalid UTF-8", async () => {
  const { workspace } = await fixture();
  const target = path.join(workspace, "image.json");
  await writeFile(target, ""); await truncate(target, SHOPIFY_ADMIN_FILE_REQUEST_MAX_BYTES + 1);
  await expect(readShopifyRequestFile(workspace, "image.json")).rejects.toThrow("REQUEST_FILE_INVALID");
  for (const invalid of [Buffer.from("{not json}"), Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])]) {
    await writeFile(target, invalid);
    await expect(readShopifyRequestFile(workspace, "image.json")).rejects.toThrow("REQUEST_FILE_INVALID");
  }
});
