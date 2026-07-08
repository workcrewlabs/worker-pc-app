import { createElement, useEffect, useState, type ReactNode } from "react";
import { isExportExtension, type ExportExtension } from "../../../shared/export-formats";
import { track } from "./analytics";

// A small, safe Markdown renderer for assistant messages. It renders to React
// elements (never raw HTML), so there is no injection risk. It covers what the
// model commonly produces: headings, bold, italic, inline code, fenced code
// blocks, bullet and numbered lists, links, and paragraphs with line breaks.
// A fenced block tagged "file:EXT name=..." is shown as a download card instead
// of raw code, so the chat can hand the user a real file (the cowork style).

// A friendly size for the generated content (its byte length), shown on the card.
function readableSize(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// A download card for a file the assistant generated. The button asks the main
// process to save the file through a native Save dialog; the user picks where.
function FileBlock({ name, ext, content }: { name: string; ext: ExportExtension; content: string }): ReactNode {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  // The card appeared (a downloadable file was offered). File type only.
  useEffect(() => { track("file_download_card_shown", { ext }); }, [ext]);

  async function onSave(): Promise<void> {
    if (state === "saving") return;
    track("file_download_clicked", { ext });
    setState("saving");
    try {
      const result = await window.workcrew.files.save({ name, ext, content });
      // A cancelled dialog is not an error: quietly return to the ready state.
      setState("saved" in result ? "saved" : "idle");
    } catch {
      setState("error");
    }
  }

  const label =
    state === "saving" ? "Saving..." : state === "saved" ? "Saved" : state === "error" ? "Try again" : "Download";
  return (
    <div className="file-card">
      <div className="file-card-info">
        <span className="file-card-name" title={name}>{name}</span>
        <span className="file-card-meta">{ext.toUpperCase()} file, {readableSize(content)}</span>
      </div>
      <button type="button" className="file-card-button" onClick={() => void onSave()} disabled={state === "saving"}>
        {label}
      </button>
    </div>
  );
}

// While a file is still streaming in (its closing fence has not arrived yet), show
// a quiet "preparing" card with no Download button, so the user can never grab a
// half-written file. It swaps to the real download card the moment the file is
// complete. This is what makes the Download button appear only once the Excel (or
// any) file has finished building.
function FilePending({ name, ext }: { name: string; ext: ExportExtension }): ReactNode {
  return (
    <div className="file-card file-card-pending">
      <div className="file-card-info">
        <span className="file-card-name" title={name}>{name}</span>
        <span className="file-card-meta">Preparing your {ext.toUpperCase()} file...</span>
      </div>
      <span className="file-card-spinner" aria-hidden="true" />
    </div>
  );
}

// Plain fence languages we can hand back as a real file, mapped to the download
// extension. So a model that writes ```csv (instead of the explicit file: form)
// still gets a Download card. Kept to clearly file-like formats so ordinary code
// blocks (python, bash, ...) stay as code.
const FENCE_LANG_TO_EXT: Record<string, ExportExtension> = {
  csv: "csv", json: "json", html: "html", htm: "html", md: "md", markdown: "md"
};

// An untagged fenced block that is unmistakably comma-separated rows: at least
// two non-empty lines that all carry the same number of commas (>= 1), and no
// very long prose-like line. Catches a model that dumps a CSV without tagging it.
function looksLikeCsv(content: string): boolean {
  const lines = content.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < 2) return false;
  const commas = lines.map((line) => (line.match(/,/g) ?? []).length);
  if ((commas[0] ?? 0) < 1) return false;
  if (!commas.every((count) => count === commas[0])) return false;
  if (lines.some((line) => line.length > 240)) return false;
  return true;
}

// Decide whether a fenced block should render as a downloadable file card.
// Three ways in: the explicit `file:EXT name=...` form (best, carries a real
// filename and can target xlsx/docx), a plain file-format language (```csv), or
// an untagged block whose content is clearly CSV. Returns null for ordinary code.
function parseFileFence(info: string, content: string): { ext: ExportExtension; name: string } | null {
  const trimmed = info.trim();
  const explicit = /^file:([a-zA-Z0-9]+)(?:\s+name=(.+))?$/.exec(trimmed);
  if (explicit) {
    const ext = (explicit[1] ?? "").toLowerCase();
    if (!isExportExtension(ext)) return null;
    const rawName = (explicit[2] ?? "").trim().replace(/^["']|["']$/g, "");
    return { ext, name: rawName.length > 0 ? rawName : `workcrew-file.${ext}` };
  }
  const lang = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
  const mapped = FENCE_LANG_TO_EXT[lang];
  if (mapped) return { ext: mapped, name: `workcrew-export.${mapped}` };
  if (trimmed.length === 0 && looksLikeCsv(content)) return { ext: "csv", name: "workcrew-export.csv" };
  return null;
}

const INLINE = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let count = 0;
  INLINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const key = `${keyPrefix}-${count++}`;
    if (match[2] != null) nodes.push(<strong key={key}>{match[2]}</strong>);
    else if (match[4] != null) nodes.push(<em key={key}>{match[4]}</em>);
    else if (match[6] != null) nodes.push(<code key={key} className="md-code">{match[6]}</code>);
    else if (match[8] != null) nodes.push(<a key={key} href={match[9] ?? "#"} target="_blank" rel="noreferrer">{match[8]}</a>);
    lastIndex = INLINE.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function isHeading(line: string): RegExpExecArray | null {
  return /^(#{1,4})\s+(.*)$/.exec(line);
}
const isBullet = (line: string): boolean => /^\s*[-*]\s+/.test(line);
const isNumbered = (line: string): boolean => /^\s*\d+\.\s+/.test(line);

export function Markdown({ text }: { text: string }): ReactNode {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim().startsWith("```")) {
      const info = line.trim().slice(3).trim();
      const code: string[] = [];
      i += 1;
      // Track whether we actually hit the closing fence. If we run off the end of
      // the text without one, the block is still streaming in.
      let closed = false;
      while (i < lines.length) {
        if ((lines[i] ?? "").trim().startsWith("```")) { closed = true; break; }
        code.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      const file = parseFileFence(info, code.join("\n"));
      if (file) {
        // Only offer the download once the file has fully arrived. While it is
        // still being written, show the preparing card instead.
        blocks.push(
          closed
            ? <FileBlock key={`k${key++}`} name={file.name} ext={file.ext} content={code.join("\n")} />
            : <FilePending key={`k${key++}`} name={file.name} ext={file.ext} />
        );
      } else {
        blocks.push(<pre key={`k${key++}`} className="md-pre"><code>{code.join("\n")}</code></pre>);
      }
      continue;
    }

    const heading = isHeading(line);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      const tag = level <= 1 ? "h3" : level === 2 ? "h4" : "h5";
      blocks.push(createElement(tag, { key: `k${key++}`, className: "md-h" }, renderInline(heading[2] ?? "", `h${key}`)));
      i += 1;
      continue;
    }

    if (isBullet(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && isBullet(lines[i] ?? "")) {
        items.push(<li key={`li-${key}-${items.length}`}>{renderInline((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""), `li${key}`)}</li>);
        i += 1;
      }
      blocks.push(<ul key={`k${key++}`} className="md-ul">{items}</ul>);
      continue;
    }

    if (isNumbered(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && isNumbered(lines[i] ?? "")) {
        items.push(<li key={`ol-${key}-${items.length}`}>{renderInline((lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""), `ol${key}`)}</li>);
        i += 1;
      }
      blocks.push(<ol key={`k${key++}`} className="md-ol">{items}</ol>);
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !(lines[i] ?? "").trim().startsWith("```") &&
      !isHeading(lines[i] ?? "") &&
      !isBullet(lines[i] ?? "") &&
      !isNumbered(lines[i] ?? "")
    ) {
      para.push(lines[i] ?? "");
      i += 1;
    }
    const nodes: ReactNode[] = [];
    para.forEach((p, idx) => {
      nodes.push(...renderInline(p, `p${key}-${idx}`));
      if (idx < para.length - 1) nodes.push(<br key={`br${key}-${idx}`} />);
    });
    blocks.push(<p key={`k${key++}`} className="md-p">{nodes}</p>);
  }

  return <div className="md">{blocks}</div>;
}
