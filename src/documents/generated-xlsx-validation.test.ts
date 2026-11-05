import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { validateGeneratedXlsxXml } from "./generated-xlsx-validation";
import { arnallScheduleParts } from "@/runtime/documents/arnall-schedule";
import template from "@/runtime/documents/templates/arnall-schedule.json";
const archive = async (parts: Record<string, string>) => {
  const zip = new JSZip(); for (const [name, text] of Object.entries(parts)) zip.file(name, text);
  return zip.generateAsync({ type: "nodebuffer" });
};
describe("Office XML compatibility gate", () => {
  it("accepts the fixed template but rejects the original undeclared Ignorable namespace", async () => {
    await expect(validateGeneratedXlsxXml(await archive(template))).resolves.toBeUndefined();
    const old = { ...template, "xl/styles.xml": template["xl/styles.xml"].replace(/ xmlns:x14ac="[^"]+"/u, "") };
    await expect(validateGeneratedXlsxXml(await archive(old))).rejects.toThrow("undeclared compatibility prefix");
    await expect(validateGeneratedXlsxXml(await archive({ "xl/styles.xml": "<styles>" }))).rejects.toThrow("invalid XML");
  });
  it("keeps table metadata consistent with translated worksheet headers", () => {
    const parts = arnallScheduleParts({ establishmentId: 3, establishmentName: "Test", week: "2026-W41", people: [] });
    for (const number of [2, 3, 4]) {
      const headers = Array.from(parts[`xl/worksheets/sheet${number}.xml`].matchAll(/<c\b[^>]*\br="([A-Z]+)1"[^>]*>([\s\S]*?)<\/c>/gu))
        .flatMap(c => { const text = c[2].match(/<t\b[^>]*>([\s\S]*?)<\/t>/u)?.[1]; return text ? [text] : []; });
      const names = Array.from(parts[`xl/tables/table${number - 1}.xml`].matchAll(/<tableColumn\b[^>]*\bname="([^"]+)"/gu), m => m[1]);
      expect(headers.slice(0, names.length)).toEqual(names);
    }
  });
});
