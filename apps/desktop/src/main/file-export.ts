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
  // A plain number, with or without thousands separators (so "$1200.50",
  // "$500.00", and "$1,200.50" all read as currency).
  const NUMBER_OR_GROUPED = /^(?:\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?)$/;
  const currency = /^(-?)\$\s?([\d,.]+)$/.exec(v);
  if (currency && NUMBER_OR_GROUPED.test(currency[2] ?? "")) {
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
 * Build a real, polished .xlsx workbook from a grid of cells. Produces a colored
 * bold frozen header, columns sized to their content, and currency / thousands /
 * percent / date values written as real numbers with the matching display format.
 * Formula cells (a leading "=") are written as real Excel formulas and inherit the
 * number format of their column, which is learned from the column's typed values,
 * from its header (a "%" header makes the whole column a percentage), or, for a
 * column that is only formulas, from the currency of the cells its formulas
 * reference (so a "Total" column that only sums money columns is money too). A
 * first row that is a single cell above a multi-column table becomes a merged
 * title, and a row whose first cell is "Total" or "Grand Total" is emphasized.
 * Strings go through the shared-strings table. Returns the packaged bytes.
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

  const nonEmpty = (cells: string[] | undefined): number =>
    (cells ?? []).filter((c) => c.trim() !== "").length;

  // A single-cell first row sitting above a real (multi-column) table is a title,
  // not a header. When present it occupies row 1, the header moves to row 2, and
  // the first data row is row 3 (the model is told to number its formulas to match).
  const hasTitle = rows.length >= 3 && nonEmpty(rows[0]) === 1 && nonEmpty(rows[1]) >= 2;
  const headerRowIndex = hasTitle ? 1 : 0;
  const firstDataRowIndex = headerRowIndex + 1;
  const hasHeaderRow = rows.length > firstDataRowIndex;

  // Column count across the header and data rows (the title spans them, so it is
  // excluded from the count and from the column widths).
  let colCount = 0;
  rows.forEach((cells, rowIndex) => {
    if (hasTitle && rowIndex === 0) return;
    colCount = Math.max(colCount, cells.length);
  });

  // Convert spreadsheet column letters to a zero-based index (A -> 0, AA -> 26).
  const columnLetterToIndex = (letters: string): number => {
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };

  // Per-column number-format style (2 currency, 4 thousands, 5 percent), used both
  // for the column's own typed values and for any formula written into it. Learned
  // in three steps, most explicit first, so an all-formula column still formats.
  const columnNumericStyle: number[] = [];
  const headerRow = rows[headerRowIndex] ?? [];
  // 1) A header naming a percentage makes the whole column a percentage, so a ratio
  //    formula like =B3/B8 shows as 42.8% instead of a bare 0.428.
  const PERCENT_HEADER = /%|\bpercent\b|\bpct\b/i;
  headerRow.forEach((text, colIndex) => {
    if (PERCENT_HEADER.test(text)) columnNumericStyle[colIndex] = 5;
  });
  // 2) A typed currency / thousands / percent value fixes the column's format.
  for (let r = firstDataRowIndex; r < rows.length; r += 1) {
    (rows[r] ?? []).forEach((value, colIndex) => {
      if (columnNumericStyle[colIndex]) return;
      const v = value.trim();
      if (v === "" || v.startsWith("=")) return;
      const typed = numericCell(v);
      if (typed && typed.style !== 3) columnNumericStyle[colIndex] = typed.style;
    });
  }
  // 3) A column that is only formulas takes the currency of the cells it references,
  //    so a "Total" column that sums money columns shows as money. Skipped when a
  //    referenced column is a percentage (the ratio is ambiguous) or the column
  //    already has a format from step 1 or 2.
  for (let c = 0; c < colCount; c += 1) {
    if (columnNumericStyle[c]) continue;
    let sawFormula = false;
    let sawCurrency = false;
    let conflict = false;
    for (let r = firstDataRowIndex; r < rows.length; r += 1) {
      const value = ((rows[r] ?? [])[c] ?? "").trim();
      if (!value.startsWith("=")) continue;
      sawFormula = true;
      const refs = value.match(/\$?[A-Z]{1,3}\$?\d+/g) ?? [];
      for (const refText of refs) {
        const letters = /[A-Z]{1,3}/.exec(refText)?.[0] ?? "";
        const refCol = columnLetterToIndex(letters);
        if (refCol === c) continue; // ignore the column referencing itself
        const refStyle = columnNumericStyle[refCol];
        if (refStyle === 2) sawCurrency = true;
        else if (refStyle === 5) conflict = true;
      }
    }
    if (sawFormula && sawCurrency && !conflict) columnNumericStyle[c] = 2;
  }

  // The emphasized (bold, shaded) style for a totals-row cell that carries a given
  // base number format; dates keep their own format rather than being shaded.
  const totalVariant = (base: number): number => {
    if (base === 2) return 7;
    if (base === 4) return 8;
    if (base === 5) return 9;
    if (base === 3) return 3;
    return 10;
  };
  const TOTAL_LABEL = /^(grand\s+)?totals?$/i;

  // Per-column display width, from the longest content seen (header included),
  // clamped so one long cell cannot blow a column out. The title is excluded.
  const columnWidths: number[] = [];
  const noteWidth = (colIndex: number, text: string): void => {
    const width = Math.min(48, Math.max(9, text.length + 2.5));
    if (width > (columnWidths[colIndex] ?? 0)) columnWidths[colIndex] = width;
  };

  const sheetRows: string[] = [];
  rows.forEach((cells, rowIndex) => {
    const isTitle = hasTitle && rowIndex === 0;
    const isHeader = rowIndex === headerRowIndex && hasHeaderRow;
    // A totals row is one whose first non-empty cell reads exactly Total/Totals/
    // Grand Total; its numbers stay currency/percent but turn bold and shaded.
    const firstText = (cells.find((c) => c.trim() !== "") ?? "").trim();
    const isTotal = !isTitle && !isHeader && TOTAL_LABEL.test(firstText);
    const cellXml: string[] = [];
    cells.forEach((value, colIndex) => {
      const ref = `${columnName(colIndex)}${rowIndex + 1}`;
      if (value.trim() === "") return; // empty cell: omit entirely
      if (isTitle) {
        // The title spans the table (merged below); do not let it widen column A.
        cellXml.push(`<c r="${ref}" s="11" t="s"><v>${internString(value)}</v></c>`);
        return;
      }
      noteWidth(colIndex, value);
      if (isHeader) {
        // The header row is always text, always the colored bold style (1).
        cellXml.push(`<c r="${ref}" s="1" t="s"><v>${internString(value)}</v></c>`);
        return;
      }
      const colStyle = columnNumericStyle[colIndex] ?? 0;
      // A leading "=" marks a real Excel formula (=SUM(B2:B10), =B2*C2). Excel
      // computes it on open, so the model lays out the structure and lets the
      // spreadsheet do the arithmetic, instead of typing a number it worked out
      // in its head (the main source of wrong AI spreadsheets). The formula
      // inherits the column's number format, emphasized on a totals row.
      if (value.length > 1 && value.startsWith("=")) {
        const style = isTotal ? totalVariant(colStyle) : colStyle;
        const styleAttr = style ? ` s="${style}"` : "";
        cellXml.push(`<c r="${ref}"${styleAttr}><f>${escapeXml(value.slice(1).trim())}</f></c>`);
        return;
      }
      if (isNumeric(value)) {
        // A plain number inherits its column's number format (and totals shading).
        const style = isTotal ? totalVariant(colStyle) : colStyle;
        const styleAttr = style ? ` s="${style}"` : "";
        cellXml.push(`<c r="${ref}"${styleAttr}><v>${value}</v></c>`);
        return;
      }
      // Currency, grouped numbers, percentages, and dates become real typed
      // numbers with the right display format, so they align, sort, and sum
      // like a hand-made spreadsheet instead of reading as plain text.
      const typed = numericCell(value);
      if (typed) {
        const style = isTotal ? totalVariant(typed.style) : typed.style;
        cellXml.push(`<c r="${ref}" s="${style}"><v>${typed.value}</v></c>`);
      } else {
        const styleAttr = isTotal ? ` s="6"` : "";
        cellXml.push(`<c r="${ref}"${styleAttr} t="s"><v>${internString(value)}</v></c>`);
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
    `<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>` +
    // Recompute every formula when the file is opened, since the builder writes
    // formulas without a cached result.
    `<calcPr fullCalcOnLoad="1"/></workbook>`;
  const workbookRels =
    `${header}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;
  // Freeze the rows above the data (the header, plus the title when present) and
  // size each column to fit. OOXML requires child order: sheetViews, cols,
  // sheetData, then mergeCells (used to span the title across the table).
  const frozenTop = hasTitle ? 2 : 1;
  const frozenPane = hasHeaderRow
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${frozenTop}" topLeftCell="A${frozenTop + 1}" state="frozen" activePane="bottomLeft"/></sheetView></sheetViews>`
    : "";
  const cols = columnWidths.length > 0
    ? `<cols>${columnWidths
        .map((width, index) => (width ? `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>` : ""))
        .join("")}</cols>`
    : "";
  const titleMerge = hasTitle && colCount > 1
    ? `<mergeCells count="1"><mergeCell ref="A1:${columnName(colCount - 1)}1"/></mergeCells>`
    : "";
  const sheet =
    `${header}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `${frozenPane}${cols}<sheetData>${sheetRows.join("")}</sheetData>${titleMerge}</worksheet>`;
  // The style table behind the s= indexes used above. Base cells: 0 default,
  // 1 header (white bold on navy), 2 currency, 3 date, 4 thousands-grouped number,
  // 5 percent. Totals-row cells (bold on a light-blue fill): 6 text, 7 currency,
  // 8 thousands, 9 percent, 10 plain number. 11 title (large bold). Number formats
  // use Excel's builtin ids (plus one custom currency) so every app renders them.
  const styles =
    `${header}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>` +
    `<fonts count="4">` +
    `<font><sz val="11"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="11"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="14"/><name val="Calibri"/></font>` +
    `</fonts>` +
    `<fills count="4">` +
    `<fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/></patternFill></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/></patternFill></fill>` +
    `</fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="12">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
    `<xf numFmtId="164" fontId="1" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>` +
    `<xf numFmtId="3" fontId="1" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>` +
    `<xf numFmtId="10" fontId="1" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>` +
    `<xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
    `<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
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
