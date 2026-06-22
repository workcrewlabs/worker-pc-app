import { createElement, type ReactNode } from "react";

// A small, safe Markdown renderer for assistant messages. It renders to React
// elements (never raw HTML), so there is no injection risk. It covers what the
// model commonly produces: headings, bold, italic, inline code, fenced code
// blocks, bullet and numbered lists, links, and paragraphs with line breaks.

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
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      blocks.push(<pre key={`k${key++}`} className="md-pre"><code>{code.join("\n")}</code></pre>);
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
