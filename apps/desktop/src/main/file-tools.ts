import { confinePath } from "./shell-cli.js";

// Reading and editing one file inside the folder the user granted.
//
// Both used to go through run_command. Reading meant `type file`, which returns
// the whole file with no line numbers and no way to ask for part of it, so a
// large file either flooded the run's context or was skipped. Editing meant
// write_file, which replaces the ENTIRE file: changing one line means
// regenerating every other line perfectly, and a model under pressure sends only
// the part it changed. That is how a 15 line handler once arrived as the whole
// content of a 1,000 line file and stopped the app compiling.
//
// These two are the narrower tools. Everything here is pure enough to unit test,
// and the actual filesystem calls are injected, so the rules can be checked
// without touching a disk.

/** Lines returned when the caller does not ask for a specific number. */
export const DEFAULT_READ_LIMIT = 400;
/** Longest single line returned before it is cut, so one minified file cannot
 *  fill a whole run's context with a single line. */
export const MAX_LINE_CHARS = 2_000;

export type ReadRequest = { path: string; offset?: number; limit?: number };

/**
 * Format a slice of a file the way the engine reads best: one line per row,
 * prefixed with its real line number.
 *
 * The numbers are not decoration. They are how the model knows where it is in a
 * file it is reading a page at a time, and they let it say which part it means
 * when it comes back to edit.
 */
export function formatFileSlice(
  content: string,
  request: { offset?: number; limit?: number } = {}
): { text: string; totalLines: number; from: number; to: number } {
  // A trailing newline is a line terminator, not an empty final line, so it is
  // dropped before counting. Otherwise every file reads as one line longer than
  // any editor shows.
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = body.length === 0 ? [] : body.split(/\r?\n/);
  const totalLines = lines.length;
  const from = Math.max(1, Math.min(request.offset ?? 1, totalLines || 1));
  const limit = Math.max(1, request.limit ?? DEFAULT_READ_LIMIT);
  const to = Math.min(totalLines, from + limit - 1);

  const shown = lines.slice(from - 1, to).map((line, index) => {
    const number = from + index;
    const clipped = line.length > MAX_LINE_CHARS
      ? `${line.slice(0, MAX_LINE_CHARS)}...[line truncated]`
      : line;
    return `${number}\t${clipped}`;
  });

  return { text: shown.join("\n"), totalLines, from, to };
}

/** The note appended after a partial read, so the model knows to ask for more
 *  rather than assuming it has seen the whole file. */
export function readFooter(totalLines: number, to: number): string {
  if (totalLines === 0) return "\n(this file is empty)";
  if (to >= totalLines) return "";
  return `\n...[${totalLines - to} more lines. Read again with offset ${to + 1} to continue.]`;
}

export type EditOutcome =
  | { ok: true; content: string; replacements: number }
  | { ok: false; message: string };

/**
 * Apply one find-and-replace to a file's content.
 *
 * Refuses rather than guesses. Text that appears nowhere is a mistake about
 * which file or which version is being edited; text that appears several times
 * is a mistake about which one is meant, and picking the first would quietly
 * change the wrong line. Both come back as an instruction the model can act on,
 * because an error it cannot fix is just a failed run.
 */
export function applyEdit(
  content: string,
  edit: { find: string; replace: string; all?: boolean }
): EditOutcome {
  if (edit.find === edit.replace) {
    return { ok: false, message: "Blocked: find and replace are identical, so this edit would change nothing." };
  }
  const occurrences = countOccurrences(content, edit.find);
  if (occurrences === 0) {
    return {
      ok: false,
      message:
        "Could not edit: that exact text is not in the file. Read the file again and copy the text to replace " +
        "character for character, including its indentation."
    };
  }
  if (occurrences > 1 && edit.all !== true) {
    return {
      ok: false,
      message:
        `Could not edit: that text appears ${occurrences} times, so it is not clear which one you mean. ` +
        "Include more of the surrounding lines to make it unique, or set all to true to change every one."
    };
  }
  // Both paths insert the replacement literally. String.replace expands $&, $1
  // and friends in a string replacement, so editing a line in a shell script or
  // a template would silently corrupt it; a replacer function does no expansion,
  // and split/join never did.
  const next = edit.all === true
    ? content.split(edit.find).join(edit.replace)
    : content.replace(edit.find, () => edit.replace);
  return { ok: true, content: next, replacements: edit.all === true ? occurrences : 1 };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Resolve a requested path inside the working folder, or explain the refusal.
 *
 * Shares confinePath with write_file rather than repeating the rule, so reading
 * and editing can never reach somewhere writing cannot.
 */
export function resolveInsideFolder(base: string, requested: string): { path: string } | { error: string } {
  const target = confinePath(base, requested);
  if (!target) return { error: "Blocked: the path is outside the working folder." };
  return { path: target };
}
