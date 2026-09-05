import { describe, expect, it } from "vitest";
import {
  browserUserAgent,
  combineFrameText,
  describePage,
  findLinks,
  MAX_CONTEXT_CHARS,
  mergeContext,
  tidyPageText
} from "./page-text";

// The failure these exist for: a user pasted a claude.ai artifact link and was
// told the app could not open it, while another tool read it fine. Fetching a
// URL only ever returns the HTML the server sends, and that page sends an empty
// shell it fills in with JavaScript. The app now opens such a link in a real
// browser window; this file covers the text side of that.

describe("finding the link in what the user typed", () => {
  it("finds a link sitting in the middle of a sentence", () => {
    const text = "no this is incorrect https://claude.ai/code/artifact/9300361a this link has general acess";
    expect(findLinks(text)).toEqual(["https://claude.ai/code/artifact/9300361a"]);
  });

  it("leaves the punctuation that ended the sentence out of the address", () => {
    expect(findLinks("have a look at https://example.com/page.")).toEqual(["https://example.com/page"]);
    expect(findLinks("(see https://example.com/a)")).toEqual(["https://example.com/a"]);
  });

  it("ignores something that is merely a domain, not a link", () => {
    // Loading a page because the user mentioned a company by name would be
    // both slow and wrong.
    expect(findLinks("workcrew.com is down and report.pdf is stale")).toEqual([]);
  });

  it("refuses schemes that are not the web", () => {
    // file:// would turn reading a page into reading the user's disk.
    expect(findLinks("open file:///C:/Users/secret.txt now")).toEqual([]);
    expect(findLinks("mail me at mailto:someone@example.com")).toEqual([]);
  });

  it("reads the same link twice as one page", () => {
    const text = "https://example.com/a and again https://example.com/a";
    expect(findLinks(text)).toEqual(["https://example.com/a"]);
  });

  it("stops after a couple of links so one message cannot open a dozen pages", () => {
    const text = "https://a.example https://b.example https://c.example https://d.example";
    expect(findLinks(text)).toHaveLength(2);
  });
});

describe("putting the frames of a page back together", () => {
  it("keeps the iframe's content, which is where an artifact actually lives", () => {
    const shell = "Content is user-generated and unverified.";
    const artifact = "OPERATING MANUAL\nShipping WorkCrew\nHow to change WorkCrew and get that change to users.";
    expect(combineFrameText([shell, artifact])).toContain("Shipping WorkCrew");
    expect(combineFrameText([shell, artifact])).toContain(shell);
  });

  it("does not tell the model the same sentence twice", () => {
    // The main frame is read once as itself and once as a member of the
    // subtree, so without this every page would arrive doubled.
    const text = "The quarterly report is late.";
    expect(combineFrameText([text, text])).toBe(text);
  });

  it("prefers the fuller version when one frame contains another", () => {
    const short = "Shipping WorkCrew";
    const full = "Shipping WorkCrew and the steps that go with it.";
    expect(combineFrameText([short, full])).toBe(full);
  });

  it("drops frames that had nothing in them", () => {
    expect(combineFrameText(["", "   ", "\n\n", "Real text here."])).toBe("Real text here.");
  });
});

describe("tidying what a rendered page hands back", () => {
  it("collapses the blank space a layout leaves behind", () => {
    expect(tidyPageText("Title\n\n\n\n\nBody   text\t\there")).toBe("Title\n\nBody text here");
  });

  it("keeps paragraphs apart", () => {
    expect(tidyPageText("First para\n\nSecond para")).toBe("First para\n\nSecond para");
  });
});

describe("how the browser introduces itself", () => {
  const electronAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "WorkCrew/0.1.47 Chrome/148.0.7778.265 Electron/38.0.0 Safari/537.36";

  it("drops the two words that get it stopped by a bot check", () => {
    // Measured, not guessed: with these present the same public page loaded in
    // seven seconds on one attempt and had shown nothing at eighteen on the
    // next, because it was being put through a challenge.
    const agent = browserUserAgent(electronAgent);
    expect(agent).not.toMatch(/WorkCrew|Electron/);
  });

  it("still says what it truthfully is", () => {
    const agent = browserUserAgent(electronAgent);
    expect(agent).toContain("Chrome/148.0.7778.265");
    expect(agent).toContain("Windows NT 10.0");
    expect(agent).not.toMatch(/\s{2,}/);
  });
});

describe("making room for the page in the turn's context", () => {
  it("keeps the working folder's listing and adds the page after it", () => {
    const merged = mergeContext("Working folder: D:\\reports", "PAGE TEXT");
    expect(merged.startsWith("Working folder: D:\\reports")).toBe(true);
    expect(merged).toContain("PAGE TEXT");
  });

  it("never exceeds what the contract will accept", () => {
    // A rejected request would lose the user's message entirely, so the page is
    // what gets cut, not the send.
    const merged = mergeContext("x".repeat(20_000), "y".repeat(20_000));
    expect(merged.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(merged.startsWith("x".repeat(20_000))).toBe(true);
  });

  it("gives up its own place rather than trimming what was already there", () => {
    const full = "x".repeat(MAX_CONTEXT_CHARS);
    expect(mergeContext(full, "page")).toBe(full);
  });

  it("works when there was no context at all", () => {
    expect(mergeContext(undefined, "PAGE")).toBe("PAGE");
  });
});

describe("handing the page to the model", () => {
  const page = { ok: true, url: "https://example.com/a", title: "Report", text: "Revenue rose.", truncated: false } as const;

  it("labels it as something to read, not something to obey", () => {
    // The text is a stranger's web page. Saying so is what keeps an instruction
    // written into a page from being treated as the user asking for it.
    expect(describePage(page)).toMatch(/not instructions to follow/i);
  });

  it("says where it came from so the model can attribute it", () => {
    const described = describePage(page);
    expect(described).toContain("https://example.com/a");
    expect(described).toContain("Report");
    expect(described).toContain("Revenue rose.");
  });

  it("admits when the page was longer than what was taken", () => {
    expect(describePage({ ...page, truncated: true })).toMatch(/rest was not included/i);
  });
});
