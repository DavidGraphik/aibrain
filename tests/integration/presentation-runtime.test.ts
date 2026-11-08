import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { validateUploadedDocument } from "@/documents/upload-validation";

const run = promisify(execFile);

it("authors editable rich slides from the standalone runtime with no workspace dependencies", async () => {
  await run(process.execPath, ["scripts/build-presentation-runtime.mjs"]);
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-presentation-runtime-"));
  try {
    await writeFile(path.join(root, "pptxgenjs.cjs"), await readFile("dist/pptxgenjs.cjs"));
    await writeFile(path.join(root, "author.cjs"), `
      const PptxGenJS = require('./pptxgenjs.cjs');
      const deck = new PptxGenJS();
      deck.layout = 'LAYOUT_WIDE';
      const cover = deck.addSlide();
      cover.background = { color: '142B23' };
      cover.addText('Operations', { x: .7, y: 1, w: 10, h: 1, fontSize: 42, color: 'FFFFFF' });
      const evidence = deck.addSlide();
      evidence.addText('Example data', { x: .7, y: .4, w: 10, h: .8, fontSize: 32 });
      evidence.addChart(deck.ChartType.bar, [{ name: 'Illustrative', labels: ['A', 'B'], values: [10, 0] }], { x: .7, y: 1.5, w: 8, h: 4 });
      evidence.addImage({ data: 'image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQaEgAAAGUAPHREbpHAAAAAElFTkSuQmCC', x: 10, y: 2, w: 1, h: 1 });
      deck.writeFile({ fileName: 'review.pptx' });
    `);
    await run(process.execPath, ["author.cjs"], { cwd: root, env: { ...process.env, NODE_PATH: "" } });
    const data = await readFile(path.join(root, "review.pptx"));
    expect(validateUploadedDocument({ fileName: "review.pptx", declaredMimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", data }).kind).toBe("pptx");
    const archive = await JSZip.loadAsync(data);
    const slides = Object.keys(archive.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name));
    expect(slides).toHaveLength(2);
    expect(await archive.file(slides[0]!)!.async("text")).toContain('142B23');
    expect(Object.keys(archive.files).some((name) => /^ppt\/charts\/chart\d+\.xml$/u.test(name))).toBe(true);
    const embeddedName = Object.keys(archive.files).find((name) => /^ppt\/embeddings\/.*\.xlsx$/u.test(name));
    expect(embeddedName).toBeDefined();
    const embedded = await JSZip.loadAsync(await archive.file(embeddedName!)!.async("nodebuffer"));
    const table = await embedded.file("xl/tables/table1.xml")!.async("text");
    expect(table).toMatch(/ref="A1:[A-Z]+[1-9][0-9]*"/u);
    expect(table).not.toMatch(/ref="[^"]*'"/u);
    const sheet = await embedded.file("xl/worksheets/sheet1.xml")!.async("text");
    expect(sheet).toMatch(/<c r="B3"><v>0<\/v><\/c>/u);
    expect(Object.keys(archive.files).some((name) => name.startsWith("ppt/media/") && name.endsWith(".png"))).toBe(true);
    expect(await archive.file(slides[1]!)!.async("text")).toContain("Example data");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
