import { readFile } from "node:fs/promises";
import { join } from "node:path";

// A project can leave written instructions for whoever works in it: how to build
// it, what to run before calling a change done, what never to touch. A human
// developer reads that file first. Until now WorkCrew did not, so it walked into
// every repository knowing nothing about it and had to be told the same rules by
// hand in every conversation.
//
// Reading it is what turns "an assistant that can run commands in a folder" into
// one that works the way the project expects.

/** The files a project uses for this, best first. The first one found wins. */
export const INSTRUCTION_FILENAMES = ["WORKCREW.md", "AGENTS.md", "CLAUDE.md"] as const;

/**
 * How much of it is passed on. The instructions travel inside the task, which the
 * backend caps, so an enormous file cannot be allowed to crowd out the folder
 * listing and the user's actual request.
 */
export const MAX_INSTRUCTION_CHARS = 6_000;

export type ProjectInstructions = { name: string; text: string };

/** Cut long instructions at a line break, so they never end mid-sentence. */
function clamp(text: string): string {
  if (text.length <= MAX_INSTRUCTION_CHARS) return text;
  const cut = text.slice(0, MAX_INSTRUCTION_CHARS);
  const lastBreak = cut.lastIndexOf("\n");
  const kept = lastBreak > MAX_INSTRUCTION_CHARS * 0.6 ? cut.slice(0, lastBreak) : cut;
  return `${kept.trimEnd()}\n\n...(the rest of this file was not included)`;
}

/**
 * The project's instructions for the folder, or null when it has none.
 *
 * Only the folder's own root is looked at: a file that has to be hunted for is a
 * file whose effect nobody can predict.
 */
export async function readProjectInstructions(dir: string): Promise<ProjectInstructions | null> {
  if (!dir || !dir.trim()) return null;
  for (const name of INSTRUCTION_FILENAMES) {
    let raw: string;
    try {
      raw = await readFile(join(dir, name), "utf8");
    } catch {
      // Missing, unreadable, or a directory by that name: try the next one.
      continue;
    }
    // Strip the byte order mark an editor may have written, or the first heading
    // arrives as a word the model does not recognise.
    const text = clamp(raw.replace(/^\uFEFF/, "").trim());
    if (text) return { name, text };
  }
  return null;
}
