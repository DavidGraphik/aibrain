import type { LocalDocumentCell } from "./local-document-generator";

const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Server-selected print layout for the existing chat document preview. */
export function styleScheduleWorkbook(files: Record<string, string>, title: string, content: string, rows: readonly (readonly LocalDocumentCell[])[]) {
  const sheet = "xl/worksheets/sheet1.xml";
  const widths = [30, 23, 23, 23, 23, 23, 23, 23, 9];
  files[sheet] = files[sheet]
    .replace("<sheetViews>", '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews>')
    .replace('<sheetView workbookViewId="0"/>', '<sheetView workbookViewId="0" showGridLines="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView>')
    .replace("<sheetData>", `<cols>${widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join("")}</cols><sheetData>`)
    .replace(/<row r="(\d+)">/gu, (_, raw: string) => {
      const index = Number(raw) - 1;
      const lines = Math.max(...rows[index].map((cell, column) => String(cell ?? "").split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / (widths[column] - 4))), 0)));
      return `<row r="${raw}" ht="${index === 0 ? 28 : Math.max(48, lines * 14 + 12)}" customHeight="1">`;
    })
    .replace(/<c r="([A-Z]+)(\d+)"([^>]*)>/gu, (_, col: string, row: string, attrs: string) => `<c r="${col}${row}"${attrs.replace(/ s="\d+"/u, "")} s="${row === "1" ? 1 : Number(row) % 2 ? 2 : 0}">`)
    .replace("</worksheet>", `<printOptions horizontalCentered="1"/><pageMargins left="0.3" right="0.3" top="0.6" bottom="0.5" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/><headerFooter><oddHeader>${escapeXml(`&L&"Carlito,Bold"&12${title.replaceAll("&", "&&").slice(0, 180)}`)}</oddHeader><oddFooter>${escapeXml(`&L${content.replaceAll("&", "&&").slice(0, 180)}&RPàgina &P / &N`)}</oddFooter></headerFooter></worksheet>`);
  const sheetName = files["xl/workbook.xml"].match(/<sheet name="([^"]+)"/u)?.[1] ?? "Datos";
  files["xl/workbook.xml"] = files["xl/workbook.xml"].replace("</sheets>", `</sheets><definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">'${sheetName.replaceAll("&apos;", "''")}'!$1:$1</definedName></definedNames>`);
  files["xl/styles.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><color rgb="FF202B29"/><name val="Carlito"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Carlito"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF29443B"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F2"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3">${[0, 1, 2].map(i => `<xf numFmtId="0" fontId="${i === 1 ? 1 : 0}" fillId="${i === 1 ? 2 : i === 2 ? 3 : 0}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1" indent="1"/></xf>`).join("")}</cellXfs></styleSheet>`;
}
