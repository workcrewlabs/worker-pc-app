import { randomUUID } from "node:crypto";
import type { AttachmentRef } from "@workcrew/contracts";
import { createAttachment, getAttachment, type AttachmentRow } from "./db.js";

/** Hard ceiling on a single attachment after decoding. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Longest stretch of a text file that is kept; anything beyond is truncated. */
export const MAX_TEXT_CHARS = 200_000;

type AttachmentKind = "pdf" | "image" | "text";

// Image extensions the model can read, mapped to the media type the API expects.
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp"
};

const SUPPORTED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// Text-like extensions WorkCrew reads inline. Office binary formats (doc, docx,
// xls, xlsx) are intentionally excluded for now; the upload path returns a clear
// message asking the user to convert to PDF.
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml",
  "html", "htm", "log", "ini", "cfg", "conf", "toml", "env", "js", "mjs", "cjs",
  "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp",
  "cc", "cs", "php", "sh", "bash", "bat", "ps1", "sql", "css", "scss", "less"
]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

/**
 * Classify a file into a kind WorkCrew can read, with the media type the model
 * API expects. Extension is the primary signal (the desktop's mime guess is
 * coarse); the mime type is a fallback. Returns null for unsupported types.
 */
export function classifyAttachment(filename: string, mimeType: string): { kind: AttachmentKind; mediaType: string } | null {
  const ext = extensionOf(filename);
  const mime = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";

  if (ext === "pdf" || mime === "application/pdf") return { kind: "pdf", mediaType: "application/pdf" };

  const imageByExt = IMAGE_MEDIA_TYPES[ext];
  if (imageByExt) return { kind: "image", mediaType: imageByExt };
  if (SUPPORTED_IMAGE_MIME.has(mime)) return { kind: "image", mediaType: mime };

  if (TEXT_EXTENSIONS.has(ext) || mime.startsWith("text/")) return { kind: "text", mediaType: "text/plain" };

  return null;
}

/** An error with an HTTP status and stable code, surfaced to the desktop. */
function attachmentError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

/**
 * Validate, decode, and store one uploaded file, returning the reference the
 * desktop attaches to its next chat turn. Text files keep their decoded text;
 * images and PDFs keep canonical base64. Unsupported types, empty files, and
 * oversized files are rejected with a clear, user-facing message.
 */
export async function processAndStoreAttachment(input: {
  userId: string;
  conversationId?: string;
  filename: string;
  mimeType: string;
  base64: string;
}): Promise<AttachmentRef> {
  const classified = classifyAttachment(input.filename, input.mimeType);
  if (!classified) {
    throw attachmentError(
      "That file type is not supported yet. Try a PDF, an image, or a text file.",
      415,
      "UNSUPPORTED_ATTACHMENT"
    );
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.base64, "base64");
  } catch {
    throw attachmentError("The file could not be read.", 400, "INVALID_ATTACHMENT");
  }

  if (bytes.byteLength === 0) throw attachmentError("That file is empty.", 400, "EMPTY_ATTACHMENT");
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw attachmentError("That file is too large. The limit is 10 MB per file.", 413, "ATTACHMENT_TOO_LARGE");
  }

  const id = randomUUID();
  let contentText: string | null = null;
  let contentBase64: string | null = null;

  if (classified.kind === "text") {
    const decoded = bytes.toString("utf8");
    contentText = decoded.length > MAX_TEXT_CHARS ? decoded.slice(0, MAX_TEXT_CHARS) : decoded;
  } else {
    // Re-encode from the decoded bytes so stored base64 is always canonical.
    contentBase64 = bytes.toString("base64");
  }

  await createAttachment({
    id,
    userId: input.userId,
    conversationId: input.conversationId ?? null,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: bytes.byteLength,
    kind: classified.kind,
    mediaType: classified.mediaType,
    contentText,
    contentBase64,
    createdAtMs: Date.now()
  });

  return {
    attachmentId: id,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: bytes.byteLength,
    kind: classified.kind,
    redact: false
  };
}

/**
 * Build the model content block(s) for a stored attachment, scoped to its owner.
 * Returns null when the attachment is missing or belongs to another user, so a
 * stale or forged reference is silently dropped rather than failing the turn.
 */
export async function attachmentContentBlocks(attachmentId: string, userId: string): Promise<unknown[] | null> {
  const row = await getAttachment(attachmentId, userId);
  if (!row) return null;
  return blocksForRow(row);
}

/** The model content blocks for an already-loaded attachment row. */
export function blocksForRow(row: AttachmentRow): unknown[] | null {
  if (row.kind === "image" && row.contentBase64) {
    return [{ type: "image", source: { type: "base64", media_type: row.mediaType, data: row.contentBase64 } }];
  }
  if (row.kind === "pdf" && row.contentBase64) {
    return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: row.contentBase64 }, title: row.filename }];
  }
  if (row.kind === "text" && row.contentText !== null) {
    return [{ type: "text", text: `Attached file "${row.filename}":\n\n${row.contentText}` }];
  }
  return null;
}

/**
 * A deliberately generous, bounded upper bound on the input tokens an attachment
 * adds. Used only to size the worst-case budget reservation; the real cost is
 * settled from actual provider usage afterwards. Text is already counted as text
 * in the reservation payload, so this only covers images and PDFs.
 */
export function estimateMediaTokens(row: { kind: AttachmentKind; sizeBytes: number }): number {
  if (row.kind === "image") return 2_000;
  if (row.kind === "pdf") return Math.min(120_000, Math.ceil(row.sizeBytes / 24) + 1_000);
  return 0;
}
