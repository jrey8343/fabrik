import { describe, expect, it } from "vitest";
import type { UiConfig } from "../kit/config.ts";
import { isUi } from "./uiEvidence.ts";

/** The Pilot's ui block: an Astro site served from its build. */
const ui: UiConfig = {
  paths: ["src/**/*.astro", "src/components/**", "public/**"],
  serve: "node ./dist/server/entry.mjs",
  url: "http://127.0.0.1:4321",
  beforeUrl: "https://www.penrithphysio.com.au",
  defaultRoutes: ["/", "/book", "/services"],
};

describe("Whether a pull request is UI", () => {
  it("is true when a changed path matches one of ui.paths' globs", () => {
    expect(isUi(["src/lib/booking.ts", "src/pages/book.astro"], ui)).toBe(true);
  });

  it("is true for a file deep under a folder glob", () => {
    expect(isUi(["src/components/booking/Calendar.tsx"], ui)).toBe(true);
  });

  it("is false when no changed path matches any of them", () => {
    expect(isUi(["src/lib/booking.ts", "README.md", "src/pages/api/book.ts"], ui)).toBe(false);
  });

  it("is false for an empty diff", () => {
    expect(isUi([], ui)).toBe(false);
  });

  it("is false without a ui block, whatever changed", () => {
    expect(isUi(["src/pages/book.astro", "src/components/Header.astro"], null)).toBe(false);
  });
});
