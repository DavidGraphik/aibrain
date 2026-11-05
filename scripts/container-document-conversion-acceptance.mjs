import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Run only inside the final runtime image under the production container profile.
// Every fixture is synthetic and confined to a disposable private conversion root.
assert.equal(process.getuid(), 10001, 'Acceptance must run as the runtime user');
const require = createRequire(import.meta.url);
const PptxGenJS = require('/usr/local/share/aibrain/pptxgenjs.cjs');
const run = promisify(execFile);
const work = await mkdtemp('/tmp/aibrain-turn-document-');
const markers = ['CONVERSION ACCEPTANCE ONE', 'CONVERSION ACCEPTANCE TWO'];
async function tool(name, args) {
  const result = await run(`/usr/local/bin/aibrain-${name}`, args, {
    cwd: work,
    timeout: 90_000,
    maxBuffer: 2 * 1024 * 1024,
    encoding: 'utf8',
  });
  return result.stdout;
}

try {
  const deck = new PptxGenJS();
  deck.layout = 'LAYOUT_WIDE';
  deck.title = 'Synthetic container conversion acceptance';
  deck.theme = { headFontFace: 'Liberation Sans', bodyFontFace: 'Liberation Sans' };
  for (const [index, marker] of markers.entries()) {
    const slide = deck.addSlide();
    slide.background = { color: index ? 'E8EEF4' : '172C3C' };
    slide.addText(marker, { x: 0.6, y: 0.6, w: 12, h: 1, fontSize: 30, color: index ? '172C3C' : 'FFFFFF' });
    slide.addChart(deck.ChartType.bar, [{ name: 'Synthetic values', labels: ['A', 'B', 'C'], values: [2, 0, 8] }], {
      x: 0.8, y: 2, w: 11.5, h: 4, showTitle: false, showLegend: false,
    });
  }
  const pptx = path.join(work, 'acceptance.pptx');
  const pdf = path.join(work, 'acceptance.pdf');
  await deck.writeFile({ fileName: pptx });
  assert.equal((await readFile(pptx)).subarray(0, 2).toString(), 'PK', 'PptxGenJS must produce OOXML bytes');
  await run('/usr/bin/python3', ['-c', [
    'import sys, zipfile, xml.etree.ElementTree as ET',
    'with zipfile.ZipFile(sys.argv[1]) as deck:',
    '    names = [name for name in deck.namelist() if name.startswith("ppt/embeddings/") and name.endswith(".xlsx")]',
    '    assert len(names) == 2, "Each chart must embed an Excel workbook"',
    '    for name in names:',
    '        with zipfile.ZipFile(deck.open(name)) as book:',
    '            table = ET.fromstring(book.read("xl/tables/table1.xml"))',
    '            assert "\'" not in table.attrib["ref"], "Chart table reference is invalid"',
    '            sheet = book.read("xl/worksheets/sheet1.xml")',
    '            assert b\'<c r="B3"><v>0</v></c>\' in sheet, "Chart lost a zero value"',
  ].join('\n'), pptx], { cwd: work, timeout: 15_000 });
  await tool('soffice', [
    `-env:UserInstallation=${pathToFileURL(path.join(work, 'lo-profile')).href}`, '--headless', '--invisible', '--nologo',
    '--nodefault', '--nofirststartwizard', '--norestore', '--safe-mode',
    '--convert-to', 'pdf', '--outdir', work, pptx,
  ]);
  assert.equal((await readFile(pdf)).subarray(0, 5).toString(), '%PDF-', 'LibreOffice must produce a real PDF');
  const info = await tool('pdfinfo', [pdf]);
  assert.match(info, /^Pages:\s+2\s*$/m, 'Export must retain both slides');
  await tool('pdftotext', ['-layout', pdf, path.join(work, 'text.txt')]);
  const text = await readFile(path.join(work, 'text.txt'), 'utf8');
  for (const marker of markers) assert.ok(text.includes(marker), `PDF lost slide text: ${marker}`);
  await tool('pdftoppm', ['-scale-to', '1000', '-png', pdf, path.join(work, 'slide')]);
  const pages = (await readdir(work)).filter((name) => /^slide-\d+\.png$/.test(name));
  assert.equal(pages.length, 2, 'Poppler must render every slide');
  for (const page of pages) {
    const png = await readFile(path.join(work, page));
    assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Render must be PNG');
    assert.equal(png.subarray(12, 16).toString(), 'IHDR');
    assert.equal(png.readUInt32BE(16), 1000, 'Wide slide must render at requested width');
    assert.ok(png.readUInt32BE(20) >= 550 && png.readUInt32BE(20) <= 570, 'Slide aspect ratio must remain 16:9');
    assert.ok(png.length > 1000, 'Rendered page must contain image data');
  }
  console.log(JSON.stringify({ status: 'passed', source: 'PptxGenJS', pdfPages: 2, renderedPngPages: pages.length, textVerified: true }));
} finally {
  await rm(work, { recursive: true, force: true });
}
