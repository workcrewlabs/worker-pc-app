import JSZip from "jszip";

// Turn content the chat model produced into a real downloadable file, the way
// Claude cowork hands you an artifact. The model writes the data as plain text
// (comma-separated rows for a spreadsheet, paragraphs for a document); this
// module converts it into the real file format the user asked for. Office files
// are just ZIP archives of XML, so xlsx and docx are built here with JSZip (no
// new dependency) rather than driving Excel or Word on the user's machine.

// The downloadable formats and the save contract live in one shared module so
// the exporter, the IPC bridge, and the renderer cannot drift. Re-exported here
// so existing imports from this module keep working. xlsx/docx are generated from
// text; the rest are written as-is with the right extension.
export { EXPORT_EXTENSIONS, isExportExtension, type ExportExtension } from "../shared/export-formats.js";
import type { ExportExtension } from "../shared/export-formats.js";

// Drop characters XML 1.0 forbids (most control codes, lone surrogates). Without
// this, a copied log line or binary fragment in a cell or paragraph would produce
// a malformed part that Excel or Word refuses to open. Tab, newline, and carriage
// return are kept because they are the only legal control characters.
function stripInvalidXmlChars(text: string): string {
  return Array.from(text)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return (
        code === 0x9 ||
        code === 0xa ||
        code === 0xd ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff)
      );
    })
    .join("");
}

// Escape the five XML-significant characters so arbitrary cell or paragraph text
// can never break out of the document and inject markup, after dropping any
// characters XML does not permit at all.
function escapeXml(text: string): string {
  return stripInvalidXmlChars(text)
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

// Excel stores dates as a serial day count from 1899-12-30. Returns null for an
// out-of-range date so a bad value stays as text.
function excelDateSerial(year: number, month: number, day: number): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const serial = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86_400_000);
  return serial > 0 ? serial : null;
}

// Classify a non-plain cell into a real number plus the style index that displays
// it correctly: 2 currency ("$1,200.50"), 4 thousands integer ("1,200"), 5 percent
// ("15%"), 3 date ("2026-07-08" or "7/8/2026"). Returns null to keep it as text.
// This is what makes a plain CSV render as a polished, sortable sheet.
function numericCell(value: string): { value: string; style: number } | null {
  const v = value.trim();
  const percent = /^(-?\d+(?:\.\d+)?)%$/.exec(v);
  if (percent) return { value: String(Number(percent[1]) / 100), style: 5 };
  // Grouped digits must be genuine thousands grouping (1-3 digits, then commas
  // every 3), so a value like "555,12" stays text instead of being mangled.
  const GROUPED = /^\d{1,3}(?:,\d{3})*(?:\.\d+)?$/;
  const currency = /^(-?)\$\s?([\d,.]+)$/.exec(v);
  if (currency && GROUPED.test(currency[2] ?? "")) {
    return { value: `${currency[1]}${(currency[2] ?? "").replace(/,/g, "")}`, style: 2 };
  }
  if (v.includes(",")) {
    const grouped = /^(-?)([\d,.]+)$/.exec(v);
    if (grouped && GROUPED.test(grouped[2] ?? "")) {
      return { value: `${grouped[1]}${(grouped[2] ?? "").replace(/,/g, "")}`, style: 4 };
    }
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (iso) {
    const serial = excelDateSerial(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (serial != null) return { value: String(serial), style: 3 };
  }
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (mdy) {
    const serial = excelDateSerial(Number(mdy[3]), Number(mdy[1]), Number(mdy[2]));
    if (serial != null) return { value: String(serial), style: 3 };
  }
  return null;
}

/**
 * Build a real, polished .xlsx workbook from a grid of cells: a bold frozen header
 * row, columns sized to their content, and currency/thousands/percent/date values
 * written as real numbers with the matching display format (not left-aligned
 * text). Strings go through the shared-strings table. Returns the packaged bytes.
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

  // Per-column display width, from the longest content seen (header included),
  // clamped so one long cell cannot blow a column out.
  const columnWidths: number[] = [];
  const noteWidth = (colIndex: number, text: string): void => {
    const width = Math.min(48, Math.max(9, text.length + 2.5));
    if (width > (columnWidths[colIndex] ?? 0)) columnWidths[colIndex] = width;
  };

  const sheetRows: string[] = [];
  rows.forEach((cells, rowIndex) => {
    const isHeader = rowIndex === 0 && rows.length > 1;
    const cellXml: string[] = [];
    cells.forEach((value, colIndex) => {
      const ref = `${columnName(colIndex)}${rowIndex + 1}`;
      if (value === "") return; // empty cell: omit entirely
      noteWidth(colIndex, value);
      if (isHeader) {
        // The first row is the column headers: always text, always bold (style 1).
        cellXml.push(`<c r="${ref}" s="1" t="s"><v>${internString(value)}</v></c>`);
        return;
      }
      if (isNumeric(value)) {
        cellXml.push(`<c r="${ref}"><v>${value}</v></c>`);
        return;
      }
      // Currency, grouped numbers, percentages, and dates become real typed
      // numbers with the right display format, so they align, sort, and sum
      // like a hand-made spreadsheet instead of reading as plain text.
      const typed = numericCell(value);
      if (typed) {
        cellXml.push(`<c r="${ref}" s="${typed.style}"><v>${typed.value}</v></c>`);
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
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
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
    `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;
  // Freeze the header row (when there is one) and size each column to fit. OOXML
  // requires child order: sheetViews, then cols, then sheetData.
  const hasHeader = rows.length > 1;
  const frozenPane = hasHeader
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen" activePane="bottomLeft"/></sheetView></sheetViews>`
    : "";
  const cols = columnWidths.length > 0
    ? `<cols>${columnWidths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const sheet =
    `${header}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `${frozenPane}${cols}<sheetData>${sheetRows.join("")}</sheetData></worksheet>`;
  // The style table behind the s= indexes used above: 0 default, 1 bold header,
  // 2 currency, 3 date, 4 thousands-grouped number, 5 percent. Number formats use
  // Excel's builtin ids so every spreadsheet app renders them natively.
  const styles =
    `${header}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>` +
    `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="6">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `</cellXfs></styleSheet>`;
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
  zip.file("xl/styles.xml", styles);
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
  const candidate = cleaned.length > 0 ? cleaned : "workcrew-file";
  // Windows reserved device names (CON, PRN, NUL, COM1-9, LPT1-9) are not valid
  // file basenames; prefix them so the Save dialog defaults to a writable name.
  const safe = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(candidate) ? `workcrew-file-${candidate}` : candidate;
  return `${safe}.${ext}`;
}
