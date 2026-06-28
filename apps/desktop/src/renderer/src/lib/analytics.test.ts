import { describe, expect, it, vi } from "vitest";
import { identifyUser, track } from "./analytics";

// The renderer wrapper must never throw into the UI, even when the desktop bridge
// is missing (as in tests) or a capture call rejects. It is a thin, fail-safe
// passthrough; the real send happens in the main process.
describe("renderer analytics wrapper", () => {
  it("is a safe no-op when window.workcrew is absent", () => {
    expect(() => track("app_opened")).not.toThrow();
    expect(() => track("file_download_clicked", { ext: "csv" })).not.toThrow();
    expect(() => identifyUser()).not.toThrow();
  });

  it("forwards the event and props to the bridge when present", () => {
    const capture = vi.fn().mockResolvedValue({ ok: true });
    const identify = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("window", { workcrew: { analytics: { capture, identify } } });
    try {
      track("routine_created", { cadence: "daily" });
      identifyUser();
      expect(capture).toHaveBeenCalledWith("routine_created", { cadence: "daily" });
      expect(identify).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
