import { expect, it } from "vitest";
import { generateLocalDocument } from "@/runtime/documents/local-document-generator";
import { prepareWorkbookGrid } from "@/documents/workbook-grid";

it("opens a wide generated workbook as saved cells across its full column range", async () => {
  const headings = Array.from({ length: 40 }, (_, index) => `Columna ${index + 1}`);
  const generated = await generateLocalDocument({
    format: "xlsx", title: "Full horitzontal", content: "Dades de prova",
    rows: [headings, headings.map((_, index) => `Valor ${index + 1}`)],
  });
  const grid = await prepareWorkbookGrid({ fileName: "full.xlsx", data: generated.data });
  expect(grid.kind).toBe("spreadsheet");
  expect(grid.truncated).toBe(false);
  expect(grid.sheets[0]?.cells).toContainEqual({ address: "AN2", value: "Valor 40" });
});

it.each([false, true])("retains a later summary after a large %s-hidden worksheet through the real reader", async (hidden) => {
  const { default: JSZip } = await import("jszip");
  const generated = await generateLocalDocument({ format: "xlsx", title: "Orders", content: "Synthetic", rows: [["Order"]] });
  const archive = await JSZip.loadAsync(generated.data);
  const book = await archive.file("xl/workbook.xml")!.async("string");
  archive.file("xl/workbook.xml", book.replace('r:id="rId1"', `r:id="rId1"${hidden ? ' state="hidden"' : ""}`)
    .replace("</sheets>", '<sheet name="Summary" sheetId="2" r:id="summary"/></sheets>'));
  const relations = await archive.file("xl/_rels/workbook.xml.rels")!.async("string");
  archive.file("xl/_rels/workbook.xml.rels", relations.replace("</Relationships>", '<Relationship Id="summary" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'));
  const namespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  archive.file("xl/worksheets/sheet1.xml", `<worksheet xmlns="${namespace}"><sheetData>${Array.from({ length: 1000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${"é".repeat(100)}</t></is></c></row>`).join("")}</sheetData></worksheet>`);
  archive.file("xl/worksheets/sheet2.xml", `<worksheet xmlns="${namespace}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Quarterly summary</t></is></c><c r="B1" t="inlineStr"><is><t>00123</t></is></c></row></sheetData></worksheet>`);
  const data = await archive.generateAsync({ type: "nodebuffer" });
  const source = Buffer.from(data);
  const grid = await prepareWorkbookGrid({ fileName: "orders.xlsx", data });
  expect(grid.sheets[0]).toMatchObject({ hidden, truncated: true });
  expect(grid.sheets[1]).toMatchObject({ name: "Summary", truncated: false, cells: [
    { address: "A1", value: "Quarterly summary" }, { address: "B1", value: "00123" },
  ] });
  expect(Buffer.byteLength(JSON.stringify(grid))).toBeLessThanOrEqual(60000);
  expect(data.equals(source)).toBe(true);
});
