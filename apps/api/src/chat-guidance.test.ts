import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "./chat.js";

// The owner asked WorkCrew to update a project on his PC and was told to flip a
// switch. He flipped it, and it still could not touch the project, because the
// thing actually missing was the folder. Half an instruction is worse than none:
// it sends the user somewhere that does not work and leaves them thinking the
// product is broken.

describe("what chat tells a user who asks for work on a project", () => {
  it("names the control that actually attaches a folder", () => {
    expect(SYSTEM_PROMPT).toContain('Add a folder to work in');
    expect(SYSTEM_PROMPT).toContain("+ button");
  });

  it("does not send them to paste their files into the message", () => {
    expect(SYSTEM_PROMPT).toContain("do not tell them to paste the files");
  });

  it("does not ask for the switch as well, since adding a folder sets it", () => {
    expect(SYSTEM_PROMPT).toContain("turns on Computer use by itself");
  });

  it("offers no switch at all once a folder is attached", () => {
    // With a folder there IS no switch in the composer, so mentioning one sends
    // the user hunting for a control that is not on screen. This was the reply
    // the owner got three times while trying to change his own app.
    expect(SYSTEM_PROMPT).toContain("There is no switch to set in a folder session");
    expect(SYSTEM_PROMPT).toContain("does NOT drive the mouse");
  });

  it("still routes plain on-screen tasks to the switch", () => {
    // The older path has to survive: opening a website is not folder work.
    expect(SYSTEM_PROMPT).toContain("set the switch under the message box to Computer use");
  });

  it("keeps insisting it can reach files once a folder is there", () => {
    expect(SYSTEM_PROMPT).toContain("never say it cannot access their files");
  });

  // The folder rule and the switch rule flatly contradict each other, which is
  // fine only while the folder rule is read first and says so. Stated after, as
  // a late exception, it lost: the owner was told to set a switch that is not on
  // screen and to send his instruction again, in a folder session, three times.
  it("settles the contradiction before it can be read the wrong way", () => {
    const folderRule = SYSTEM_PROMPT.indexOf("working folder context IS present");
    const switchRule = SYSTEM_PROMPT.indexOf("set the switch under the message box to Computer use");
    expect(folderRule).toBeGreaterThan(-1);
    expect(folderRule).toBeLessThan(switchRule);
    expect(SYSTEM_PROMPT).toContain("Every rule below about switches and buttons is void here");
  });

  it("does not ask a folder session to send the same instruction again", () => {
    // The work already ran. Asking for it again is asking for it twice.
    expect(SYSTEM_PROMPT).toContain("carried out automatically, without the user doing anything first");
  });
});
