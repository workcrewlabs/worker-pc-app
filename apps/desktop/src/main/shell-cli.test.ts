import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { confinePath } from "./shell-cli";

// confinePath is the safety boundary for write_file: a path is allowed only if
// it resolves to a location strictly inside the working folder. These cases pin
// the escape attempts (parent traversal, absolute paths, sneaky prefixes) so a
// future refactor cannot silently open a hole.

const base = resolve("C:/work/project");

describe("confinePath", () => {
  it("allows a simple file in the folder", () => {
    expect(confinePath(base, "notes.txt")).toBe(resolve(base, "notes.txt"));
  });

  it("allows a nested path in a subfolder", () => {
    expect(confinePath(base, "src/lib/util.js")).toBe(resolve(base, "src/lib/util.js"));
  });

  it("allows a path that internally traverses but stays inside", () => {
    expect(confinePath(base, "src/../notes.txt")).toBe(resolve(base, "notes.txt"));
  });

  it("rejects parent traversal that escapes the folder", () => {
    expect(confinePath(base, "../secret.txt")).toBeNull();
    expect(confinePath(base, "../../Windows/System32/evil.dll")).toBeNull();
    expect(confinePath(base, "src/../../outside.txt")).toBeNull();
  });

  it("rejects an absolute path pointing elsewhere", () => {
    expect(confinePath(base, "C:/Windows/System32/drivers/etc/hosts")).toBeNull();
    expect(confinePath(base, "/etc/passwd")).toBeNull();
  });

  it("rejects the base directory itself (a file must be strictly inside)", () => {
    expect(confinePath(base, ".")).toBeNull();
  });

  it("rejects a sibling folder that merely shares the name prefix", () => {
    // C:/work/project-evil starts with "C:/work/project" as a string but is NOT
    // inside it; the trailing separator check must catch this.
    const sibling = confinePath(resolve("C:/work/project"), "../project-evil/x.txt");
    expect(sibling).toBeNull();
  });
});
