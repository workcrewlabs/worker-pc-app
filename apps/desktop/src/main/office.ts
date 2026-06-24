import JSZip from "jszip";

// Read Word/Excel/PowerPoint files locally and pull out their text, the way
// Claude Code does with the Office skills: the binary never leaves the machine,
// only the extracted text is sent on. Office files are ZIP archives of XML; the
// readable text lives in elements whose local name is "t" (Word <w:t>, PowerPoint
// <a:t>, Excel shared-string <t>), with paragraphs/rows ending at <w:p>/<a:p>/<si>.

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, code: string) => {
    if (code.startsWith("#")) {
      const value = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : whole;
    }
    return NAMED_ENTITIES[code] ?? whole;
  });
}

/**
 * Extract readable text from one Office XML part: the contents of every element
 * whose local name is "t" (namespace prefix ignored), in document order, with a
 * line break wherever a paragraph or row element closes. Pure and unit tested.
 */
export function extractOfficeXmlText(xml: string): string {
  // Match either a text node <ns:t ...>...</ns:t> or a closing block tag.
  const token = /<(?:[\w]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[\w]+:)?t>|<\/(?:[\w]+:)?(p|si|tr)>/g;
  let out = "";
  let match: RegExpExecArray | null;
  while ((match = token.exec(xml)) !== null) {
    if (match[1] !== undefined) out += decodeEntities(match[1]);
    else out += "\n";
  }
  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

function slideNumber(name: string): number {
  const match = /slide(\d+)\.xml$/.exec(name);
  return match ? parseInt(match[1] as string, 10) : 0;
}

/**
 * Extract the text of a docx/xlsx/pptx file from its bytes, locally. Returns an
 * empty string if there is nothing readable (the caller treats that as an error).
 */
export async function extractOfficeText(ext: string, buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const parts: string[] = [];

  if (ext === "docx") {
    const document = zip.file("word/document.xml");
    if (document) parts.push(extractOfficeXmlText(await document.async("string")));
  } else if (ext === "pptx") {
    const slides = zip.file(/^ppt\/slides\/slide\d+\.xml$/);
    slides.sort((a, b) => slideNumber(a.name) - slideNumber(b.name));
    for (const slide of slides) parts.push(extractOfficeXmlText(await slide.async("string")));
  } else if (ext === "xlsx") {
    // Shared strings hold the text of all string cells; this gives the model the
    // spreadsheet's text content (not the full grid layout).
    const shared = zip.file("xl/sharedStrings.xml");
    if (shared) parts.push(extractOfficeXmlText(await shared.async("string")));
  }

  return parts.filter((part) => part.length > 0).join("\n\n").trim();
}
