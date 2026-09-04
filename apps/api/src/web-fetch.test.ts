import { describe, expect, it } from "vitest";
import { fetchReadablePage, isPrivateAddress, isPrivateIPv4, isPrivateIPv6, stripHtml } from "./web-fetch.js";

// Letting the model make our own backend fetch an address it chooses is real
// attack surface: a request, crafted directly or by content the model reads
// elsewhere, reaching somewhere only meant to be reachable from inside our own
// network. Every one of these pins a range that must stay refused.

describe("which IPv4 addresses are refused", () => {
  it("refuses the private ranges", () => {
    for (const ip of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1"]) {
      expect(isPrivateIPv4(ip)).toBe(true);
    }
  });

  it("refuses loopback and link-local, including the cloud metadata address", () => {
    expect(isPrivateIPv4("127.0.0.1")).toBe(true);
    expect(isPrivateIPv4("169.254.169.254")).toBe(true); // AWS/GCP/Azure metadata endpoint
  });

  it("allows an ordinary public address", () => {
    expect(isPrivateIPv4("8.8.8.8")).toBe(false);
    expect(isPrivateIPv4("93.184.216.34")).toBe(false);
  });

  it("refuses something that is not really an IPv4 address at all", () => {
    expect(isPrivateIPv4("999.1.1.1")).toBe(true);
    expect(isPrivateIPv4("not-an-ip")).toBe(true);
  });

  it("does not confuse 172.15 or 172.32 with the private 172.16-31 band", () => {
    expect(isPrivateIPv4("172.15.0.1")).toBe(false);
    expect(isPrivateIPv4("172.32.0.1")).toBe(false);
  });
});

describe("which IPv6 addresses are refused", () => {
  it("refuses loopback, link-local, and unique-local", () => {
    expect(isPrivateIPv6("::1")).toBe(true);
    expect(isPrivateIPv6("fe80::1")).toBe(true);
    expect(isPrivateIPv6("fd00::1")).toBe(true);
  });

  it("looks inside an IPv4-mapped address rather than trusting the wrapper", () => {
    expect(isPrivateIPv6("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIPv6("::ffff:8.8.8.8")).toBe(false);
  });

  it("allows an ordinary public IPv6 address", () => {
    expect(isPrivateIPv6("2001:4860:4860::8888")).toBe(false);
  });
});

describe("isPrivateAddress", () => {
  it("refuses anything that is not a literal IP at all, rather than guessing", () => {
    expect(isPrivateAddress("example.com")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });
});

describe("turning a page into readable text", () => {
  it("keeps the visible words and drops the tags", () => {
    const html = "<html><body><h1>Cedar Supplies</h1><p>Invoice total: 813.08</p></body></html>";
    expect(stripHtml(html).text).toContain("Cedar Supplies");
    expect(stripHtml(html).text).toContain("Invoice total: 813.08");
    expect(stripHtml(html).text).not.toContain("<");
  });

  it("never returns script or style content as if it were prose", () => {
    const html = "<html><head><style>.x{color:red}</style></head><body>" +
      "<script>alert('hi')</script><p>Real content here.</p></body></html>";
    const { text } = stripHtml(html);
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("alert");
    expect(text).toContain("Real content here.");
  });

  it("separates paragraphs instead of running them together", () => {
    const html = "<p>First paragraph.</p><p>Second paragraph.</p>";
    const text = stripHtml(html).text;
    expect(text).toContain("First paragraph.");
    expect(text).toContain("Second paragraph.");
    expect(text.indexOf("First")).toBeLessThan(text.indexOf("Second"));
    expect(text).toMatch(/paragraph\.\nSecond/); // a real break, not run onto the same line
  });

  it("reads the title", () => {
    expect(stripHtml("<title>Shipping WorkCrew</title><body>x</body>").title).toBe("Shipping WorkCrew");
  });

  it("decodes the entities that actually show up in body text", () => {
    const html = "<p>Bread &amp; butter &mdash; well, &quot;almost&quot;.</p>";
    expect(stripHtml(html).text).toContain("Bread & butter");
    expect(stripHtml(html).text).toContain("\"almost\"");
  });

  it("comes back nearly empty for a page that renders in the browser, not in the response", () => {
    // A close cousin of what a claude.ai artifact page's raw HTML looks like:
    // scripts and metadata, and no actual prose anywhere in the markup.
    const shell = "<html><head><script>window.__x=1;var y=function(){return {a:1,b:2}}</script>" +
      "<meta property=\"og:title\" content=\"Claude Artifact\"></head><body><div id=\"root\"></div></body></html>";
    expect(stripHtml(shell).text.length).toBeLessThan(50);
  });
});

describe("what fetchReadablePage refuses before ever making a request", () => {
  it("refuses something that is not a URL", () => {
    return fetchReadablePage("not a url").then((result) => expect(result.ok).toBe(false));
  });

  it("refuses a scheme that is not http or https", () => {
    return fetchReadablePage("file:///etc/passwd").then((result) => expect(result.ok).toBe(false));
  });

  it("refuses a loopback address outright, with no request ever sent", () => {
    // This is the core SSRF guard: the address check runs before fetch() is
    // called at all, so nothing needs to be listening on 127.0.0.1 for this to
    // prove the refusal.
    return fetchReadablePage("http://127.0.0.1/admin").then((result) => {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toBe("That address cannot be read.");
    });
  });

  it("refuses the cloud metadata address the same way", () => {
    return fetchReadablePage("http://169.254.169.254/latest/meta-data/").then((result) => expect(result.ok).toBe(false));
  });
});
