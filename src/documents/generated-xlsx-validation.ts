import JSZip from "jszip";
import { SaxesParser } from "saxes";

const COMPATIBILITY = "http://schemas.openxmlformats.org/markup-compatibility/2006";

/** ZIP admission alone cannot prove that Office can parse the XML parts. */
export async function validateGeneratedXlsxXml(data: Buffer) {
  const archive = await JSZip.loadAsync(data, { checkCRC32: true });
  for (const entry of Object.values(archive.files)) {
    if (entry.dir || !/\.(?:xml|rels)$/u.test(entry.name)) continue;
    const xml = await entry.async("string");
    const parser = new SaxesParser({ xmlns: true });
    parser.on("doctype", () => { throw new Error("Generated workbook contains a document type."); });
    parser.on("error", () => { throw new Error(`Generated workbook has invalid XML: ${entry.name}`); });
    parser.on("opentag", tag => {
      for (const attribute of Object.values(tag.attributes)) {
        if (attribute.uri === COMPATIBILITY && ["Ignorable", "MustUnderstand"].includes(attribute.local)) {
          for (const prefix of attribute.value.trim().split(/\s+/u).filter(Boolean)) {
            if (!parser.resolve(prefix)) throw new Error(`Generated workbook has an undeclared compatibility prefix: ${entry.name}`);
          }
        }
      }
    });
    parser.write(xml).close();
  }
}
