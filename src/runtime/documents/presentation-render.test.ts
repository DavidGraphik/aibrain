import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { PDFDocument } from "pdf-lib";
import { afterEach, expect, it, vi } from "vitest";
import { renderPresentationDraft } from "./presentation-render";
import { generatedPngFixture } from "../../../tests/helpers/png-fixture";
vi.mock("server-only", () => ({}));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "presentation-review-"))); roots.push(root);
  await mkdir(path.join(root, ".aibrain-drafts"));
  const doc = await PDFDocument.create(); doc.addPage();
  const pdf = Buffer.from(await doc.save());
  await writeFile(path.join(root, ".aibrain-drafts/deck.pdf"), pdf);
  const render = vi.fn().mockResolvedValue({ pdf, png: generatedPngFixture(), pages: 1 });
  return { root, pdf, render, args: { relativePath: ".aibrain-drafts/deck.pdf", page: 1 } };
}
it("rejects traversal, non-drafts and invalid pages before conversion", async () => {
  const { root, render } = await fixture();
  for (const relativePath of ["/tmp/deck.pdf", ".aibrain-drafts/../deck.pdf", "documents/deck.pdf", ".aibrain-drafts/deck.docx", ".aibrain-drafts//deck.pdf"]) {
    await expect(renderPresentationDraft({ relativePath, page: 1 }, root, render)).rejects.toThrow();
  }
  for (const page of [0, 51, 1.5]) await expect(renderPresentationDraft({ relativePath: ".aibrain-drafts/deck.pdf", page }, root, render)).rejects.toThrow();
  expect(render).not.toHaveBeenCalled();
});
it("rejects source symlinks and linked directories", async () => {
  const { root, args, render } = await fixture();
  await symlink(path.join(root, args.relativePath), path.join(root, ".aibrain-drafts/link.pdf"));
  await symlink(path.join(root, ".aibrain-drafts"), path.join(root, ".aibrain-drafts/linked"));
  for (const relativePath of [".aibrain-drafts/link.pdf", ".aibrain-drafts/linked/deck.pdf"]) await expect(renderPresentationDraft({ relativePath, page: 1 }, root, render)).rejects.toThrow();
  expect(render).not.toHaveBeenCalled();
});
it("rejects mutated sources and preserves immutable review bytes", async () => {
  const { root, args, pdf, render } = await fixture();
  const first = await renderPresentationDraft(args, root, render);
  expect(await readFile(path.join(root, first.reviewPdfPath))).toEqual(pdf);
  await writeFile(path.join(root, first.reviewPdfPath), Buffer.from("%PDF-tampered"));
  await expect(renderPresentationDraft(args, root, render)).rejects.toThrow("Review PDF changed");
  render.mockImplementation(async () => { await writeFile(path.join(root, args.relativePath), Buffer.concat([pdf, Buffer.from("\nchanged")])); return { pdf, png: generatedPngFixture(), pages: 1 }; });
  await expect(renderPresentationDraft(args, root, render)).rejects.toThrow("Draft changed");
});
it("rejects invalid source bytes, result pages, and unsafe review directories", async () => {
  const { root, args, pdf, render } = await fixture();
  await writeFile(path.join(root, args.relativePath), "not pdf");
  await expect(renderPresentationDraft(args, root, render)).rejects.toThrow(); expect(render).not.toHaveBeenCalled();
  await writeFile(path.join(root, args.relativePath), pdf);
  render.mockResolvedValueOnce({ pdf, png: generatedPngFixture(), pages: 51 });
  await expect(renderPresentationDraft(args, root, render)).rejects.toThrow("page count");
  const result = await renderPresentationDraft(args, root, render);
  const directory = path.dirname(path.join(root, result.reviewPdfPath));
  await rm(directory, { recursive: true });
  await mkdir(path.join(root, "elsewhere")); await symlink(path.join(root, "elsewhere"), directory);
  await expect(renderPresentationDraft(args, root, render)).rejects.toThrow();
  expect(await readdir(path.join(root, "elsewhere"))).toEqual([]);
});
