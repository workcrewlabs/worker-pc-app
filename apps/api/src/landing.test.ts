import { describe, expect, it } from "vitest";
import { landingPage } from "./landing.js";

describe("landingPage", () => {
  it("renders the brand, a download button, and sign in/up controls", () => {
    const html = landingPage("https://example.com/WorkCrew-Setup.exe");
    expect(html).toContain("WorkCrew");
    expect(html).toContain("Download for Windows");
    expect(html).toContain("https://example.com/WorkCrew-Setup.exe");
    expect(html.toLowerCase()).toContain("sign in");
    expect(html).toContain("/v1/auth/sign-up");
    // No provider or vendor names leak onto the public page.
    expect(html).not.toContain("Anthropic");
    expect(html).not.toContain("Claude");
    expect(html).not.toContain("Playwright");
  });

  it("marks the download button when no link is configured", () => {
    const html = landingPage("");
    expect(html).toContain('data-missing="1"');
  });
});
