import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const output = new URL("../dist/pptxgenjs.cjs", import.meta.url);
await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
const result = await build({
  entryPoints: [require.resolve("pptxgenjs")],
  outfile: fileURLToPath(output),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  legalComments: "inline",
  metafile: true,
});
// PptxGenJS declares image-size but its CJS authoring build never imports it.
// Keep that unused parser (and any future dependency surprise) out of runtime.
if (Object.keys(result.metafile.inputs).some((file) => file.includes("/image-size/"))) {
  throw new Error("Presentation bundle unexpectedly includes image-size");
}
// PptxGenJS 4.0.1 adds an apostrophe to category-chart table refs in the
// embedded XLSX. Apple's Keynote/Quick Look then silently drops the chart.
// Keep the patch pinned to the exact upstream expression and fail on drift.
const source = await readFile(output, "utf8");
const invalidRef = '${data[0].labels[0].length + 1}\'" totalsRowShown="0">';
const correctedRef = '${data[0].labels[0].length + 1}" totalsRowShown="0">';
if (source.split(invalidRef).length !== 2) {
  throw new Error("PptxGenJS category-chart patch no longer matches exactly once");
}
const invalidZero = 'getExcelColName(data[0].labels.length + idy + 1)}${idx + 2}"><v>${data[idy].values[idx] || ""}</v></c>`;';
const correctedZero = 'getExcelColName(data[0].labels.length + idy + 1)}${idx + 2}"><v>${data[idy].values[idx] === 0 ? 0 : (data[idy].values[idx] || "")}</v></c>`;';
if (source.split(invalidZero).length !== 2) {
  throw new Error("PptxGenJS category-chart zero patch no longer matches exactly once");
}
await writeFile(output, source.replace(invalidRef, correctedRef).replace(invalidZero, correctedZero));
