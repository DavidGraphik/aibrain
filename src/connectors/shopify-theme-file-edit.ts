import "server-only";
import { createHash } from "node:crypto";
import { shopifyFail } from "./shopify-contracts";
import { draftId, themeFilename, THEME_FILE_LIMIT } from "./shopify-themes-api";

export type ThemeReplacement = { expected: string; replacement: string };
export type ThemeFileEdit = { themeId: string; kind: "theme_file"; filename: string; beforeHash: string; summary: string; changes: ThemeReplacement[] };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function themeFileEdit(input: unknown): ThemeFileEdit {
  const p = input as ThemeFileEdit;
  if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).sort().join() !== "beforeHash,changes,filename,kind,summary,themeId" || p.kind !== "theme_file") shopifyFail("THEME_EDIT_INVALID");
  draftId(p.themeId); themeFilename(p.filename);
  if (typeof p.beforeHash !== "string" || !/^[a-f0-9]{64}$/.test(p.beforeHash) || typeof p.summary !== "string" || !p.summary.trim() || p.summary.length > 600 || /[\x00-\x1f\x7f]/.test(p.summary) || !Array.isArray(p.changes) || !p.changes.length || p.changes.length > 40) shopifyFail("THEME_EDIT_INVALID");
  let bytes = 0;
  for (const c of p.changes) {
    if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).sort().join() !== "expected,replacement" || typeof c.expected !== "string" || !c.expected || typeof c.replacement !== "string" || c.expected === c.replacement || /\x00/.test(c.expected + c.replacement)) shopifyFail("THEME_EDIT_INVALID");
    bytes += Buffer.byteLength(c.expected) + Buffer.byteLength(c.replacement);
  }
  // Every changed fragment is returned intact in the approval card, never truncated.
  if (bytes > 32_000) shopifyFail("THEME_REVIEW_TOO_LARGE");
  return p;
}
function parseJson(text: string) {
  try { return JSON.parse(text.replace(/^\s*\/\*[\s\S]*?\*\//, "")); }
  catch { shopifyFail("THEME_JSON_INVALID"); }
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function ordered(value: unknown, records: Record<string, unknown>) {
  if (!Array.isArray(value) || !value.every(v => typeof v === "string" && Object.hasOwn(records, v)) || new Set(value).size !== value.length) shopifyFail("THEME_JSON_ORDER_INVALID");
}
export function validateThemeFile(content: string, filename: string) {
  if (Buffer.byteLength(content) > THEME_FILE_LIMIT || !content.trim()) shopifyFail("THEME_FILE_TOO_LARGE");
  if (filename.endsWith(".json")) {
    const data = parseJson(content);
    if (filename.startsWith("templates/") || filename.startsWith("sections/")) {
      if (!object(data) || !object(data.sections)) shopifyFail("THEME_JSON_INVALID");
      ordered(data.order, data.sections);
      for (const section of Object.values(data.sections)) {
        if (!object(section) || typeof section.type !== "string" || !section.type) shopifyFail("THEME_JSON_INVALID");
        if (section.blocks !== undefined) {
          if (!object(section.blocks)) shopifyFail("THEME_JSON_INVALID");
          ordered(section.block_order ?? [], section.blocks);
          if (Object.values(section.blocks).some(b => !object(b) || typeof b.type !== "string" || !b.type)) shopifyFail("THEME_JSON_INVALID");
        }
      }
    }
  }
  const schemas = [...content.matchAll(/{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema\s*-?%}/g)];
  const starts = [...content.matchAll(/{%-?\s*schema\s*-?%}/g)].length;
  const ends = [...content.matchAll(/{%-?\s*endschema\s*-?%}/g)].length;
  if (schemas.length > 1 || starts !== schemas.length || ends !== schemas.length) shopifyFail("THEME_SCHEMA_INVALID");
  if (schemas.length) parseJson(schemas[0][1]);
}
/** Apply only uniquely located, non-overlapping fragments of a freshly hashed file.
 * Allows video settings, section/block layout, catalogue-option templates and
 * Liquid/CSS/JS design changes, without any local paths, shell or publication. */
export function patchThemeFile(content: string, input: ThemeFileEdit) {
  const edit = themeFileEdit(input);
  if (hash(content) !== edit.beforeHash) shopifyFail("THEME_CHANGED_CONFLICT");
  const patches = edit.changes.map(c => {
    const start = content.indexOf(c.expected);
    if (start < 0 || content.indexOf(c.expected, start + 1) >= 0) shopifyFail("THEME_EDIT_AMBIGUOUS");
    return { ...c, start, end: start + c.expected.length };
  }).sort((a, b) => a.start - b.start);
  if (patches.some((p, i) => i > 0 && p.start < patches[i - 1].end)) shopifyFail("THEME_EDIT_OVERLAP");
  let next = content;
  for (const p of patches.reverse()) next = next.slice(0, p.start) + p.replacement + next.slice(p.end);
  if (next === content) shopifyFail("THEME_EDIT_NO_CHANGE");
  validateThemeFile(next, edit.filename);
  if (content.includes("schema") && /{%-?\s*schema\s*-?%}/.test(content) && !/{%-?\s*schema\s*-?%}/.test(next)) shopifyFail("THEME_SCHEMA_INVALID");
  return next;
}
