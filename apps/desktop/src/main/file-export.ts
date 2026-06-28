import JSZip from "jszip";

// Turn content the chat model produced into a real downloadable file, the way
// Claude cowork hands you an artifact. The model writes the data as plain text
// (comma-separated rows for a spreadsheet, paragraphs for a document); this
// module converts it into the real file format the user asked for. Office files
// are just ZIP archives of XML, so xlsx and docx are built here with JSZip (no
// new dependency) rather than driving Excel or Word on the user's machine.

// The file types WorkCrew can hand back. Everything else is rejected so the save
// path can never be coerced into writing an unexpected format. xlsx/docx are
// generated from text; the rest are written as-is with the right extension.
export const EXPORT_EXTENSIONS = ["xlsx", "docx", "csv", "txt", "md", "json", "html"] as const;
export type ExportExtension = (typeof EXPORT_EXTENSIONS)[number];

export function isExportExtension(value: string): value is ExportExtension {
  return (EXPORT_EXTENSIONS as readonly string[]).includes(value);
}

// Escape the five XML-significant characters so arbitrary cell or paragraph text
// can never break out of the document and inject markup.
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// A cell holds a real number only when it is a plain integer or decimal with no
// leading zeros (so "007", "01/02", and phone numbers stay text). Everything
// else is written as a string so the spreadsheet shows exactly what was typed.
function isNumeric(value: string): boolean {
  return /^-?(0|[1-9]\d*)(\.\d+)?$/.test(value);
}

/**
 * Parse comma-separated text into a grid of rows and cells. Handles quoted
 * fields (with doubled quotes for a literal quote), commas and newlines inside
 * quotes, and both LF and CRLF line endings. A trailing newline does not add an
 * empty row. Pure and unit tested.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let started = false;

  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    started = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      pushField();
    } else if (ch === "\n") {
      pushRow();
    } else if (ch === "\r") {
      // Swallow CR; the following LF (if any) closes the row.
      if (text[i + 1] !== "\n") pushRow();
    } else {
      field += ch;
    }
  }
  // Flush the final field/row unless the input ended exactly on a row break.
  if (started && (field.length > 0 || row.length > 0)) pushRow();
  return rows;
}

// Convert a zero-based column index to its spreadsheet letters (0 -> A, 26 -> AA).
function columnName(index: number): string {
  let n = index;
  let name = "";
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

/**
 * Build a real .xlsx workbook from a grid of cells. Strings go through the
 * shared-strings table (the same part the reader extracts text from), numbers
 * are written as numeric cells. Returns the packaged bytes.
 */
export async function buildXlsx(rows: string[][]): Promise<Buffer> {
  // Shared strings, de-duplicated in first-seen order.
  const sharedIndex = new Map<string, number>();
  const sharedList: string[] = [];
  let stringCellCount = 0;
  const internString = (value: string): number => {
    stringCellCount += 1;
    const existing = sharedIndex.get(value);
    if (existing !== undefined) return existing;
    const index = sharedList.length;
    sharedIndex.set(value, index);
    sharedList.push(value);
    return index;
  };

  const sheetRows: string[] = [];
  rows.forEach((cells, rowIndex) => {
    const cellXml: string[] = [];
    cells.forEach((value, colIndex) => {
      const ref = `${columnName(colIndex)}${rowIndex + 1}`;
      if (value === "") return; // empty cell: omit entirely
      if (isNumeric(value)) {
        cellXml.push(`<c r="${ref}"><v>${value}</v></c>`);
      } else {
        cellXml.push(`<c r="${ref}" t="s"><v>${internString(value)}</v></c>`);
      }
    });
    sheetRows.push(`<row r="${rowIndex + 1}">${cellXml.join("")}</row>`);
  });

  const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const contentTypes =
    `${header}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
    `</Types>`;
  const rootRels =
    `${header}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;
  const workbook =
    `${header}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels =
    `${header}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    `</Relationships>`;
  const sheet =
    `${header}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${sheetRows.join("")}</sheetData></worksheet>`;
  const sharedStrings =
    `${header}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `count="${stringCellCount}" uniqueCount="${sharedList.length}">` +
    sharedList.map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`).join("") +
    `</sst>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", rootRels);
  zip.file("xl/workbook.xml", workbook);
  zip.file("xl/_rels/workbook.xml.rels", workbookRels);
  zip.file("xl/worksheets/sheet1.xml", sheet);
  zip.file("xl/sharedStrings.xml", sharedStrings);
  return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
}

/**
 * Build a real .docx document from plain text, one paragraph per line. Returns
 * the packaged bytes.
 */
export async function buildDocx(text: string): Promise<Buffer> {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const paragraphs = lines
    .map((line) =>
      line.length > 0
        ? `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`
        : `<w:p/>`
    )
    .join("");

  const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const contentTypes =
    `${header}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`;
  const rootRels =
    `${header}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;
  const document =
    `${header}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${paragraphs}<w:sectPr/></w:body></w:document>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", rootRels);
  zip.file("word/document.xml", document);
  return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
}

/**
 * Generate the bytes for a downloadable file from the model's text content.
 * Spreadsheet and document formats are converted; text formats are written
 * verbatim as UTF-8. Throws on an unsupported extension.
 */
export async function generateExport(ext: ExportExtension, content: string): Promise<Buffer> {
  if (ext === "xlsx") return buildXlsx(parseCsv(content));
  if (ext === "docx") return buildDocx(content);
  // csv, txt, md, json, html are plain text written exactly as produced.
  return Buffer.from(content, "utf8");
}

/**
 * Make a safe default filename for the save dialog: strip any directory parts,
 * keep only friendly characters, bound the length, and guarantee it ends in the
 * chosen extension. The user still picks the final location in the OS dialog.
 */
export function sanitizeExportName(name: string, ext: ExportExtension): string {
  const base = (name.split(/[\\/]/).pop() ?? "").trim();
  // Drop a trailing extension (any) so we can append the canonical one.
  const withoutExt = base.replace(/\.[A-Za-z0-9]{1,8}$/, "");
  const cleaned = withoutExt.replace(/[^A-Za-z0-9 _.-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  const safe = cleaned.length > 0 ? cleaned : "workcrew-file";
  return `${safe}.${ext}`;
}
