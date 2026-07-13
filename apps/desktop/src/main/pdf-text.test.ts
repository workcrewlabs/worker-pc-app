import { describe, expect, it } from "vitest";
import { extractPdfText, looksLikeText } from "./pdf-text";

// A tiny but valid-enough PDF carrying a text layer. pdf.js recovers the object
// offsets, so an explicit xref table is not needed for the test. The shown text
// must not contain parentheses (they delimit a PDF literal string).
function textPdf(show: string): Buffer {
  const content = `BT /F1 24 Tf 20 100 Td (${show}) Tj ET`;
  const body =
    "%PDF-1.4\n" +
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>endobj\n" +
    `4 0 obj<</Length ${content.length}>>stream\n${content}\nendstream\nendobj\n` +
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n" +
    "trailer<</Root 1 0 R>>\n%%EOF";
  return Buffer.from(body, "latin1");
}

describe("extractPdfText", () => {
  it("reads the text layer of a PDF", async () => {
    const text = await extractPdfText(textPdf("WorkCrew Invoice Report"));
    expect(text).toContain("WorkCrew Invoice Report");
  });

  it("returns text good enough to send in place of the file", async () => {
    const text = await extractPdfText(textPdf("Acme Ltd total due 1200 dollars"));
    expect(looksLikeText(text)).toBe(true);
  });
});

describe("looksLikeText", () => {
  it("accepts real extracted text", () => {
    expect(looksLikeText("Invoice 001 Acme Ltd $1200.00 2026-07-01")).toBe(true);
  });

  it("rejects empty, whitespace, or too-short output (a scan)", () => {
    expect(looksLikeText("")).toBe(false);
    expect(looksLikeText("  \n ")).toBe(false);
    expect(looksLikeText("hi")).toBe(false);
  });
});
