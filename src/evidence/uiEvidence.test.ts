import { describe, expect, it } from "vitest";
import type { UiConfig } from "../kit/config.ts";
import { type CaptureResult, isUi, parseCaptureResult, routesFor } from "./uiEvidence.ts";

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

/** A Ticket body in the shape a Design session writes, naming these routes. */
const ticket = (whatToBuild: string) =>
  ["## Parent", "", "#12", "", "## What to build", "", whatToBuild, "", "## Acceptance criteria", "", "- [ ] It works"].join("\n");

describe("The routes UI evidence captures", () => {
  it("are the routes the Ticket names, as paths in backticks, each with its reason", () => {
    const body = ticket("Add a waitlist to full days on `/book`, and link it from `/services/physio`.");

    expect(routesFor(body, [], ["/"])).toEqual([
      { route: "/book", reason: "ticket" },
      { route: "/services/physio", reason: "ticket" },
    ]);
  });

  it("count only a code span that is one path starting with a single /, never other code or a bare path", () => {
    const body = ticket(
      [
        "Change `src/pages/book.astro` so /book shows a waitlist, then run `npm run build`.",
        "Don't load `//cdn.example.com/widget.js`, keep `GET /api/slots` as it is, and leave `/book now` alone.",
        "The home page, `/`, links to it.",
      ].join("\n"),
    );

    expect(routesFor(body, [], [])).toEqual([{ route: "/", reason: "ticket" }]);
  });

  it("never count a path in a fenced code block, which is quoted, not named", () => {
    const body = ticket(
      [
        "Show the waitlist on `/book`. The router already has:",
        "",
        "```ts",
        "const routes = { book: `/book/legacy`, admin: `/admin` };",
        "```",
      ].join("\n"),
    );

    expect(routesFor(body, [], [])).toEqual([{ route: "/book", reason: "ticket" }]);
  });

  it("go on with the Implementer's routes after the Ticket's, and leave out the defaults", () => {
    const body = ticket("Add a waitlist to full days on `/book`.");

    expect(routesFor(body, ["/book/waitlist", "/"], ["/services", "/contact"])).toEqual([
      { route: "/book", reason: "ticket" },
      { route: "/book/waitlist", reason: "implementer" },
      { route: "/", reason: "implementer" },
    ]);
  });

  it("are the Implementer's alone when the Ticket names none", () => {
    expect(routesFor(ticket("Add a waitlist to full days."), ["/book"], ["/"])).toEqual([
      { route: "/book", reason: "implementer" },
    ]);
  });

  it("fall back to ui.default_routes when neither the Ticket nor the Implementer names any", () => {
    expect(routesFor(ticket("Tighten the spacing in the footer."), [], ["/", "/book", "/services"])).toEqual([
      { route: "/", reason: "default" },
      { route: "/book", reason: "default" },
      { route: "/services", reason: "default" },
    ]);
  });

  it("hold each route once, with the reason it was first named for", () => {
    const body = ticket("Add a waitlist to `/book`. The waitlist shows on `/book` only when the day is full.");

    expect(routesFor(body, ["/book", "/book/waitlist", "/book/waitlist"], ["/"])).toEqual([
      { route: "/book", reason: "ticket" },
      { route: "/book/waitlist", reason: "implementer" },
    ]);
  });

  it("hold each default route once", () => {
    expect(routesFor(ticket("Tighten the footer."), [], ["/", "/book", "/"])).toEqual([
      { route: "/", reason: "default" },
      { route: "/book", reason: "default" },
    ]);
  });

  it("stop at four, trimming the Implementer's routes after the Ticket's", () => {
    const body = ticket("Add a waitlist to `/book` and show it on `/book/physio`.");

    expect(routesFor(body, ["/book", "/book/massage", "/book/pilates", "/book/hydro"], [])).toEqual([
      { route: "/book", reason: "ticket" },
      { route: "/book/physio", reason: "ticket" },
      { route: "/book/massage", reason: "implementer" },
      { route: "/book/pilates", reason: "implementer" },
    ]);
  });

  it("keep every route the Ticket names, even past four, and then take none of the Implementer's", () => {
    const body = ticket("Restyle `/`, `/book`, `/services`, `/about`, `/contact` and `/blog`.");

    expect(routesFor(body, ["/pricing"], ["/faq"]).map(({ route, reason }) => `${reason} ${route}`)).toEqual([
      "ticket /",
      "ticket /book",
      "ticket /services",
      "ticket /about",
      "ticket /contact",
      "ticket /blog",
    ]);
  });

  it("stop at four default routes too", () => {
    const defaults = ["/", "/book", "/services", "/about", "/contact"];

    expect(routesFor(ticket("Tighten the footer."), [], defaults).map(({ route }) => route)).toEqual([
      "/",
      "/book",
      "/services",
      "/about",
    ]);
  });

  it("are none at all when nothing names a route and there are no defaults, which capture records as no-routes", () => {
    expect(routesFor(ticket("Tighten the spacing in the footer."), [], [])).toEqual([]);
  });
});

const HEAD = "4f2b9c0d1e3a5b7c9d0e1f2a3b4c5d6e7f8a9b0c";

/** A capture result as the capture step writes it, for the Ticket's /book and a default /. */
const captured: CaptureResult = {
  outcome: "captured",
  headSha: HEAD,
  captures: [
    { route: "/book", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-book.png" },
    { route: "/book", reason: "ticket", viewport: "desktop", side: "after", status: 200, image: "after-desktop-book.png" },
    { route: "/book", reason: "ticket", viewport: "mobile", side: "before", status: 200, image: "before-mobile-book.png" },
    { route: "/", reason: "default", viewport: "mobile", side: "after", status: 503, image: "after-mobile-home.png" },
  ],
};

describe("The capture result", () => {
  it("reads back exactly as the capture step wrote it", () => {
    expect(parseCaptureResult(JSON.stringify(captured))).toEqual({ ok: true, result: captured });
  });

  it.each([
    { outcome: "failed", reason: "server-did-not-start", headSha: HEAD, captures: [] },
    { outcome: "failed", reason: "no-routes", headSha: HEAD, captures: [] },
    { outcome: "failed", reason: "error", headSha: HEAD, captures: [] },
    // A capture that ran out of time keeps the screenshots it took first.
    { outcome: "failed", reason: "timeout", headSha: HEAD, captures: captured.captures.slice(0, 2) },
  ] satisfies CaptureResult[])("reads back a failed capture with its reason: $reason", (failed) => {
    expect(parseCaptureResult(JSON.stringify(failed))).toEqual({ ok: true, result: failed });
  });

  /** The captured result with these fields changed; undefined leaves a field out. */
  const withResult = (changes: Record<string, unknown>) => JSON.stringify({ ...captured, ...changes });
  /** The captured result with its first capture's fields changed. */
  const withCapture = (changes: Record<string, unknown>) =>
    JSON.stringify({ ...captured, captures: [{ ...captured.captures[0], ...changes }, ...captured.captures.slice(1)] });

  it.each([
    ["text that isn't JSON", "{ outcome: captured", "the capture result is not valid JSON"],
    ["a list", "[]", "the capture result must be a JSON object"],
    ["null", "null", "the capture result must be a JSON object"],
    ["an unknown outcome", withResult({ outcome: "partial" }), `outcome must be "captured" or "failed"`],
    ["no head SHA", withResult({ headSha: undefined }), "headSha must be a full commit SHA"],
    ["a short head SHA", withResult({ headSha: "4f2b9c0" }), "headSha must be a full commit SHA"],
    ["captures that aren't a list", withResult({ captures: { "/book": [] } }), "captures must be a list"],
    ["a capture outcome with no captures", withResult({ captures: [] }), `captures can't be empty when the outcome is "captured"`],
    ["a failed outcome with no reason", withResult({ outcome: "failed" }), "reason must be server-did-not-start, timeout, no-routes or error"],
    [
      "a failed outcome with an unknown reason",
      withResult({ outcome: "failed", reason: "flaky" }),
      "reason must be server-did-not-start, timeout, no-routes or error",
    ],
    ["a capture that isn't an object", withResult({ captures: ["after-mobile-book.png"] }), "captures[0] must be an object"],
    ["a route that isn't a path", withCapture({ route: "book" }), "captures[0].route must be a path starting with one /"],
    ["a route that leaves for another host", withCapture({ route: "//example.com/book" }), "captures[0].route must be a path starting with one /"],
    ["an unknown route reason", withCapture({ reason: "reviewer" }), "captures[0].reason must be ticket, implementer or default"],
    ["an unknown viewport", withCapture({ viewport: "tablet" }), "captures[0].viewport must be mobile or desktop"],
    ["an unknown side", withCapture({ side: "during" }), "captures[0].side must be before or after"],
    ["a status that isn't a number", withCapture({ status: "200" }), "captures[0].status must be an HTTP status from 100 to 599"],
    ["a status out of range", withCapture({ status: 700 }), "captures[0].status must be an HTTP status from 100 to 599"],
    ["a fractional status", withCapture({ status: 200.5 }), "captures[0].status must be an HTTP status from 100 to 599"],
    ["no image", withCapture({ image: undefined }), "captures[0].image must be a plain file name"],
  ])("refuses %s, naming the problem", (_, text, error) => {
    expect(parseCaptureResult(text)).toEqual({ ok: false, errors: [expect.stringContaining(error)] });
  });

  // The gallery and the Review job open each image by this name in the capture's folder, so it can't lead out of it.
  it.each(["../agent-result.json", "..", "shots/after-mobile-book.png", "/etc/passwd", "shots\\after.png", ".after.png", "", "after mobile.png"])(
    "refuses an image name that isn't a plain file name: %j",
    (image) => {
      expect(parseCaptureResult(withCapture({ image }))).toEqual({
        ok: false,
        errors: ["captures[0].image must be a plain file name, such as after-mobile-book.png, with no / or .."],
      });
    },
  );

  it("refuses two captures in the same image file", () => {
    const [first, second] = captured.captures;
    const text = JSON.stringify({ ...captured, captures: [first, { ...second, image: first!.image }] });

    expect(parseCaptureResult(text)).toEqual({ ok: false, errors: ["captures[1].image after-mobile-book.png is captures[0]'s too"] });
  });

  it("refuses two captures of the same route, viewport and side", () => {
    const [first, second] = captured.captures;
    const text = JSON.stringify({ ...captured, captures: [first, { ...second, viewport: "mobile" }] });

    expect(parseCaptureResult(text)).toEqual({
      ok: false,
      errors: ["captures[1] is /book at mobile, after, which captures[0] already is"],
    });
  });

  it("names every problem at once", () => {
    const text = JSON.stringify({
      outcome: "failed",
      reason: "flaky",
      headSha: "main",
      captures: [captured.captures[0], { ...captured.captures[1], side: "during", status: 0 }],
    });

    expect(parseCaptureResult(text)).toEqual({
      ok: false,
      errors: [
        "reason must be server-did-not-start, timeout, no-routes or error",
        "headSha must be a full commit SHA",
        "captures[1].side must be before or after",
        "captures[1].status must be an HTTP status from 100 to 599",
      ],
    });
  });
});
