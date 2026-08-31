import { describe, expect, it } from "vitest";
import { attachmentNeedsEyes } from "./model-registry.js";

// A scanned invoice attached in chat came back with "I can't read the contents
// of the attached PDF", from an account that had read the very same page
// perfectly a few minutes earlier as a PNG.
//
// The cause was one predicate: only kind "image" counted as needing an engine
// that can see. The desktop reads a PDF on the machine first and sends the TEXT
// when there is a text layer, so a PDF still arriving as a PDF is one with no
// readable text: a scan, or a photo of a document. A picture, in other words.
//
// Worth pinning, because routing to a blind engine does not fail loudly. It
// answers, and the answer is a refusal or a guess.

describe("what can only be understood by an engine that can see", () => {
  it("counts a picture", () => {
    expect(attachmentNeedsEyes("image")).toBe(true);
  });

  it("counts a PDF, which is the fix", () => {
    // Any PDF reaching this point has already failed text extraction on the
    // user's own machine, so it is a scan.
    expect(attachmentNeedsEyes("pdf")).toBe(true);
  });

  it("treats a scan exactly as it treats a photograph of the same page", () => {
    expect(attachmentNeedsEyes("pdf")).toBe(attachmentNeedsEyes("image"));
  });

  it("leaves plain text alone, so ordinary chat stays on the cheap engine", () => {
    expect(attachmentNeedsEyes("text")).toBe(false);
  });

  it("does not answer yes to a kind it has never heard of", () => {
    for (const kind of ["", "audio", "video", "IMAGE"]) {
      expect(attachmentNeedsEyes(kind)).toBe(false);
    }
  });
});
