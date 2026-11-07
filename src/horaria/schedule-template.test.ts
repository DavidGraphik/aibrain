import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import installation from "../../config/installations/arnall.qa.example.json";
import { generateLocalDocument } from "@/runtime/documents/local-document-generator";
import template from "@/runtime/documents/templates/arnall-schedule.json";
import { arnallScheduleForPreview } from "./schedule-template";

const schedule = {
  establishmentId: 5, establishmentName: "proves", week: "2026-W39",
  people: [{ id: 1, name: "Persona fictícia", section: "DEPENDIENTA",
    codeHours: { M: 7, T: 6, D: 10 }, days: Array(7).fill(null) }],
};
const preview = { establecimientoId: 5, semana: "2026-W39", excelSchedule: schedule };

describe("Arnall preview template selection", () => {
  it("exports the original template for the deployed company-qa configuration", async () => {
    expect(installation.installationId).toBe("company-qa");
    const generated = await generateLocalDocument({
      format: "xlsx", title: "proves", content: "esborrany", spreadsheetLayout: "schedule",
      rows: [["Persona", "Dl", "Dt", "Dc", "Dj", "Dv", "Ds", "Dg", "Hores"]],
      arnallSchedule: arnallScheduleForPreview(installation, preview),
    });
    const zip = await JSZip.loadAsync(generated.data);
    const workbook = await zip.file("xl/workbook.xml")!.async("text");
    expect(workbook.match(/<sheet\b/gu)).toHaveLength(4);
    expect(workbook.match(/state="hidden"/gu)).toHaveLength(3);
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("text");
    expect(sheet).toContain("Persona fictícia");
    expect(sheet.match(/<f\b[^>]*?(?:\/>|>[\s\S]*?<\/f>)/gu))
      .toEqual(template["xl/worksheets/sheet1.xml"].match(/<f\b[^>]*?(?:\/>|>[\s\S]*?<\/f>)/gu));
    expect(sheet.match(/<f\b/gu)).toHaveLength(2499);
    for (const node of ["cols", "mergeCells", "pageMargins", "pageSetup"]) {
      const re = new RegExp(`<${node}\\b[^>]*(?:/>|>[\\s\\S]*?</${node}>)`, "u");
      expect(sheet.match(re)?.[0]).toBe(template["xl/worksheets/sheet1.xml"].match(re)?.[0]);
    }
    expect(await zip.file("xl/styles.xml")!.async("text")).toBe(template["xl/styles.xml"]);
  });

  it.each([undefined, null, [], {}, { ...schedule, establishmentId: 6 }, { ...schedule, week: "2026-W40" }])(
    "rejects missing or mismatched schedule data instead of using the generic table: %j",
    (excelSchedule) => {
      expect(() => arnallScheduleForPreview(installation, { ...preview, excelSchedule }))
        .toThrow("plantilla Excel obligatoria");
    },
  );

  it("selects the same template after an installation ID change", () => {
    const renamed = { ...installation, installationId: "arnall-production" };
    expect(arnallScheduleForPreview(renamed, preview))
      .toBe(schedule);
  });

  it("does not let preview content select another company's template", () => {
    const other = { ...installation, installationId: "arnall", companySlug: "another-company" };
    expect(arnallScheduleForPreview(other, { ...preview, companySlug: "arnall" })).toBeUndefined();
    expect(arnallScheduleForPreview(other, {})).toBeUndefined();
  });
});
