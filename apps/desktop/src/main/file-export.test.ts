import { describe, expect, it } from "vitest";
import { extractOfficeText } from "./office";
import {
  buildDocx,
  buildXlsx,
  generateExport,
  isExportExtension,
  parseCsv,
  sanitizeExportName
} from "./file-export";

describe("parseCsv", () => {
  it("splits simple rows and cells", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("handles quoted fields with commas and quotes", () => {
    expect(parseCsv('name,note\n"Smith, Jane","said ""hi"""')).toEqual([
      ["name", "note"],
      ["Smith, Jane", 'said "hi"']
    ]);
  });

  it("handles newlines inside quotes and CRLF line endings", () => {
    expect(parseCsv('a,"line1\nline2"\r\nx,y')).toEqual([
      ["a", "line1\nline2"],
      ["x", "y"]
    ]);
  });

  it("ignores a single trailing newline", () => {
    expect(parseCsv("a,b\n")).toEqual([["a", "b"]]);
  });
});

describe("buildXlsx", () => {
  it("produces a real workbook whose strings round-trip through the reader", async () => {
    const buffer = await buildXlsx([
      ["Month", "Revenue"],
      ["January", "1000"],
      ["February", "1200"]
    ]);
    const text = await extractOfficeText("xlsx", buffer);
    // The reader returns the shared strings (text cells), de-duplicated in order.
    // Numbers are stored as numeric cells, so they are not in the string table.
    expect(text).toBe("Month\nRevenue\nJanuary\nFebruary");
  });

  it("escapes XML-significant characters in cell text", async () => {
    const buffer = await buildXlsx([["A & B <C>"]]);
    const text = await extractOfficeText("xlsx", buffer);
    expect(text).toBe("A & B <C>");
  });
});

describe("buildDocx", () => {
  it("produces a real document with one paragraph per line", async () => {
    const buffer = await buildDocx("First line\nSecond line");
    expect(await extractOfficeText("docx", buffer)).toBe("First line\nSecond line");
  });
});

describe("generateExport", () => {
  it("writes plain text formats verbatim", async () => {
    const buffer = await generateExport("md", "# Title\n\nBody");
    expect(buffer.toString("utf8")).toBe("# Title\n\nBody");
  });

  it("turns csv content into a real xlsx when xlsx is requested", async () => {
    const buffer = await generateExport("xlsx", "Name,Score\nAda,99");
    expect(await extractOfficeText("xlsx", buffer)).toBe("Name\nScore\nAda");
  });
});

describe("sanitizeExportName", () => {
  it("strips directories and forces the chosen extension", () => {
    expect(sanitizeExportName("../../etc/passwd", "csv")).toBe("passwd.csv");
    expect(sanitizeExportName("budget.txt", "xlsx")).toBe("budget.xlsx");
    expect(sanitizeExportName("  ", "docx")).toBe("workcrew-file.docx");
  });
});

describe("isExportExtension", () => {
  it("accepts known formats and rejects others", () => {
    expect(isExportExtension("xlsx")).toBe(true);
    expect(isExportExtension("exe")).toBe(false);
  });
});
