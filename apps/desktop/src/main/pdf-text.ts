import { createRequire } from "node:module";

// Read a PDF's text locally with Mozilla's PDF.js (the same engine browsers use),
// the way the Office reader (office.ts) handles Word and Excel: the file's bytes
// never leave the machine, only the extracted text is sent on. This keeps
// attaching a PDF instant (a few kilobytes of text instead of a multi-megabyte
// upload) and correctly reads the embedded subset fonts that real invoicing and
// accounting software produce, which a naive byte scan gets wrong. A scanned,
// image-only PDF has no text layer and yields nothing; the caller then falls back
// to sending the bytes for the model to read the pages natively.

const require = createRequire(import.meta.url);

// Minimal shape of the pdf.js API we use, so the untyped legacy build is safe.
type PdfjsModule = {
  getDocument: (opts: unknown) => { promise: Promise<PdfDocument> };
  GlobalWorkerOptions: { workerSrc: string };
};
type PdfDocument = {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
  destroy: () => Promise<void>;
};
type PdfTextItem = { str?: string; hasEOL?: boolean };
type PdfPage = { getTextContent: () => Promise<{ items: PdfTextItem[] }> };

// pdf.js is loaded lazily (only when a PDF is actually attached) and once, so it
// never slows app startup. The legacy build is the CommonJS bundle that runs in
// Electron's Node (main) process.
let pdfjs: PdfjsModule | null = null;
function loadPdfjs(): PdfjsModule {
  if (!pdfjs) {
    const mod = require("pdfjs-dist/legacy/build/pdf.js") as PdfjsModule;
    // Point the worker at the installed file so extraction resolves it the same
    // way in the dev tree and in the packaged app, with no network fetch.
    mod.GlobalWorkerOptions.workerSrc = require.resolve("pdfjs-dist/legacy/build/pdf.worker.js");
    pdfjs = mod;
  }
  return pdfjs;
}

// Bound the returned text; the backend truncates too, but keep the payload small.
const MAX_OUTPUT_CHARS = 200_000;

/**
 * Extract readable text from a PDF's bytes, locally. Returns an empty string when
 * there is no text layer (a scanned image PDF), which the caller treats as a
 * signal to send the bytes instead.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const { getDocument } = loadPdfjs();
  const doc = await getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: false,
    // Surface only real errors, not the routine per-font encoding warnings.
    verbosity: 0
  }).promise;
  try {
    const lines: string[] = [];
    let line = "";
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      for (const item of content.items) {
        line += item.str ?? "";
        if (item.hasEOL) { lines.push(line); line = ""; }
        else line += " ";
      }
      if (line) { lines.push(line); line = ""; }
      lines.push(""); // blank line between pages
      if (lines.join("\n").length > MAX_OUTPUT_CHARS) break;
    }
    const text = lines.join("\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) : text;
  } finally {
    await doc.destroy().catch(() => {});
  }
}

/**
 * Whether extracted text is good enough to send in place of the file: enough of
 * it, mostly printable, and containing real words. Near-empty output from a scan,
 * or rare garble, fails this check so the caller falls back to sending the bytes
 * for the model to read the PDF natively. Pure and unit tested.
 */
export function looksLikeText(text: string): boolean {
  const t = text.trim();
  if (t.length < 16) return false;
  let readable = 0;
  for (const ch of t) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126) || (code >= 160 && code <= 255)) {
      readable += 1;
    }
  }
  return readable / t.length > 0.85 && /[A-Za-z]{3,}/.test(t);
}
