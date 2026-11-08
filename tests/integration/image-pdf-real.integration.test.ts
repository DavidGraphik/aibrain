import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateLocalDocument } from "@/runtime/documents/local-document-generator";
import { generatedPngFixture } from "../helpers/png-fixture";

const run = promisify(execFile);
const PDFINFO = process.env.AIBRAIN_PDFINFO_BIN?.trim() || "/opt/homebrew/bin/pdfinfo";
const PDFTOPPM = process.env.AIBRAIN_PDFTOPPM_BIN?.trim() || "/opt/homebrew/bin/pdftoppm";
const PDFTOTEXT = process.env.AIBRAIN_PDFTOTEXT_BIN?.trim() || "/opt/homebrew/bin/pdftotext";
const enabled = process.env.AIBRAIN_REAL_IMAGE_PDF === "1" &&
  [PDFINFO, PDFTOPPM, PDFTOTEXT].every(existsSync);

describe.skipIf(!enabled)("real image-only PDF rendering", () => {
  let root = "";

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aibrain-image-pdf-"));
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("renders the PNG on exactly one A4 page without description text", async () => {
    const forbiddenDescription = "DESCRIPCION_QUE_NO_DEBE_APARECER";
    const generated = await generateLocalDocument({
      format: "pdf",
      title: "Imagen generada",
      content: forbiddenDescription,
      sourcePng: generatedPngFixture(120, 80),
    });
    const pdfPath = path.join(root, "imagen-generada.pdf");
    const textPath = path.join(root, "imagen-generada.txt");
    const renderPrefix = path.join(root, "imagen-generada-render");
    await writeFile(pdfPath, generated.data, { mode: 0o600 });

    const info = await run(PDFINFO, [pdfPath]);
    expect(info.stdout).toMatch(/^Pages:\s+1$/mu);
    expect(info.stdout).toMatch(/^Page size:\s+595[.]28 x 841[.]89 pts \(A4\)$/mu);

    await run(PDFTOTEXT, [pdfPath, textPath]);
    const extracted = await readFile(textPath, "utf8");
    expect(extracted.trim()).toBe("");
    expect(extracted).not.toContain(forbiddenDescription);

    await run(PDFTOPPM, ["-f", "1", "-l", "1", "-singlefile", "-r", "72", pdfPath, renderPrefix]);
    const rendered = await readFile(`${renderPrefix}.ppm`);
    const header = rendered.subarray(0, 100).toString("ascii");
    const match = /^P6\s+(?:#[^\n]*\s+)*([0-9]+)\s+([0-9]+)\s+255\s/u.exec(header);
    expect(match?.slice(1)).toEqual(["596", "842"]);
    const headerEnd = match?.[0].length ?? 0;
    expect(rendered.subarray(headerEnd).some((byte) => byte !== 0xff)).toBe(true);
  }, 30_000);
});
