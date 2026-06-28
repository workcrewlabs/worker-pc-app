// Single source of truth for the downloadable file formats and the files:save
// contract, shared by the main-process exporter, the preload bridge, and the
// renderer's Download card so the three layers cannot drift. Pure constants and
// types only (no node or browser APIs), so it is safe to import from any of them.

// The file types WorkCrew can hand back. Everything else is rejected so the save
// path can never be coerced into writing an unexpected format.
export const EXPORT_EXTENSIONS = ["xlsx", "docx", "csv", "txt", "md", "json", "html"] as const;
export type ExportExtension = (typeof EXPORT_EXTENSIONS)[number];

export function isExportExtension(value: string): value is ExportExtension {
  return (EXPORT_EXTENSIONS as readonly string[]).includes(value);
}

// What the renderer sends to files:save, and what the main process returns. The
// result is a discriminated union: a save reports its path; a cancelled dialog
// reports only that it was cancelled.
export type SaveFileRequest = { name: string; ext: ExportExtension; content: string };
export type SaveFileResult = { saved: true; path: string } | { canceled: true };
