import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";

/**
 * Reading a page for chat: fetch one URL, server side, and hand back its
 * readable text.
 *
 * A tool that lets the model make OUR backend fetch an address it chooses is
 * real attack surface: server-side request forgery, where a request (crafted
 * directly, or by content the model reads elsewhere) reaches somewhere that is
 * only meant to be reachable from inside our own network, not from the public
 * internet. Every check below exists to keep this doing only what it claims:
 * reading a public page, nothing an ordinary browser outside our
 * infrastructure could not equally reach.
 *
 * It also only ever gets you as far as the page's own HTML. A page that builds
 * its content in the browser rather than sending it in the response (a
 * JavaScript single-page app, most dashboards, a claude.ai artifact link) comes
 * back looking empty, because there is genuinely nothing there until a real
 * browser runs its scripts. That case is refused with a clear reason rather
 * than returned as if it were the page, because a small amount of boilerplate
 * text presented as "the content" is worse than an honest refusal.
 */

const MAX_BODY_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 15_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
// Below this, what came back is boilerplate, not content: a page that sends its
// real content only reaches this length by accident.
//
// Calibrated against two real pages rather than guessed: a claude.ai artifact
// link (the actual case this was built for) extracts to 58 characters of
// nothing but a title and a disclaimer, while example.com, a genuinely short
// but real page, extracts to 142. The threshold sits between them, closer to
// the empty-shell number, because refusing a page that did have something to
// say costs more than occasionally passing through a short scrap of
// boilerplate from one that did not.
const MIN_MEANINGFUL_CHARS = 90;

/**
 * Is this IPv4 literal inside a private, loopback, link-local, or otherwise
 * non-public range? Deliberately conservative: refusing an address that would
 * have been fine costs a clearer error message; allowing one that should have
 * been refused is a request into our own infrastructure.
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, including the cloud metadata address
  if (a === 0) return true; // "this network"
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/** The IPv6 equivalent. Ranges checked by prefix, kept conservative for the
 *  same reason as the IPv4 version above. */
export function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true; // loopback / unspecified
  if (v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) return true; // fe80::/10
  if (v.startsWith("fc") || v.startsWith("fd")) return true; // fc00::/7, unique local
  if (v.startsWith("::ffff:")) {
    const mapped = v.slice(7);
    if (mapped.includes(".")) return isPrivateIPv4(mapped);
  }
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  if (isIPv4(ip)) return isPrivateIPv4(ip);
  if (isIPv6(ip)) return isPrivateIPv6(ip);
  return true; // not a literal IP we recognise: refuse rather than guess
}

/** Whether every address a hostname resolves to is safe to fetch. A hostname
 *  with no public address at all, or one we cannot resolve, is refused. */
async function resolvesToPublicAddress(hostname: string): Promise<boolean> {
  if (isIPv4(hostname) || isIPv6(hostname)) return !isPrivateAddress(hostname);
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.length > 0 && records.every((record) => !isPrivateAddress(record.address));
  } catch {
    return false;
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

/**
 * A page's readable text, the plain way: drop script and style blocks
 * entirely (their content is never prose), turn block-level closing tags into
 * line breaks so paragraphs stay separated, strip every remaining tag, then
 * decode the handful of entities actually common in body text.
 */
export function stripHtml(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1] ?? "").trim().slice(0, 200) : "";
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, "\n");
  const text = decodeEntities(withoutNoise.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

export type PageFetchResult =
  | { ok: true; title: string; text: string; truncated: boolean }
  | { ok: false; message: string };

const READABLE_TYPES = /text\/html|text\/plain|application\/json|text\/markdown/;

export async function fetchReadablePage(rawUrl: string): Promise<PageFetchResult> {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return { ok: false, message: "That is not a valid web address." };
  }

  for (let redirects = 0; ; redirects += 1) {
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return { ok: false, message: "Only http and https addresses can be read." };
    }
    if (!(await resolvesToPublicAddress(target.hostname))) {
      return { ok: false, message: "That address cannot be read." };
    }

    let response: Response;
    try {
      response = await fetch(target, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "user-agent": "WorkCrewBot/1.0 (+https://getworkcrew.com)" }
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return { ok: false, message: timedOut ? "That page took too long to respond." : "That page could not be reached." };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects >= MAX_REDIRECTS) {
        return { ok: false, message: "That page redirected too many times." };
      }
      // Re-validated from the top of the loop: a redirect target is a fresh
      // address and gets the same scheme and private-address checks, so a
      // public first hop cannot be used to reach a private final one.
      target = new URL(location, target);
      continue;
    }
    if (!response.ok) {
      return { ok: false, message: `That page returned an error (status ${response.status}).` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!READABLE_TYPES.test(contentType)) {
      const kind = contentType.split(";")[0]?.trim() || "file";
      return {
        ok: false,
        message: `That address is a ${kind}, not a readable page. Only web pages, plain text, JSON, and markdown can be read this way.`
      };
    }

    const reader = response.body?.getReader();
    if (!reader) return { ok: false, message: "That page had no content." };
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let cutOff = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        cutOff = true;
        break;
      }
      chunks.push(value);
    }
    try {
      await reader.cancel();
    } catch {
      // Already finished; nothing to cancel.
    }

    const raw = Buffer.concat(chunks).toString("utf8");
    const isHtml = contentType.includes("html");
    const { title, text: extracted } = isHtml ? stripHtml(raw) : { title: "", text: raw };
    const text = extracted.trim();

    if (text.length < MIN_MEANINGFUL_CHARS) {
      return {
        ok: false,
        message:
          "That page returned almost no readable text. It likely builds its content in the browser rather than " +
          "sending it in the page, which cannot be read this way; a real browser is needed for that."
      };
    }

    const truncated = cutOff || text.length > MAX_TEXT_CHARS;
    return { ok: true, title, text: text.slice(0, MAX_TEXT_CHARS), truncated };
  }
}
