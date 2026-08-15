import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createRunSchema, nextRunStepSchema } from "@workcrew/contracts";
import { MAX_RUN_STEPS, midTaskNote } from "./server.js";
import { client, createRun, getRun, initializeDatabase } from "./db.js";

// A run used to be cut off after 24 planning steps whatever it was doing. That is
// the right ceiling for driving the mouse around someone's desktop and far too
// low for work in a folder: reading a dozen files, writing several, running the
// tests and fixing what failed is ordinary engineering that takes many more small
// steps, and being stopped halfway leaves a half-written change behind.

describe("how many steps a run may take", () => {
  it("still holds screen work to a short leash", () => {
    expect(MAX_RUN_STEPS.screen).toBe(24);
  });

  it("gives folder work room to actually finish a job", () => {
    expect(MAX_RUN_STEPS.folder).toBeGreaterThanOrEqual(100);
  });

  it("never lets folder work be the tighter of the two", () => {
    expect(MAX_RUN_STEPS.folder).toBeGreaterThan(MAX_RUN_STEPS.screen);
  });
});

describe("what a client says a run is", () => {
  it("treats a run from an older app, which says nothing, as screen work", () => {
    // Installed copies predate this field. Defaulting the other way would hand
    // them the long ceiling for driving the screen, which is the one place it
    // does not belong.
    const parsed = createRunSchema.parse({ task: "open notepad and type hello" });
    expect(parsed.kind).toBe("screen");
  });

  it("accepts folder work", () => {
    expect(createRunSchema.parse({ task: "run the tests", kind: "folder" }).kind).toBe("folder");
  });

  it("refuses anything else, rather than guessing a ceiling", () => {
    expect(() => createRunSchema.parse({ task: "run the tests", kind: "unlimited" })).toThrow();
    expect(() => createRunSchema.parse({ task: "run the tests", kind: 120 })).toThrow();
  });
});

describe("a stored run", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
  });

  async function store(kind: "screen" | "folder") {
    const id = randomUUID();
    const userId = randomUUID();
    await createRun({
      id,
      userId,
      model: "auto",
      kind,
      status: "ready",
      messages: [{ role: "user", content: "do the thing" }],
      pendingToolUseId: null,
      stepCount: 0,
      lastActionSignature: null,
      repeatCount: 0,
      escalated: false,
      tokensInput: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      tokensOutput: 0
    });
    return getRun(id, userId);
  }

  it("remembers what it is, so every later step is measured against the same ceiling", async () => {
    // The kind is decided once, when the run is created. Reading it back per step
    // is what stops a run from changing its own limit halfway through.
    expect((await store("folder"))?.kind).toBe("folder");
    expect((await store("screen"))?.kind).toBe("screen");
  });
});

// A user watching a run had no way to speak to it: messages typed mid-flight
// were swallowed or answered by the wrong thing entirely. They now ride to the
// model with the next tool result.
describe("speaking to a run while it works", () => {
  it("accepts a mid-run message alongside a tool result", () => {
    const parsed = nextRunStepSchema.parse({
      result: { toolUseId: "t1", ok: true, output: "done" },
      say: "  skip the tests, just open the dev app  "
    });
    expect(parsed.say).toBe("skip the tests, just open the dev app");
  });

  it("bounds it like any other input", () => {
    expect(() => nextRunStepSchema.parse({ say: "x".repeat(5_000) })).toThrow();
    expect(() => nextRunStepSchema.parse({ say: "" })).toThrow();
  });

  it("delivers it as the user's own voice, with stopping honoured", () => {
    const note = midTaskNote("stop, that is the wrong file");
    expect(note).toContain('"stop, that is the wrong file"');
    expect(note).toContain("If they asked you to stop, stop");
    expect(note).toContain("Never ignore it");
  });
});
