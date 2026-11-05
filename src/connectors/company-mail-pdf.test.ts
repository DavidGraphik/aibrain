import { describe, expect, it } from "vitest";
import { mailInvoiceReadingContents } from "./company-mail-pdf";
const pdf = Buffer.from("%PDF-1.7\npassive fixture\n%%EOF");
const headers = `content-type: application/pdf\\ncontent-length: ${pdf.length}\\n`;
describe("supplier PDF reading envelope", () => {
  it("extracts a bounded verified PDF body while keeping the original intact", () => {
    const original = Buffer.concat([Buffer.from(headers), pdf]);
    const before = Buffer.from(original);
    expect(mailInvoiceReadingContents(original, "application/pdf")).toEqual(pdf);
    expect(original).toEqual(before);
    expect(mailInvoiceReadingContents(pdf, "application/pdf")).toBe(pdf);
    expect(mailInvoiceReadingContents(Buffer.concat([Buffer.from(headers.replaceAll("\\n", "\r\n")), pdf]), "application/pdf")).toEqual(pdf);
  });
  it("refuses HTML, incorrect lengths, duplicate headers and unrelated formats", () => {
    for (const prefix of ["<script>bad()</script>", headers.replace(String(pdf.length), "1"), headers + "content-type: application/pdf\\n", "x-unknown: value\\n" + headers, "etag: " + "x".repeat(1024) + "\\n" + headers]) {
      const original = Buffer.concat([Buffer.from(prefix), pdf]);
      expect(mailInvoiceReadingContents(original, "application/pdf")).toBe(original);
    }
    const wrong = Buffer.concat([Buffer.from(headers), pdf]);
    expect(mailInvoiceReadingContents(wrong, "text/html")).toBe(wrong);
  });
});
