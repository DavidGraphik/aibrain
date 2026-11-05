# Private presentation authoring

This guide is bundled at `/usr/local/share/aibrain/presentations.md` for the
employee worker. It provides local authoring, not authorization for external
services or access to any other employee's files.

## Editorial workflow is mandatory

For all slide decks, including PDF-only output, read the authorized private
`presentation-craft` SKILL.md supplied by the server policy before authoring.
It carries the Codex presentation narrative, writing, template, chart and visual
review workflow adapted to this runtime. This document is the implementation
adapter, not a replacement for that editorial workflow. Follow human-writing
for slide copy and Impeccable for applicable visual direction. Do not load
frontend motion guides merely because a deck has design.

Keep a private storyboard and page-by-page review record in `.aibrain-drafts/`.
Check chart arithmetic independently and inspect every final slide image.
A render receipt proves conversion only, not inspection or design quality.

## Plan a real deck

Use the user's brief, language, slide count, reference and available design
skill. Decide the story and purpose of each slide before writing the authoring
script. Do not treat the document renderer's title/body fields as a design
engine. It is only suitable for explicitly simple text documents.

Build a deliberate cover, varied compositions and concise content. Use real
authorized local images where useful, native editable charts for data, and
clear type hierarchy. Do not fabricate data, sources, images or company facts.
Do not turn every paragraph into a slide or repeat a heading on overflow pages.
Keep the requested slide count; rewrite dense content instead of splitting it
mid-sentence or shrinking it until unreadable. Missing visual tools are a
limitation to report, never a reason to claim a text dump is a finished design.

## Author without installing packages

Node and a pinned PptxGenJS bundle are available without network access:

```js
const pptxgen = require('/usr/local/share/aibrain/pptxgenjs.cjs');
const deck = new pptxgen();
deck.layout = 'LAYOUT_WIDE';
deck.author = 'AI Brain';
deck.subject = 'The user-approved subject';
deck.title = 'The presentation title';
deck.lang = 'ca-ES'; // use the requested language
deck.theme = { headFontFace: 'Liberation Sans', bodyFontFace: 'Liberation Sans', lang: 'ca-ES' };
const slide = deck.addSlide();
slide.background = { color: '162821' };
slide.addText('A concise title', { x: 0.7, y: 0.8, w: 11.8, h: 1.2,
  fontSize: 42, bold: true, color: 'FFFFFF', margin: 0 });
// Compose the actual slide; this snippet is only an API example, not a template.
// slide.addImage({ path: authorizedImage, ...deck.imageSizingCrop(authorizedImage, x, y, w, h) });
// slide.addChart(deck.ChartType.bar, [{ name: 'Series', labels: [...], values: [...] }], options);
await deck.writeFile({ fileName: '.aibrain-drafts/deck.pptx' });
```

Use a `.cjs` script with an async main function for the await above, or load the
bundle from ESM with `createRequire`. Dimensions are inches; wide slides are
13.333 × 7.5. Explicit text boxes need `x`, `y`, `w`, `h` and an appropriate font
size. Use `addText`, `addImage`, `addChart`, `addTable` and native objects to
make an editable deck. Use fresh options per object. Do not depend on runtime
npm, npx, pip, downloads or uninstalled libraries.

## Inspect before delivery

Create drafts, scripts, PDF exports and page renders inside `.aibrain-drafts/`
in the authorized project workspace. This directory is excluded from automatic
document delivery. Reading or listing any path never delivers a file. Never place an unfinished deck in `documents/`.

Call `aibrain_documents.render` with the project-relative draft path and a
one-based page number, for example:

```json
{"relativePath":".aibrain-drafts/deck.pptx","page":1}
```

When calling through `functions.exec`, this runtime returns dynamic-tool
content as a newline-separated string. Display the image with `image()`;
never serialize the whole result with `text()` or JSON.stringify, because that
prints megabytes of base64 instead of showing the slide. For example:

```js
const result = await tools.aibrain_documents__render({relativePath: ".aibrain-drafts/deck.pptx", page: 1});
const lines = String(result).split("\n");
const pageImage = lines.find(line => line.startsWith("data:image/png;base64,"));
if (!pageImage) throw new Error("Render did not return a page image");
text(lines[0]);
image(pageImage);
```

The server converts the verified source through its private document sandbox
and returns the requested page image, total page count, source SHA-256 and a
review PDF path in `.aibrain-drafts/`. Inspect that returned image, then call the
same tool for every remaining page. It supports up to 50 pages. Rendering is
technical verification; you must still inspect clipping, contrast, legibility,
empty pages, repetitive layout and unintended overlap against the brief.

Do not run LibreOffice, Poppler or their wrappers through shell. The agent's
nested command sandbox cannot initialize the converter's network namespace.
The document tool runs at the server boundary with the same private conversion
sandbox and no network access; it does not relax the agent sandbox.

If you change the source, render again and use only results with the new source
hash. Use the exact returned PDF path for the matching PDF delivery. Rendering
does not publish anything. If the tool fails, retain the draft and report the
specific limitation; do not substitute the basic text renderer or invent a link.

Only after review, copy the requested formats to distinct final paths under
`documents/`, then call `aibrain_documents.deliver` for each requested file:

```json
{"relativePath":"documents/presentation.pptx"}
```

Require a successful delivery result before announcing an attachment. Listing,
printing or linking a path never creates an attachment. The delivery tool
validates and persists an immutable private artifact. If both PDF and PowerPoint
were requested, deliver the PDF exported from that same reviewed PPTX. A PDF
request does not authorize substituting a PPTX or an A4 text report.

Creating a private requested chat artifact does not authorize publishing to an
external service. Keep all identity, source permissions and private artifact
checks intact.
