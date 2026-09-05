import { BrowserWindow, session } from "electron";
import {
  browserUserAgent,
  combineFrameText,
  type PageReadResult
} from "./page-text.js";

/**
 * Reading a link the user pasted, using a real browser.
 *
 * The backend can already fetch a URL, but fetching only ever gets you the HTML
 * the server sends. A page that assembles its content in the browser (a
 * single-page app, most dashboards, a claude.ai artifact link) sends an almost
 * empty shell, so fetching it comes back with nothing to read no matter how
 * public the link is. Other tools manage these links because they run an actual
 * browser that executes the page's JavaScript first.
 *
 * WorkCrew is an Electron app, so it already contains one. This renders the
 * page in a hidden window, waits for it to finish building itself, and reads
 * the text out, including the text inside iframes (an artifact page puts its
 * whole content in one).
 *
 * The window is deliberately powerless. It runs in a throwaway session that
 * holds none of the user's WorkCrew cookies and is discarded when the app
 * closes, it is sandboxed with no preload and no Node, and it may not open
 * windows, download files, ask for permissions, or leave http and https. It
 * loads a page and reads it, and can do nothing else.
 */

/** A partition with no "persist:" prefix is in-memory only: nothing a page
 *  stores survives the app closing, and it starts with no cookies at all. */
const PARTITION = "workcrew-page-reader";

/**
 * The longest this may take, start to finish.
 *
 * It runs before the answer begins, so every second is a second of the user
 * watching nothing happen. It is a ceiling rather than a wait, and almost never
 * reached: an ordinary page is read in two or three seconds, and reading stops
 * the moment the text stops growing.
 *
 * The ceiling is set by the slow end of what real pages do, not by what feels
 * tidy. The artifact link this was built for was measured repeatedly, and the
 * frame holding the document appeared anywhere between six and sixteen seconds
 * depending on the run. A budget that only covered the fast attempts turned that
 * page into a coin toss, which is worse than waiting.
 */
const OVERALL_BUDGET_MS = 25_000;
const POLL_INTERVAL_MS = 400;
/**
 * How long the text must sit unchanged before it counts as the finished page,
 * and why that depends on how much of it there is.
 *
 * "It stopped changing" is weak evidence on its own. An artifact page holds
 * still at a hundred characters of disclaimer for several seconds before the
 * frame carrying the actual document even exists, so a plain two-poll rule read
 * the wrapper and left, and reported that scrap as the page. Waiting the longer
 * count for everything would instead make every quick, ordinary page slow.
 *
 * So the amount of proof scales with how suspicious the result is: a page with
 * real content on it is taken at its word, while a nearly empty one has to stay
 * empty for five seconds before that is accepted as the truth about it.
 */
const SUBSTANTIAL_CHARS = 800;
const STABLE_POLLS = 3;
const STABLE_POLLS_WHEN_THIN = 6;
const MAX_TEXT_CHARS = 12_000;
/** Below this the render produced boilerplate rather than content, so the
 *  honest answer is that it could not be read. Matches the backend's threshold
 *  for the same judgement. */
const MIN_MEANINGFUL_CHARS = 90;
/** No single frame may hold up a poll. */
const FRAME_READ_TIMEOUT_MS = 2_000;
/** The last resort, if even the budgeted loop somehow fails to come back. */
const HARD_STOP_MS = OVERALL_BUDGET_MS + 5_000;

// Read a copy of the page with the code stripped out of it, not the page
// itself. innerText alone is usually enough, because a browser does not paint
// script tags. But an invisible frame paints nothing at all, so innerText comes
// back empty there and the fallback to textContent is what picks up the real
// text; without this pruning that fallback also swept up whole script bodies,
// and a bot-check frame's minified JavaScript arrived as if it were the article.
const READ_FRAME_TEXT = `(() => {
  try {
    if (!document.body) return "";
    const painted = document.body.innerText;
    if (painted && painted.trim()) return painted;
    const copy = document.body.cloneNode(true);
    copy.querySelectorAll("script,style,noscript,template,svg").forEach((node) => node.remove());
    return copy.textContent || "";
  } catch { return ""; }
})()`;

/**
 * Give up on a promise that is taking too long, with an answer to use instead.
 *
 * Nothing a web page controls is allowed to be waited on without a limit. A page
 * running a tight loop, or one whose frame stops answering, leaves the read
 * pending forever, and because this sits in front of the user's message that
 * would hang the question itself rather than the page.
 */
async function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const giveUp = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, giveUp]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read the visible text of every frame in the page, the main one included. */
async function textFromAllFrames(window: BrowserWindow): Promise<string> {
  const contents = window.webContents;
  const frames = [contents.mainFrame, ...contents.mainFrame.framesInSubtree];
  const pieces: string[] = [];
  for (const frame of frames) {
    try {
      const value = await within<unknown>(frame.executeJavaScript(READ_FRAME_TEXT, true), FRAME_READ_TIMEOUT_MS, "");
      if (typeof value === "string") pieces.push(value);
    } catch {
      // A frame that navigated away or was removed mid-read contributes
      // nothing; the rest of the page is still worth reading.
    }
  }
  return combineFrameText(pieces);
}

/** Lock the throwaway session down once: no downloads, no permissions, and no
 *  announcing itself as something a bot check will stop. */
function hardenedSession(): Electron.Session {
  const scoped = session.fromPartition(PARTITION);
  scoped.setUserAgent(browserUserAgent(scoped.getUserAgent()));
  scoped.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  scoped.setPermissionCheckHandler(() => false);
  scoped.on("will-download", (event) => event.preventDefault());
  return scoped;
}

function wait(ms: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, ms));
}

/**
 * Render one page and read it.
 *
 * Failure is always a sentence the user could act on, never an exception: this
 * runs on the way to answering a question, and a link that will not load should
 * not take the answer down with it.
 */
export async function renderPage(rawUrl: string): Promise<PageReadResult> {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return { ok: false, url: rawUrl, message: "That is not a valid web address." };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { ok: false, url: rawUrl, message: "Only http and https addresses can be read." };
  }

  // The belt to the loop's braces. The loop already stops at its own budget, but
  // it reaches into a live web page to do it, and this guarantees an answer to
  // the caller even if some part of that never comes back.
  const work = readRenderedPage(target).catch((error): PageReadResult => {
    console.error("[WorkCrew] page read failed:", error instanceof Error ? error.message : error);
    return { ok: false, url: target.toString(), message: "That page could not be opened." };
  });
  return within<PageReadResult>(work, HARD_STOP_MS, {
    ok: false,
    url: target.toString(),
    message: "That page took too long to show anything."
  });
}

async function readRenderedPage(target: URL): Promise<PageReadResult> {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition: PARTITION,
      session: hardenedSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      // The whole point is to run the page's own scripts, which is safe only
      // because this window can reach nothing: no Node, no preload, no bridge.
      javascript: true,
      backgroundThrottling: false
    }
  });

  // A page may not open windows, and may not leave http or https. Without the
  // second guard a redirect to file:// would turn a page read into reading the
  // user's disk.
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const blockOtherSchemes = (event: Electron.Event, url: string): void => {
    if (!/^https?:\/\//i.test(url)) event.preventDefault();
  };
  window.webContents.on("will-navigate", blockOtherSchemes);
  window.webContents.on("will-redirect", blockOtherSchemes);

  const startedAt = Date.now();
  try {
    // Start the load but never wait on it finishing, because on a real page it
    // often does not. A site holding a connection open for live updates, or one
    // whose bot check keeps a request in flight, leaves this promise pending
    // long after the article is on the screen and perfectly readable. Waiting
    // for it was what made a page that renders in eight seconds report, at
    // twelve, that it could not be opened. What the load promise is good for is
    // its rejection, which is the one clear signal that nothing will arrive.
    let loadFailed = false;
    let loadSettled = false;
    void window
      .loadURL(target.toString())
      .catch(() => {
        loadFailed = true;
      })
      .finally(() => {
        loadSettled = true;
      });

    // Poll until the text stops changing. Content arrives in stages (shell
    // first, then the frame, then the frame's text), so an early look would
    // read a half-drawn page and a fixed wait would either cut it off or make
    // every quick page slow.
    let text = "";
    let stable = 0;
    const deadline = startedAt + OVERALL_BUDGET_MS;
    while (Date.now() < deadline) {
      if (window.isDestroyed()) break;
      const current = await textFromAllFrames(window);
      if (process.env["WORKCREW_DEBUG_PAGE_READER"]) console.log("[poll]", Date.now() - startedAt, current.length);
      if (current === text && current.length >= MIN_MEANINGFUL_CHARS) {
        stable += 1;
        // A page with real content on it is believed as soon as it holds still.
        // A nearly empty one is not believed at all until the browser has also
        // stopped loading it, because "a hundred characters, unchanged" is what
        // a wrapper looks like for the several seconds before the frame holding
        // the document arrives, and accepting it then means answering the user
        // from a disclaimer.
        const substantial = current.length >= SUBSTANTIAL_CHARS;
        const enough = substantial ? STABLE_POLLS : STABLE_POLLS_WHEN_THIN;
        // isLoading covers every frame, not just the top one, which is the
        // distinction that matters: it is still true while the frame carrying
        // the document is on its way, and already false on a genuinely short
        // page that has simply finished.
        const quiet = loadSettled && !window.webContents.isLoading();
        if (stable >= enough && (substantial || quiet)) break;
      } else {
        stable = 0;
      }
      text = current;
      // Nothing loaded and the load itself already failed: there is nothing
      // left to wait for.
      if (loadFailed && !text) break;
      await wait(POLL_INTERVAL_MS);
    }

    if (text.length < MIN_MEANINGFUL_CHARS) {
      const ranOut = Date.now() >= deadline;
      return {
        ok: false,
        url: target.toString(),
        message: loadFailed
          ? "That page could not be opened."
          : ranOut
            ? "That page took too long to show anything."
            : "That page opened but had almost no readable text on it."
      };
    }

    const title = window.isDestroyed() ? "" : window.webContents.getTitle().slice(0, 200);
    return {
      ok: true,
      url: target.toString(),
      title,
      text: text.slice(0, MAX_TEXT_CHARS),
      truncated: text.length > MAX_TEXT_CHARS
    };
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}
