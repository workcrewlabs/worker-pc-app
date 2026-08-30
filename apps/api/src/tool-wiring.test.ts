import { describe, expect, it } from "vitest";
import { automationActionSchema } from "@workcrew/contracts";
import { TOOL_NAMES, actionKindForTool } from "./anthropic.js";

// A tool has to be wired up in two places that know nothing about each other:
// advertised to the model, and mapped back to an action when the model calls it.
// Adding one and forgetting the other is silent and total. The model calls the
// new tool, the call maps to nothing, and the run ends telling the user their
// request "came back in a form I can't run", with no clue that a tool name is
// simply missing from a switch. That is exactly what happened when read_file and
// edit_file were added; these tests are what would have caught it.

describe("every tool the engine offers can actually be run", () => {
  it("maps each advertised tool to an action kind", () => {
    for (const name of TOOL_NAMES) {
      expect(actionKindForTool(name), `${name} is offered to the model but maps to no action`).not.toBeNull();
    }
  });

  it("maps each tool to a kind the action schema accepts", () => {
    const kinds = new Set(automationActionSchema.options.map((option) => option.shape.kind.value));
    for (const name of TOOL_NAMES) {
      expect(kinds, `${name} maps to a kind the contract does not define`).toContain(actionKindForTool(name));
    }
  });

  it("offers the file tools that folder work depends on", () => {
    // Reading a file used to mean shelling out to `type`, and changing one meant
    // rewriting the whole thing. Both are their own tool now.
    expect(TOOL_NAMES).toContain("read_file");
    expect(TOOL_NAMES).toContain("edit_file");
  });

  it("does not answer to a tool it never offered", () => {
    expect(actionKindForTool("delete_everything")).toBeNull();
    expect(actionKindForTool("")).toBeNull();
  });
});
