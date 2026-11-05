import JSZip from "jszip";
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { validateUploadedDocument } from "@/documents/upload-validation";
import { generateLocalDocument } from "@/runtime/documents/local-document-generator";
import { generatedPngFixture } from "../../../tests/helpers/png-fixture";

describe("local document generator", () => {
  it("keeps arrow direction and conversion meaning in the actual basic PDF text stream", async () => {
    const generated = await generateLocalDocument({ format: "pdf", title: "A → B", content: "toneladas → kg\nOrigen ← Destino\nA ↔ B\n2 × 3 = 6 €; condición confirmada" });
    const document = await PDFDocument.load(generated.data);
    const stream = document.getPage(0).node.lookup(PDFName.of("Contents"));
    if (!(stream instanceof PDFRawStream)) throw new Error("Expected actual PDF content stream.");
    const text = new TextDecoder("windows-1252").decode(stream.getContents());
    expect(text).toContain("A -> B");
    expect(text).toContain("toneladas -> kg");
    expect(text).toContain("Origen <- Destino");
    expect(text).toContain("A <-> B");
    expect(text).toContain("2 × 3 = 6 €; condición confirmada");
    expect(text).not.toContain("?");
  });
  it("normalizes accents and retains literal questions and arrows in structured PDF slides", async () => {
    const generated = await generateLocalDocument({ format: "pdf", title: "Summary", content: "Description", slides: [
      { title: "A → B", body: "toneladas → kg\ncondicio\u0301n\n¿Dato confirmado?" },
    ] });
    const document = await PDFDocument.load(generated.data);
    const stream = document.getPage(0).node.lookup(PDFName.of("Contents"));
    if (!(stream instanceof PDFRawStream)) throw new Error("Expected actual PDF content stream.");
    const text = new TextDecoder("windows-1252").decode(stream.getContents());
    expect(text).toContain("A -> B");
    expect(text).toContain("toneladas -> kg");
    expect(text).toContain("condición");
    expect(text).toContain("¿Dato confirmado?");
    expect(document.getPageCount()).toBe(1);
  });
  it.each(["漢", "🙂", "\u0001"])("rejects an unsupported PDF character instead of manufacturing a question mark: %s", async symbol => {
    await expect(generateLocalDocument({ format: "pdf", title: "Report", content: `Source ${symbol} result` }))
      .rejects.toMatchObject({ code: "LOCAL_DOCUMENT_PDF_TEXT_UNSUPPORTED" });
  });
  it("prints schedule names and split shifts with wrapping, generous rows and repeated weekly headings", async () => {
    const generated = await generateLocalDocument({ format: "xlsx", title: "Palamós · 2026-W16", content: "Esborrany. Revisar abans de publicar.", spreadsheetLayout: "schedule", rows: [
      ["Persona", "Dl", "Dt", "Dc", "Dj", "Dv", "Ds", "Dg", "Hores"],
      ["Persona amb dos cognoms llargs", ...Array(7).fill("08:00–14:00 Obrador / 17:00–20:00 Botiga"), 40],
    ] });
    const archive = await JSZip.loadAsync(generated.data);
    const sheet = await archive.file("xl/worksheets/sheet1.xml")!.async("text");
    expect(sheet).toContain('width="30"');
    expect(sheet).toContain('orientation="landscape"');
    expect(sheet).toContain('fitToHeight="0"');
    expect(sheet).toContain('ht="54"');
    expect(sheet).toContain("Persona amb dos cognoms llargs");
    expect(sheet).toContain("17:00–20:00 Botiga");
    expect(sheet).toContain('r="I2" s="0"><v>40</v>');
    expect(await archive.file("xl/styles.xml")!.async("text")).toContain('wrapText="1"');
    expect(await archive.file("xl/workbook.xml")!.async("text")).toContain("_xlnm.Print_Titles");
  });

  it.each([
    ["pdf", "Informe local", "Resumen\nContenido comprobable"],
    ["docx", "Documento local", "# Resumen\nContenido comprobable"],
    ["pptx", "Presentación local", "Primera diapositiva\n- Punto uno\n---\nSegunda diapositiva\n- Punto dos"],
    ["xlsx", "Datos locales", "Nombre\tImporte\nServicio\t1250"],
  ] as const)("creates a non-empty, validated %s", async (format, title, content) => {
    const generated = await generateLocalDocument({ format, title, content });

    expect(generated.data.length).toBeGreaterThan(100);
    expect(generated.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(validateUploadedDocument({
      fileName: `resultado.${format}`,
      declaredMimeType: generated.mimeType,
      data: generated.data,
    })).toMatchObject({ kind: format, size: generated.data.length, sha256: generated.sha256 });
  });

  it("preserves real content in each Office package", async () => {
    const docx = await generateLocalDocument({ format: "docx", title: "Informe Arnall", content: "Margen verificado" });
    const xlsx = await generateLocalDocument({
      format: "xlsx",
      title: "Ventas Arnall",
      content: "Tabla de ventas",
      rows: [["Producto", "Importe"], ["Servicio", 1250]],
    });
    const pptx = await generateLocalDocument({ format: "pptx", title: "Propuesta Arnall", content: "Objetivo\nImpacto medible" });
    const [docxZip, xlsxZip, pptxZip] = await Promise.all([
      JSZip.loadAsync(docx.data),
      JSZip.loadAsync(xlsx.data),
      JSZip.loadAsync(pptx.data),
    ]);

    await expect(docxZip.file("word/document.xml")!.async("text")).resolves.toContain("Margen verificado");
    await expect(xlsxZip.file("xl/worksheets/sheet1.xml")!.async("text")).resolves.toContain("1250");
    await expect(pptxZip.file("ppt/slides/slide1.xml")!.async("text")).resolves.toContain("Impacto medible");
  });

  it("renders authored slides as matching multi-page PDF and PowerPoint without copying the brief", async () => {
    const slides = [
      { title: "Objectiu", body: "Reduir el temps de preparació de les comandes." },
      { title: "Execució", body: "Agrupar les comandes per ruta.\nRevisar incidències cada matí." },
      { title: "Seguiment", body: "Mesurar el temps per comanda setmanalment." },
    ];
    const brief = "Create a presentation about operations";
    const pptx = await generateLocalDocument({ format: "pptx", title: "Operacions", content: brief, slides });
    const archive = await JSZip.loadAsync(pptx.data);
    expect(pptx.pages).toBe(3);
    expect(Object.keys(archive.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))).toHaveLength(3);
    for (const [index, slide] of slides.entries()) {
      const text = await archive.file(`ppt/slides/slide${index + 1}.xml`)!.async("text");
      expect(text).toContain(slide.title);
      expect(Array.from(text.matchAll(/<a:t>(.*?)<\/a:t>/gu), (match) => match[1]).join(" ")).toContain(slide.body.replaceAll("\n", " "));
      expect(text).not.toContain(brief);
    }
    const pdf = await generateLocalDocument({ format: "pdf", title: "Operacions", content: brief, slides });
    const document = await PDFDocument.load(pdf.data);
    expect(pdf.pages).toBe(3);
    expect(document.getPages()).toHaveLength(3);
    for (const page of document.getPages()) {
      expect(page.getWidth() / page.getHeight()).toBeCloseTo(16 / 9);
    }
    expect(pdf.data.toString("latin1")).toContain("Agrupar les comandes per ruta.");
    expect(pdf.data.toString("latin1")).not.toContain(brief);
  });

  it.each(["pdf", "pptx"] as const)("rejects dense authored %s slides without silently changing the slide count", async (format) => {
    const body = Array.from({ length: 13 }, (_, index) => `Indicador ${index + 1}`).join("\n");
    await expect(generateLocalDocument({ format, title: "Seguiment", content: "Summary", slides: [{ title: "Resultats", body }] }))
      .rejects.toMatchObject({ code: "LOCAL_DOCUMENT_SLIDE_OVERFLOW" });
  });

  it("rejects legacy overflow while retaining explicit section boundaries for short decks", async () => {
    const content = "Seguiment\n" + Array.from({ length: 30 }, (_, index) => `Indicador ${index + 1}`).join("\n");
    await expect(generateLocalDocument({ format: "pptx", title: "Seguiment", content }))
      .rejects.toMatchObject({ code: "LOCAL_DOCUMENT_SLIDE_OVERFLOW" });
    const result = await generateLocalDocument({ format: "pptx", title: "Seguiment", content: "Objectiu\nReduir incidències.\n---\nMesura\nRevisió setmanal." });
    expect(result.pages).toBe(2);
    const archive = await JSZip.loadAsync(result.data);
    expect(await archive.file("ppt/slides/slide2.xml")!.async("text")).toContain("Revisió setmanal.");
    await expect(generateLocalDocument({ format: "pptx", title: "Too many", content: Array.from({ length: 51 }, () => "Title\nBody").join("\n---\n") }))
      .rejects.toMatchObject({ code: "LOCAL_DOCUMENT_SLIDES_INVALID" });
  });

  it("rejects malformed structured slides and slides for non-presentation formats", async () => {
    await expect(generateLocalDocument({ format: "pdf", title: "Deck", content: "Summary", slides: [] }))
      .rejects.toMatchObject({ code: "LOCAL_DOCUMENT_SLIDES_INVALID" });
    await expect(generateLocalDocument({ format: "pptx", title: "Deck", content: "Summary", slides: [{ title: "x".repeat(81), body: "Body" }] }))
      .rejects.toMatchObject({ code: "LOCAL_DOCUMENT_SLIDES_INVALID" });
    await expect(generateLocalDocument({ format: "docx", title: "Deck", content: "Summary", slides: [{ title: "Heading", body: "Body" }] }))
      .rejects.toMatchObject({ code: "LOCAL_DOCUMENT_SLIDES_INVALID" });
  });

  it("writes explicit numeric formulas while leaving formula-looking text inert", async () => {
    const generated = await generateLocalDocument({ format: "xlsx", title: "Formula regression", content: "10 plus 20",
      rows: [["Values"], [10], [20], [{ formula: "SUM(A2:A3)" }], ["=SUM(A2:A3)"], ["=WEBSERVICE(\"https://example.test\")"]] });
    const archive = await JSZip.loadAsync(generated.data);
    const sheet = await archive.file("xl/worksheets/sheet1.xml")!.async("text");
    expect(sheet).toContain('<c r="A4"><f>SUM(A2:A3)</f></c>');
    expect(sheet).toContain('<c r="A5" t="inlineStr"><is><t xml:space="preserve">=SUM(A2:A3)</t>');
    expect(sheet).toContain('=WEBSERVICE(&quot;https://example.test&quot;)');
    expect(await archive.file("xl/workbook.xml")!.async("text")).toContain('fullCalcOnLoad="1"');
  });

  it("keeps literal text inside generic spreadsheet columns for whole-sheet PDF export", async () => {
    const literal = "=SUM(A2:A3)";
    const generated = await generateLocalDocument({ format: "xlsx", title: "Readable columns", content: "Literal text",
      rows: [["Values", "Notes"], [literal, "x".repeat(300)], [null, 42]] });
    const archive = await JSZip.loadAsync(generated.data);
    const sheet = await archive.file("xl/worksheets/sheet1.xml")!.async("text");
    const columns = [...sheet.matchAll(/<col min="(\d+)" max="\d+" width="([\d.]+)" customWidth="1"\/>/gu)];
    expect(columns.map(column => Number(column[1]))).toEqual([1, 2]);
    expect(Number(columns[0][2])).toBeGreaterThan(literal.length);
    expect(Number(columns[1][2])).toBeGreaterThan(Number(columns[0][2]));
    expect(Number(columns[1][2])).toBeLessThanOrEqual(255);
    expect(sheet).toContain(`<c r="A2" t="inlineStr"><is><t xml:space="preserve">${literal}</t>`);
    expect(sheet).not.toContain("<f>");
  });

  it.each(['WEBSERVICE("https://example.test")', '[external.xlsx]Sheet1!A1', "cmd|' /C calc'!A0", 'HYPERLINK("https://example.test")'])
    ("rejects an explicit non-local formula %s", async (formula) => {
      await expect(generateLocalDocument({ format: "xlsx", title: "Rejected", content: "Data", rows: [[{ formula }]] }))
        .rejects.toMatchObject({ code: "LOCAL_DOCUMENT_ROWS_INVALID" });
    });

  it("embeds the PNG itself on one A4 PDF page without a text layer", async () => {
    const generated = await generateLocalDocument({
      format: "pdf",
      title: "Imagen generada",
      content: "Esta descripción no debe convertirse en contenido del PDF.",
      sourcePng: generatedPngFixture(80, 60),
    });
    const document = await PDFDocument.load(generated.data);
    const pages = document.getPages();
    const resources = pages[0]!.node.Resources()!;
    const xObjects = document.context.lookup(resources.get(PDFName.of("XObject")), PDFDict);
    const fonts = document.context.lookup(resources.get(PDFName.of("Font")), PDFDict);

    expect(generated.pages).toBe(1);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.getWidth()).toBeCloseTo(595.28, 2);
    expect(pages[0]!.getHeight()).toBeCloseTo(841.89, 2);
    expect(xObjects.keys().length).toBeGreaterThan(0);
    expect(fonts.keys()).toHaveLength(0);
    expect(generated.data.includes(Buffer.from("Esta descripción"))).toBe(false);
  });

  it("rejects empty output requests and malformed spreadsheet data", async () => {
    await expect(generateLocalDocument({ format: "pdf", title: "Informe", content: "" })).rejects.toMatchObject({
      code: "LOCAL_DOCUMENT_INPUT_INVALID",
    });
    await expect(generateLocalDocument({
      format: "xlsx",
      title: "Informe",
      content: "Datos",
      rows: [[Number.NaN]],
    })).rejects.toMatchObject({ code: "LOCAL_DOCUMENT_ROWS_INVALID" });
    await expect(generateLocalDocument({
      format: "pdf",
      title: "Imagen",
      content: "",
      sourcePng: Buffer.from("not-a-png"),
    })).rejects.toMatchObject({ code: "LOCAL_DOCUMENT_SOURCE_IMAGE_INVALID" });
  });
});
