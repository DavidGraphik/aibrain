import { makeAutoFilterProfile } from "./legacy-autofilter";

const scenarios = [
  { name: "basic", columns: 3 },
  { name: "single", columns: 1 },
  { name: "wide", columns: 30 },
  { name: "maximum", columns: 256 },
  { name: "multi", columns: [2, 5] },
];
process.stdout.write(JSON.stringify(scenarios.map(({ name, columns }) => {
  const profile = makeAutoFilterProfile(columns);
  return {
    name, global: profile.global.toString("base64"),
    sheets: profile.sheets.map(sheet => ({
      filterColumns: sheet.filterColumns,
      pairs: sheet.pairs.map(pair => ({
        drawing: pair.drawing.toString("base64"), object: pair.object.toString("base64"),
      })),
    })),
  };
})));
