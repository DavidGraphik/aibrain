import { crc32, inflateRawSync } from "node:zlib";
import { SaxesParser } from "saxes";

const DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main";
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const CONTENT = "http://schemas.openxmlformats.org/package/2006/content-types";
const THEME = "theme/theme/theme1.xml";
const MANAGER = "theme/theme/themeManager.xml";
const THEME_RELS = "theme/theme/_rels/themeManager.xml.rels";
const PARTS = new Set(["[Content_Types].xml", "_rels/.rels", MANAGER, THEME, THEME_RELS]);
const TAGS = new Set(("theme themeManager themeElements clrScheme dk1 lt1 dk2 lt2 accent1 accent2 accent3 accent4 accent5 accent6 hlink folHlink sysClr srgbClr " +
  "fontScheme majorFont minorFont latin ea cs font fmtScheme fillStyleLst solidFill schemeClr gradFill gsLst gs lumMod satMod tint lin shade lnStyleLst ln prstDash miter " +
  "effectStyleLst effectStyle effectLst outerShdw alpha bgFillStyleLst objectDefaults extraClrSchemeLst").split(" "));
const ATTRIBUTES = new Set("name val lastClr typeface panose script rotWithShape pos ang scaled w cap cmpd algn lim blurRad dist dir".split(" "));
function check(ok: unknown): asserts ok { if (!ok) throw new Error("unsupported-native-theme"); }

/** Closed, bounded theme subset: colours/fonts/formatting only, no images or links.
 * MS-XLS Theme carries an ECMA-376 theme package. Never trust ZIP sizes or XML prefixes.
 */
export function inspectLegacyTheme(data: Buffer) {
  check(data.length >= 22 && data.length <= 64 * 1024);
  const end = data.length - 22;
  check(data.readUInt32LE(end) === 0x06054b50 && data.readUInt32LE(end + 4) === 0 && data.readUInt16LE(end + 20) === 0);
  check(data.readUInt16LE(end + 8) === 5 && data.readUInt16LE(end + 10) === 5);
  const central = data.readUInt32LE(end + 16);
  check(central + data.readUInt32LE(end + 12) === end);
  let at = central, total = 0;
  const seen = new Set<string>(), ranges: [number, number][] = [];
  for (let i = 0; i < 5; i++) {
    check(at + 46 <= end && data.readUInt32LE(at) === 0x02014b50);
    const flags = data.readUInt16LE(at + 8), codec = data.readUInt16LE(at + 10);
    const compressed = data.readUInt32LE(at + 20), size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28), extra = data.readUInt16LE(at + 30), comment = data.readUInt16LE(at + 32);
    const local = data.readUInt32LE(at + 42), next = at + 46 + nameLength + extra + comment;
    check(next <= end && (flags & ~0x0806) === 0 && [0, 8].includes(codec));
    const nameBytes = data.subarray(at + 46, at + 46 + nameLength), name = nameBytes.toString("utf8");
    check(PARTS.has(name) && !seen.has(name)); seen.add(name);
    check(size > 0 && size <= 64 * 1024 && (total += size) <= 128 * 1024);
    check(local + 30 <= central && data.readUInt32LE(local) === 0x04034b50);
    check(data.readUInt16LE(local + 6) === flags && data.readUInt16LE(local + 8) === codec &&
      data.readUInt32LE(local + 14) === data.readUInt32LE(at + 16) && data.readUInt32LE(local + 18) === compressed &&
      data.readUInt32LE(local + 22) === size && data.readUInt16LE(local + 26) === nameLength);
    check(data.subarray(local + 30, local + 30 + nameLength).equals(nameBytes));
    const start = local + 30 + nameLength + data.readUInt16LE(local + 28), finish = start + compressed;
    check(finish <= central && !ranges.some(([a, b]) => local < b && finish > a)); ranges.push([local, finish]);
    const bytes = codec === 8 ? inflateRawSync(data.subarray(start, finish), { maxOutputLength: 64 * 1024 }) : data.subarray(start, finish);
    check(bytes.length === size && crc32(bytes) === data.readUInt32LE(at + 16));
    inspectThemeXml(name, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    at = next;
  }
  check(at === end);
  ranges.sort(([a], [b]) => a - b);
  check(ranges[0]![0] === 0 && ranges.at(-1)![1] === central && ranges.every(([a], i) => !i || a === ranges[i - 1]![1]));
}

function inspectThemeXml(name: string, xml: string) {
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0, nodes = 0, relationshipCount = 0;
  parser.on("doctype", () => check(false));
  parser.on("processinginstruction", () => check(false));
  parser.on("cdata", () => check(false));
  parser.on("text", value => check(value.trim() === ""));
  parser.on("opentag", tag => {
    check(++depth <= 32 && ++nodes <= 4096);
    const attrs: Record<string, string> = {};
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.uri === "http://www.w3.org/2000/xmlns/") continue;
      check(attribute.uri === "" && attribute.value.length <= 512);
      attrs[attribute.local] = attribute.value;
    }
    if (name === THEME || name === MANAGER) {
      check(tag.uri === DRAWING && TAGS.has(tag.local) && Object.keys(attrs).every(key => ATTRIBUTES.has(key)));
      if (depth === 1) check(tag.local === (name === THEME ? "theme" : "themeManager"));
      if (name === MANAGER) check(depth === 1 && Object.keys(attrs).length === 0);
    } else if (name.endsWith(".rels")) {
      check(tag.uri === RELS);
      if (depth === 1) check(tag.local === "Relationships" && Object.keys(attrs).length === 0);
      else {
        check(depth === 2 && tag.local === "Relationship" && Object.keys(attrs).sort().join() === "Id,Target,Type");
        check(++relationshipCount === 1 && /^[A-Za-z0-9_]+$/.test(attrs.Id!));
        check(attrs.Type === OFFICE_RELS + (name === "_rels/.rels" ? "officeDocument" : "theme"));
        check(attrs.Target === (name === "_rels/.rels" ? MANAGER : "theme1.xml"));
      }
    } else {
      check(tag.uri === CONTENT);
      if (depth === 1) check(tag.local === "Types" && Object.keys(attrs).length === 0);
      else if (tag.local === "Default") {
        check(depth === 2 && Object.keys(attrs).sort().join() === "ContentType,Extension");
        check((attrs.Extension === "rels" && attrs.ContentType === "application/vnd.openxmlformats-package.relationships+xml") ||
          (attrs.Extension === "xml" && attrs.ContentType === "application/xml"));
      } else {
        check(depth === 2 && tag.local === "Override" && Object.keys(attrs).sort().join() === "ContentType,PartName");
        check((attrs.PartName === "/" + MANAGER && attrs.ContentType === "application/vnd.openxmlformats-officedocument.themeManager+xml") ||
          (attrs.PartName === "/" + THEME && attrs.ContentType === "application/vnd.openxmlformats-officedocument.theme+xml"));
      }
    }
  });
  parser.on("closetag", () => { depth--; });
  parser.write(xml).close();
  check(nodes > 0 && (!name.endsWith(".rels") || relationshipCount === 1));
}
