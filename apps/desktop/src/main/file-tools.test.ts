import { describe, expect, it } from "vitest";
import { DEFAULT_READ_LIMIT, MAX_LINE_CHARS, applyEdit, formatFileSlice, readFooter, resolveInsideFolder } from "./file-tools.js";
import { sep } from "node:path";

// Reading a file used to mean `type file` through the shell: no line numbers, no
// way to ask for part of it, so a big file either flooded the run or was skipped.
// Editing meant write_file, which replaces the WHOLE file, so changing one line
// meant regenerating every other line perfectly. That is how a 15 line handler
// once arrived as the entire content of a 1,000 line file.

describe("reading a file", () => {
  const file = ["one", "two", "three", "four", "five"].join("\n");

  it("numbers every line, so a later edit can be aimed", () => {
    expect(formatFileSlice(file).text).toBe("1\tone\n2\ttwo\n3\tthree\n4\tfour\n5\tfive");
  });

  it("returns just the page asked for", () => {
    const slice = formatFileSlice(file, { offset: 2, limit: 2 });
    expect(slice.text).toBe("2\ttwo\n3\tthree");
    expect(slice.from).toBe(2);
    expect(slice.to).toBe(3);
  });

  it("counts a trailing newline as the end of a line, not another line", () => {
    // Otherwise every file reads one line longer than any editor shows it.
    expect(formatFileSlice("a\nb\n").totalLines).toBe(2);
    expect(formatFileSlice("a\nb").totalLines).toBe(2);
  });

  it("reads an empty file without inventing a line", () => {
    const slice = formatFileSlice("");
    expect(slice.totalLines).toBe(0);
    expect(slice.text).toBe("");
    expect(readFooter(slice.totalLines, slice.to)).toContain("empty");
  });

  it("says how much is left and where to continue", () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const slice = formatFileSlice(long, { limit: 20 });
    expect(readFooter(slice.totalLines, slice.to)).toContain("30 more lines");
    expect(readFooter(slice.totalLines, slice.to)).toContain("offset 21");
  });

  it("says nothing extra once the whole file has been read", () => {
    const slice = formatFileSlice(file);
    expect(readFooter(slice.totalLines, slice.to)).toBe("");
  });

  it("caps one enormous line rather than letting it fill the run", () => {
    const slice = formatFileSlice("x".repeat(MAX_LINE_CHARS + 500));
    expect(slice.text).toContain("[line truncated]");
    expect(slice.text.length).toBeLessThan(MAX_LINE_CHARS + 100);
  });

  it("pages by a bounded default rather than returning everything", () => {
    const long = Array.from({ length: DEFAULT_READ_LIMIT + 100 }, (_, i) => `line ${i}`).join("\n");
    expect(formatFileSlice(long).to).toBe(DEFAULT_READ_LIMIT);
  });

  it("clamps an offset past the end to the last line", () => {
    // Returning nothing would read as "this file is empty" to a model that
    // simply overshot. The last line plus an honest "lines 5-5 of 5" header
    // tells it where it actually landed.
    const slice = formatFileSlice(file, { offset: 999 });
    expect(slice.from).toBe(5);
    expect(slice.to).toBe(5);
    expect(slice.text).toBe("5\tfive");
  });

  it("handles windows line endings", () => {
    expect(formatFileSlice("a\r\nb").totalLines).toBe(2);
  });
});

describe("editing a file", () => {
  const code = "function add(a, b) {\n  return a - b;\n}\n";

  it("changes only what it was told to change", () => {
    const result = applyEdit(code, { find: "return a - b;", replace: "return a + b;" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe("function add(a, b) {\n  return a + b;\n}\n");
      expect(result.replacements).toBe(1);
    }
  });

  it("refuses text that is not there, rather than guessing", () => {
    const result = applyEdit(code, { find: "return a * b;", replace: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("not in the file");
  });

  it("refuses an ambiguous edit instead of changing the first one it finds", () => {
    // Picking the first would quietly change the wrong line, and the run would
    // report success.
    const twice = "value = 1;\nother = 2;\nvalue = 1;\n";
    const result = applyEdit(twice, { find: "value = 1;", replace: "value = 9;" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("appears 2 times");
  });

  it("changes every occurrence when that is asked for explicitly", () => {
    const twice = "value = 1;\nother = 2;\nvalue = 1;\n";
    const result = applyEdit(twice, { find: "value = 1;", replace: "value = 9;", all: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe("value = 9;\nother = 2;\nvalue = 9;\n");
      expect(result.replacements).toBe(2);
    }
  });

  it("deletes text when the replacement is empty", () => {
    const result = applyEdit("keep\nremove me\nkeep\n", { find: "remove me\n", replace: "" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("keep\nkeep\n");
  });

  it("refuses an edit that would change nothing", () => {
    const result = applyEdit(code, { find: "return a - b;", replace: "return a - b;" });
    expect(result.ok).toBe(false);
  });

  it("treats the text literally, not as a pattern", () => {
    // A regular expression special character must match itself, or an edit to a
    // line containing $ or ( would land somewhere unintended.
    const withSpecials = "const price = total * (1 + rate);\n";
    const result = applyEdit(withSpecials, { find: "(1 + rate)", replace: "(1 + vat)" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("const price = total * (1 + vat);\n");
  });

  it("does not let a $ in the replacement expand into something else", () => {
    // String.replace treats $& and $1 in the replacement as references. A file
    // full of shell or template syntax would otherwise be silently corrupted.
    const result = applyEdit("cost = X;\n", { find: "X", replace: "$& and $1" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("cost = $& and $1;\n");
  });

  it("keeps indentation exactly as given", () => {
    const indented = "if (x) {\n    doThing();\n}\n";
    const result = applyEdit(indented, { find: "    doThing();", replace: "    doOtherThing();" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toContain("\n    doOtherThing();\n");
  });
});

describe("staying inside the folder the user granted", () => {
  const base = process.platform === "win32" ? "C:\\work\\project" : "/work/project";

  it("allows a file inside the folder", () => {
    const result = resolveInsideFolder(base, "src/app.ts");
    expect("path" in result).toBe(true);
    if ("path" in result) expect(result.path.startsWith(base + sep)).toBe(true);
  });

  it("refuses a path that climbs out with ..", () => {
    expect(resolveInsideFolder(base, "../secrets.txt")).toHaveProperty("error");
    expect(resolveInsideFolder(base, "src/../../secrets.txt")).toHaveProperty("error");
  });

  it("refuses an absolute path somewhere else entirely", () => {
    const elsewhere = process.platform === "win32" ? "C:\\Windows\\System32\\config" : "/etc/passwd";
    expect(resolveInsideFolder(base, elsewhere)).toHaveProperty("error");
  });

  it("refuses the folder itself, which is not a file", () => {
    expect(resolveInsideFolder(base, ".")).toHaveProperty("error");
  });
});
