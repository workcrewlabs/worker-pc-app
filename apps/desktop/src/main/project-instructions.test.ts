import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_INSTRUCTION_CHARS, readProjectInstructions } from "./project-instructions";

// These instructions are the difference between an assistant that guesses how a
// project works and one that follows its rules, so the reading of them has to be
// predictable: a fixed order, the folder's own root only, and never so large that
// it crowds out the request it was meant to inform.

describe("reading a project's instructions", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "workcrew-instructions-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds nothing in a folder that says nothing", async () => {
    expect(await readProjectInstructions(dir)).toBeNull();
  });

  it("reads the file and names it, so the model can say where the rules came from", async () => {
    await writeFile(join(dir, "WORKCREW.md"), "# Rules\nRun the tests before finishing.\n", "utf8");
    expect(await readProjectInstructions(dir)).toEqual({
      name: "WORKCREW.md",
      text: "# Rules\nRun the tests before finishing."
    });
  });

  it("prefers the file written for WorkCrew over the ones written for other tools", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "for claude code", "utf8");
    await writeFile(join(dir, "AGENTS.md"), "for agents", "utf8");
    await writeFile(join(dir, "WORKCREW.md"), "for workcrew", "utf8");
    expect((await readProjectInstructions(dir))?.text).toBe("for workcrew");
  });

  it("falls back to another tool's file rather than walking in blind", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "for claude code", "utf8");
    expect(await readProjectInstructions(dir)).toEqual({ name: "CLAUDE.md", text: "for claude code" });
  });

  it("ignores an empty file instead of reporting instructions that say nothing", async () => {
    await writeFile(join(dir, "WORKCREW.md"), "   \n\n", "utf8");
    await writeFile(join(dir, "AGENTS.md"), "the real rules", "utf8");
    expect((await readProjectInstructions(dir))?.name).toBe("AGENTS.md");
  });

  it("strips a byte order mark, which would otherwise corrupt the first heading", async () => {
    await writeFile(join(dir, "WORKCREW.md"), "﻿# Rules", "utf8");
    expect((await readProjectInstructions(dir))?.text).toBe("# Rules");
  });

  it("clamps a huge file and says so, so the task around it still fits", async () => {
    const body = `${"rule line that goes on\n".repeat(2000)}`;
    await writeFile(join(dir, "WORKCREW.md"), body, "utf8");
    const found = await readProjectInstructions(dir);
    expect(found?.text.length).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS + 60);
    expect(found?.text).toContain("was not included");
  });

  it("reads only the folder's own root, never a file buried somewhere inside it", async () => {
    await writeFile(join(dir, "notes.md"), "not instructions", "utf8");
    expect(await readProjectInstructions(dir)).toBeNull();
  });

  it("survives a path that is not a folder at all", async () => {
    expect(await readProjectInstructions("")).toBeNull();
    expect(await readProjectInstructions(join(dir, "does-not-exist"))).toBeNull();
  });
});
