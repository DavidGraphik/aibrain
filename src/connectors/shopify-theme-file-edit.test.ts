import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { patchThemeFile, themeFileEdit, validateThemeFile } from "./shopify-theme-file-edit";
import { themeHash } from "./shopify-theme-edit";
const themeId = "188630040825";
function edit(content: string, filename: string, expected: string, replacement: string) {
  return { themeId, kind: "theme_file" as const, filename, beforeHash: themeHash(content), summary: "Review this draft website change", changes: [{ expected, replacement }] };
}
it("switches a video reference and reorders sections while preserving all other template settings", () => {
  const original = '/* Shopify generated */\n{"sections":{"hero":{"type":"mariowatches-home","settings":{"hero_video":"shopify://files/videos/old.mp4","heading":"YOUR WATCH! YOUR WAY!"}},"reviews":{"type":"reviews"}},"order":["hero","reviews"]}';
  const video = patchThemeFile(original, edit(original, "templates/index.json", '"shopify://files/videos/old.mp4"', '"shopify://files/videos/new.mp4"'));
  expect(video).toBe(original.replace("old.mp4", "new.mp4"));
  expect(patchThemeFile(video, edit(video, "templates/index.json", '["hero","reviews"]', '["reviews","hero"]'))).toContain('"order":["reviews","hero"]');
});
it("adds a compatible configurator option with its order without changing the price or family binding", () => {
  const old = '{"sections":{"main":{"type":"modtime-configurator","settings":{"preview_family":"speed-configurator-vk63"}},"options":{"type":"watch-options","blocks":{"black":{"type":"option","settings":{"title":"Black","enabled":true,"is_default":true,"original_asset":"black.webp"}}},"block_order":["black"]}},"order":["main","options"]}';
  const expected = '"block_order":["black"]';
  const addition = old.replace('"block_order":["black"]', '"block_order":["black","blue"]');
  const full = addition.replace('"blocks":{"black":', '"blocks":{"blue":{"type":"option","settings":{"title":"Blue","enabled":true,"is_default":false,"original_asset":"blue.webp"}},"black":');
  expect(patchThemeFile(old, edit(old, "templates/page.mt-edit-speed.json", old, full))).toBe(full);
  expect(() => patchThemeFile(old, edit(old, "templates/page.mt-edit-speed.json", expected, '"block_order":["black","missing"]'))).toThrow("ORDER_INVALID");
});
it("supports existing CSS, Liquid schema, locales and settings while rejecting malformed results", () => {
  const css = '.hero { padding: 20px; color: #fff; }';
  expect(patchThemeFile(css, edit(css, "assets/theme.css", "20px", "30px"))).toBe(css.replace("20px", "30px"));
  const liquid = '<h1>Welcome</h1>{% schema %}{"name":"Hero","settings":[]}{% endschema %}';
  expect(patchThemeFile(liquid, edit(liquid, "sections/hero.liquid", "Welcome", "MODTIME"))).toContain("MODTIME");
  for (const replacement of ['{"broken":}', '{"name":"Hero"}', '']) {
    expect(() => patchThemeFile(liquid, edit(liquid, "sections/hero.liquid", '{"name":"Hero","settings":[]}{% endschema %}', replacement))).toThrow();
  }
  expect(() => validateThemeFile('{"sections":{},"order":["missing"]}', "templates/index.json")).toThrow();
  expect(() => validateThemeFile('{"a":}', "locales/en.default.json")).toThrow();
  expect(() => validateThemeFile('{% endschema %}', "sections/hero.liquid")).toThrow("SCHEMA_INVALID");
});
it("requires a fresh exact hash, unique fragments, nonoverlapping edits and a fully bounded review", () => {
  const original = "one two two three";
  expect(() => patchThemeFile(original, { ...edit(original, "assets/theme.css", "one", "ONE"), beforeHash: "0".repeat(64) })).toThrow("CONFLICT");
  expect(() => patchThemeFile(original, edit(original, "assets/theme.css", "two", "TWO"))).toThrow("AMBIGUOUS");
  expect(() => patchThemeFile(original, { ...edit(original, "assets/theme.css", "one two", "ONE"), changes: [{ expected: "one two", replacement: "ONE" }, { expected: "one", replacement: "Other" }] })).toThrow("OVERLAP");
  expect(() => themeFileEdit(edit(original, "assets/theme.css", "one", "x".repeat(32000)))).toThrow("REVIEW_TOO_LARGE");
  for (const filename of ["../secret", "assets/.env", "config/secret.json", "assets/image.png", "templates/../../x.json"]) expect(() => themeFileEdit(edit(original, filename, "one", "ONE"))).toThrow("FILE_DENIED");
  expect(() => themeFileEdit({ ...edit(original, "assets/theme.css", "one", "ONE"), themeId: "162192523513" })).toThrow("DRAFT_THEME_REQUIRED");
  const plan = { ...edit("a b", "assets/theme.css", "a", "b"), changes: [{ expected: "a", replacement: "b" }, { expected: "b", replacement: "c" }] };
  expect(patchThemeFile("a b", plan)).toBe("b c"); // Replacements cannot retarget earlier inserted text.
});
