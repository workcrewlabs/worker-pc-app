import { describe, expect, it } from "vitest";
import { folderForNewPane } from "./ConversationPane";

// Which folder a pane starts in is a rule, not a coincidence: the pane the app
// opens with (and every New chat) goes straight to the remembered default, so
// the user stops picking the same folder on every launch. The two exceptions
// are pinned here too, because both would be wrong in ways nobody would spot
// in review: a conversation reopened from Recents must come back exactly as it
// was, and a routine's pane must run where the routine said.

const DEFAULT: { path: string; name: string } = { path: "D:\\worker pc app", name: "worker pc app" };
const OWN: { path: string; name: string } = { path: "C:\\elsewhere", name: "elsewhere" };

describe("which folder a pane opens in", () => {
  it("opens a fresh pane in the remembered default", () => {
    expect(folderForNewPane(null, undefined, undefined, DEFAULT)).toEqual(DEFAULT);
    expect(folderForNewPane(undefined, undefined, undefined, DEFAULT)).toEqual(DEFAULT);
  });

  it("starts without a folder when no default was ever chosen", () => {
    expect(folderForNewPane(null, undefined, undefined, null)).toBeNull();
  });

  it("keeps a reopened conversation's own folder, whatever the default is", () => {
    expect(folderForNewPane(OWN, "conv-1", undefined, DEFAULT)).toEqual(OWN);
  });

  it("does not put the default on a conversation that never had one", () => {
    // Reopening from Recents has to restore that chat as it was, not reroute a
    // folder-less conversation into the default project.
    expect(folderForNewPane(null, "conv-1", undefined, DEFAULT)).toBeNull();
  });

  it("runs a routine's pane where the routine said, not in the default folder", () => {
    expect(folderForNewPane(null, undefined, { task: "tidy the downloads folder", label: "Routine" }, DEFAULT)).toBeNull();
  });
});
