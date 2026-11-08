/** Shared wire validation: spreadsheet sources remain data, never markup or code. */
export type SpreadsheetPreview = {
  schemaVersion: 1;
  kind: "spreadsheet";
  sheets: { name: string; hidden: boolean; truncated?: boolean; cells: { address: string; value: string }[] }[];
  truncated: boolean;
};

export function isSpreadsheetPreview(value: unknown): value is SpreadsheetPreview {
  if (!value || typeof value !== "object") return false;
  const v = value as SpreadsheetPreview;
  if (v.schemaVersion !== 1 || v.kind !== "spreadsheet" || typeof v.truncated !== "boolean" ||
      !Array.isArray(v.sheets) || !v.sheets.length || v.sheets.length > 100) return false;
  let bytes = 0;
  return v.sheets.every((sheet) => {
    if (!sheet || typeof sheet.name !== "string" || !sheet.name || sheet.name.length > 100 ||
        (sheet.truncated !== undefined && typeof sheet.truncated !== "boolean") ||
        typeof sheet.hidden !== "boolean" || !Array.isArray(sheet.cells) || sheet.cells.length > 2000) return false;
    bytes += new TextEncoder().encode(sheet.name).length + 100;
    if (bytes > 60000) return false;
    const seen = new Set<string>();
    return sheet.cells.every((cell) => {
      if (!cell || typeof cell.address !== "string" || !/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(cell.address) ||
          seen.has(cell.address) || typeof cell.value !== "string") return false;
      seen.add(cell.address);
      bytes += new TextEncoder().encode(JSON.stringify({ address: cell.address, value: cell.value })).length;
      return bytes <= 60000;
    });
  });
}
