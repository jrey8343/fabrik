import { describe, expect, it } from "vitest";
import { asAnEarlierReleaseWroteIt } from "../__fixtures__/earlierEvidenceWording.ts";
import type { UiConfig } from "../kit/config.ts";
import {
  type Capture,
  type CaptureFailure,
  type CaptureResult,
  evidenceMarkerIn,
  evidenceSection,
  isUi,
  type MissedShot,
  parseCaptureResult,
  reviewerEvidenceBlock,
  reviewerImages,
  routesFor,
  type UiEvidence,
  type VariantCapture,
  withoutEvidence,
  withPreviewLink,
} from "./uiEvidence.ts";

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

/** A Prototype of /book in three variants, each captured at both viewports, as a prototype turn's capture writes it: C's desktop video wasn't recorded. */
const variantCaptures: VariantCapture[] = [
  { route: "/book", variant: "A", viewport: "mobile", status: 200, image: "variant-a-mobile.png", video: "variant-a-mobile.webm" },
  { route: "/book", variant: "A", viewport: "desktop", status: 200, image: "variant-a-desktop.png", video: "variant-a-desktop.webm" },
  { route: "/book", variant: "B", viewport: "mobile", status: 200, image: "variant-b-mobile.png", video: "variant-b-mobile.webm" },
  { route: "/book", variant: "B", viewport: "desktop", status: 200, image: "variant-b-desktop.png", video: "variant-b-desktop.webm" },
  { route: "/book", variant: "C", viewport: "mobile", status: 200, image: "variant-c-mobile.png", video: "variant-c-mobile.webm" },
  { route: "/book", variant: "C", viewport: "desktop", status: 200, image: "variant-c-desktop.png" },
];

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

  it("reads back a prototype turn's capture of its variants exactly as written, each with its video where it recorded one", () => {
    const prototype: CaptureResult = { outcome: "captured", headSha: HEAD, captures: variantCaptures };

    expect(parseCaptureResult(JSON.stringify(prototype))).toStrictEqual({ ok: true, result: prototype });
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
    ["a failed outcome with no reason", withResult({ outcome: "failed" }), "reason must be build-failed, server-did-not-start, timeout, no-routes, no-variants, sign-in-failed, unreachable, error or no-result"],
    [
      "a failed outcome with an unknown reason",
      withResult({ outcome: "failed", reason: "flaky" }),
      "reason must be build-failed, server-did-not-start, timeout, no-routes, no-variants, sign-in-failed, unreachable, error or no-result",
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

  // The Evidence page and the Review job open each image by this name in the capture's folder, so it can't lead out of it.
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
        "reason must be build-failed, server-did-not-start, timeout, no-routes, no-variants, sign-in-failed, unreachable, error or no-result",
        "headSha must be a full commit SHA",
        "captures[1].side must be before or after",
        "captures[1].status must be an HTTP status from 100 to 599",
      ],
    });
  });
});

describe("A prototype turn's capture result", () => {
  const prototype: CaptureResult = { outcome: "captured", headSha: HEAD, captures: variantCaptures };
  /** The prototype's result with its first two captures' fields changed; undefined leaves a field out. */
  const withVariants = (first: Record<string, unknown>, second: Record<string, unknown> = {}) =>
    JSON.stringify({
      ...prototype,
      captures: [{ ...variantCaptures[0], ...first }, { ...variantCaptures[1], ...second }, ...variantCaptures.slice(2)],
    });

  it("reads back a capture that ran out of time with the variants it took first", () => {
    const failed: CaptureResult = { outcome: "failed", reason: "timeout", headSha: HEAD, captures: variantCaptures.slice(0, 3) };

    expect(parseCaptureResult(JSON.stringify(failed))).toEqual({ ok: true, result: failed });
  });

  it("reads back a capture that had no variant to capture", () => {
    const failed: CaptureResult = { outcome: "failed", reason: "no-variants", headSha: HEAD, captures: [] };

    expect(parseCaptureResult(JSON.stringify(failed))).toEqual({ ok: true, result: failed });
  });

  it.each([
    ["a letter past the cap",withVariants({ variant: "F" }), "captures[0].variant must be A, B, C, D or E"],
    ["a lowercase letter", withVariants({ variant: "a" }), "captures[0].variant must be A, B, C, D or E"],
    ["a variant's capture that has a side too", withVariants({ side: "after" }), "captures[0] must have a side or a variant, not both"],
    ["an image name that isn't a plain file name", withVariants({ image: "../a.png" }), "captures[0].image must be a plain file name, such as variant-a-mobile.png, with no / or .."],
    ["a video name that isn't a plain file name", withVariants({ video: "videos/a.webm" }), "captures[0].video must be a plain file name, such as variant-a-mobile.webm, with no / or .."],
    ["a video name that isn't a string", withVariants({ video: null }), "captures[0].video must be a plain file name, such as variant-a-mobile.webm, with no / or .."],
    ["two captures of the same variant at the same viewport", withVariants({}, { viewport: "mobile" }), "captures[1] is /book at mobile, variant A, which captures[0] already is"],
    ["a video in another capture's video file", withVariants({}, { video: "variant-a-mobile.webm" }), "captures[1].video variant-a-mobile.webm is captures[0]'s too"],
    ["a video in another capture's image file", withVariants({}, { video: "variant-a-mobile.png" }), "captures[1].video variant-a-mobile.png is captures[0]'s too"],
  ])("refuses %s, naming the problem", (_, text, error) => {
    expect(parseCaptureResult(text)).toEqual({ ok: false, errors: [error] });
  });
});

const EVIDENCE_PAGE = "https://github.com/acme/shop/actions/runs/9100/artifacts/9201";

/** The evidence the push job puts together for a UI PR's body: this result, kept by run 9100, with no preview declared. */
const evidence = (result: CaptureResult, changes: Partial<UiEvidence> = {}): UiEvidence => ({
  result,
  run: 9100,
  artifact: 9202,
  evidencePage: EVIDENCE_PAGE,
  preview: { kind: "none" },
  ...changes,
});

/** Every capture 200 OK: the Ticket's /book at both viewports and sides, and the Implementer's /book/waitlist at both viewports, After only. */
const allCaptured: CaptureResult<Capture> = {
  outcome: "captured",
  headSha: HEAD,
  captures: [
    { route: "/book", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-book.png" },
    { route: "/book", reason: "ticket", viewport: "desktop", side: "after", status: 200, image: "after-desktop-book.png" },
    { route: "/book/waitlist", reason: "implementer", viewport: "mobile", side: "after", status: 200, image: "after-mobile-book-waitlist.png" },
    { route: "/book/waitlist", reason: "implementer", viewport: "desktop", side: "after", status: 200, image: "after-desktop-book-waitlist.png" },
    { route: "/book", reason: "ticket", viewport: "mobile", side: "before", status: 200, image: "before-mobile-book.png" },
    { route: "/book", reason: "ticket", viewport: "desktop", side: "before", status: 200, image: "before-desktop-book.png" },
  ],
};

describe("The evidence section a UI PR's body carries", () => {
  it("links the Evidence page, lists each captured route with why it was chosen, and ends with the marker naming where the images are kept", () => {
    expect(evidenceSection(evidence(allCaptured))).toBe(
      [
        "<!-- fabrik:ui-evidence-start -->",
        "## UI evidence",
        "",
        `[Open the Evidence page](<${EVIDENCE_PAGE}>) of 6 screenshots: this branch at \`4f2b9c0\` beside the production site, at mobile and desktop widths.`,
        "",
        "No preview link: Kit config declares no `preview.url`.",
        "",
        "Captured routes:",
        "",
        "- `/book`, named by the Ticket",
        "- `/book/waitlist`, named by the Implementer",
        `<!-- fabrik:ui-evidence {"run":9100,"artifact":9202,"failure":null,"routes":["/book","/book/waitlist"],"preview":{"is":"none"}} -->`,
      ].join("\n"),
    );
  });

  it("records the routes it lists, in its order, and that the preview waits on the push when Kit config declares one", () => {
    const result: CaptureResult = {
      ...allCaptured,
      captures: [
        { route: "/", reason: "default", viewport: "mobile", side: "after", status: 200, image: "after-mobile-home.png" },
        ...allCaptured.captures.toReversed(),
      ],
    };

    expect(evidenceMarkerIn(evidenceSection(evidence(result, { preview: { kind: "pending" } })))).toEqual({
      run: 9100,
      artifact: 9202,
      failure: null,
      routes: ["/book", "/book/waitlist", "/"],
      preview: { is: "pending" },
    });
  });

  // The Reviewer, and the Ticket's UI evidence, get nothing from a Prototype.
  it("leaves out every capture of a Prototype's variant, in its counts, its widths and its routes", () => {
    const [first, ...rest] = allCaptured.captures;
    const mixed: CaptureResult = { ...allCaptured, captures: [variantCaptures[0]!, first!, ...variantCaptures.slice(1), ...rest] };

    expect(evidenceSection(evidence(mixed))).toBe(evidenceSection(evidence(allCaptured)));
  });
});

describe("The evidence section's Evidence page line", () => {
  it("says so when the run kept the screenshots but no Evidence page of them", () => {
    const lines = evidenceSection(evidence(allCaptured, { evidencePage: null })).split("\n");

    expect(lines).toContain("The Implement run kept no Evidence page of its 6 screenshots.");
    expect(lines.some((line) => line.includes("Open the Evidence page"))).toBe(false);
  });
});

describe("An evidence section an earlier release wrote, naming the Evidence page by its old word", () => {
  it.each([
    ["linking its Evidence page", EVIDENCE_PAGE],
    ["saying it kept none", null],
  ])("still has its marker found, %s", (_, evidencePage) => {
    const body = asAnEarlierReleaseWroteIt(`Adds a waitlist to full days.\n\n${evidenceSection(evidence(allCaptured, { evidencePage }))}\n\nCloses #12`);

    expect(evidenceMarkerIn(body)).toEqual({ run: 9100, artifact: 9202, failure: null, routes: ["/book", "/book/waitlist"], preview: { is: "none" } });
  });
});

describe("The evidence section's preview line", () => {
  /** The section's lines, without the marker and start lines. */
  const linesOf = (changes: Partial<UiEvidence>) => evidenceSection(evidence(allCaptured, changes)).split("\n");

  it("links the preview deployment once it answers", () => {
    const lines = linesOf({ preview: { kind: "linked", url: "https://pr-12.shop.example.dev/" } });

    expect(lines).toContain("[Open the preview deployment](<https://pr-12.shop.example.dev/>).");
    expect(lines).not.toContain("No preview link: Kit config declares no `preview.url`.");
  });

  it("says when the preview never answered, naming the address it polled but not linking it", () => {
    const lines = linesOf({ preview: { kind: "never-answered", url: "https://pr-12.shop.example.dev/" } });

    expect(lines).toContain("No preview link: the preview at `https://pr-12.shop.example.dev/` never answered.");
  });

  it("says the preview deployment is linked once it answers, before the push job has polled it", () => {
    const lines = linesOf({ preview: { kind: "pending" } });

    expect(lines).toContain("The preview deployment is linked here once it answers.");
    expect(lines.some((line) => line.startsWith("No preview link"))).toBe(false);
  });

  it("says when Kit config declares no preview", () => {
    expect(linesOf({ preview: { kind: "none" } })).toContain("No preview link: Kit config declares no `preview.url`.");
  });
});

describe("The evidence section's routes", () => {
  /** The section's route lines. */
  const routeLines = (result: CaptureResult) =>
    evidenceSection(evidence(result))
      .split("\n")
      .filter((line) => line.startsWith("- "));

  it("flag a route that answered a server error, naming each screenshot that shows the error page", () => {
    const result: CaptureResult = {
      ...allCaptured,
      captures: allCaptured.captures.map((capture) =>
        capture.route === "/book/waitlist" && capture.viewport === "mobile" ? { ...capture, status: 503 } : capture,
      ),
    };

    expect(routeLines(result)).toEqual([
      "- `/book`, named by the Ticket",
      "- `/book/waitlist`, named by the Implementer. **Server error:** it answered 503 for After at mobile, so that screenshot shows an error page, not the design.",
    ]);
  });

  it("flag every screenshot of a route that answered a server error, Before or After", () => {
    const result: CaptureResult = {
      ...allCaptured,
      captures: allCaptured.captures.map((capture) =>
        capture.route !== "/book" ? capture : { ...capture, status: capture.side === "after" ? 500 : 502 },
      ),
    };

    expect(routeLines(result)).toEqual([
      "- `/book`, named by the Ticket. **Server error:** it answered 500 for After at mobile, 500 for After at desktop, 502 for Before at mobile and 502 for Before at desktop, so those screenshots show an error page, not the design.",
      "- `/book/waitlist`, named by the Implementer",
    ]);
  });

  it("don't flag a page that answered other than with a server error", () => {
    const result: CaptureResult = {
      ...allCaptured,
      captures: allCaptured.captures.map((capture) => (capture.route === "/book/waitlist" ? { ...capture, status: 404 } : capture)),
    };

    expect(routeLines(result)).toEqual(["- `/book`, named by the Ticket", "- `/book/waitlist`, named by the Implementer"]);
  });
});

describe("The evidence section of a failed capture", () => {
  it.each([
    ["build-failed", "**Capture failed:** `sandbox.build` failed, so there was no build to serve. There are no screenshots."],
    ["server-did-not-start", "**Capture failed:** the server wouldn't start: nothing answered at `ui.url` once `ui.serve` ran. There are no screenshots."],
    ["timeout", "**Capture failed:** it ran out of time. There are no screenshots."],
    [
      "no-routes",
      "**Capture failed:** there was no route to capture: neither the Ticket nor the Implementer named one, and Kit config sets no `ui.default_routes`. There are no screenshots.",
    ],
    ["error", "**Capture failed:** it hit an error the Kit didn't expect, which the Implement job's log shows. There are no screenshots."],
    // The push job's own reason, when the Implement job passed it no capture result it could read.
    ["no-result", "**Capture failed:** it left no result the push job could read: the Implement job's log shows why. There are no screenshots."],
  ] satisfies [CaptureFailure, string][])("says plainly why when it failed for %s, with no Evidence page or routes", (reason, why) => {
    const failed: CaptureResult = { outcome: "failed", reason, headSha: HEAD, captures: [] };

    expect(evidenceSection(evidence(failed, { evidencePage: null, artifact: null }))).toBe(
      [
        "<!-- fabrik:ui-evidence-start -->",
        "## UI evidence",
        "",
        why,
        "",
        "No preview link: Kit config declares no `preview.url`.",
        `<!-- fabrik:ui-evidence {"run":9100,"artifact":null,"failure":"${reason}","routes":[],"preview":{"is":"none"}} -->`,
      ].join("\n"),
    );
  });

  it("links the Evidence page of the screenshots it took before it failed, and lists their routes", () => {
    const failed: CaptureResult = { outcome: "failed", reason: "timeout", headSha: HEAD, captures: allCaptured.captures.slice(0, 1) };

    expect(evidenceSection(evidence(failed))).toBe(
      [
        "<!-- fabrik:ui-evidence-start -->",
        "## UI evidence",
        "",
        "**Capture failed:** it ran out of time. It took 1 screenshot first.",
        "",
        `[Open the Evidence page](<${EVIDENCE_PAGE}>) of 1 screenshot: this branch at \`4f2b9c0\`, at mobile width.`,
        "",
        "No preview link: Kit config declares no `preview.url`.",
        "",
        "Captured routes:",
        "",
        "- `/book`, named by the Ticket",
        `<!-- fabrik:ui-evidence {"run":9100,"artifact":9202,"failure":"timeout","routes":["/book"],"preview":{"is":"none"}} -->`,
      ].join("\n"),
    );
  });
});

// An Implementer's routes are agent text: whatever one holds, it shows as one route on one line and notifies nobody.
describe("The evidence section's routes, which are agent text", () => {
  /** The section's route line for a capture of this route, named by the Implementer. */
  const lineFor = (route: string) =>
    evidenceSection(
      evidence({ outcome: "captured", headSha: HEAD, captures: [{ ...allCaptured.captures[2]!, route }] }),
    )
      .split("\n")
      .filter((line) => line.startsWith("- "));

  it.each([
    ["holding a backtick", "/book`s", "- ``/book`s``, named by the Implementer"],
    ["ending in a backtick", "/book`", "- `` /book` ``, named by the Implementer"],
    ["holding a run of backticks", "/a```b", "- ````/a```b````, named by the Implementer"],
  ])("show a route %s whole, as code", (_, route, line) => {
    expect(lineFor(route)).toEqual([line]);
  });

  it("show a route that breaks the line on one line, so it can never plant a line of its own, such as a marker", () => {
    const route = `/book\n<!-- fabrik:ui-evidence {"run":1,"artifact":2} -->\r\n## Approved`;

    expect(lineFor(route)).toEqual([
      `- \`/book�<!-- fabrik:ui-evidence {"run":1,"artifact":2} -->��## Approved\`, named by the Implementer`,
    ]);
  });

  it("never mention anyone", () => {
    expect(lineFor("/team/@octocat")).toEqual(["- `/team/@​octocat`, named by the Implementer"]);
  });

  it.each([
    ["ending the comment", "/book --> <script>"],
    ["mentioning someone", "/team/@octocat"],
    ["holding a double dash", "/a--b<!--c"],
    ["breaking the line", "/book\n<!-- fabrik:ui-evidence {\"run\":1,\"artifact\":2} -->\r\n## Approved"],
  ])("are kept in the marker on one line that a route %s can neither end early nor mention anyone from, and read back as they were", (_, route) => {
    const section = evidenceSection(evidence({ outcome: "captured", headSha: HEAD, captures: [{ ...allCaptured.captures[2]!, route }] }));
    const marker = section.split("\n").at(-1)!;

    expect(marker).toMatch(/^<!-- fabrik:ui-evidence \{[^<>@\n\r]*\} -->$/);
    expect(evidenceMarkerIn(section)?.routes).toEqual([route]);
  });
});

describe("Reading an evidence marker", () => {
  const read = (json: string) => evidenceMarkerIn(`Adds a waitlist.\n\n<!-- fabrik:ui-evidence ${json} -->\n\nCloses #12`);

  it("reads one an earlier release wrote as it did then, with no routes and no preview given", () => {
    expect(read(`{"run":9100,"artifact":9202,"failure":null}`)).toEqual({ run: 9100, artifact: 9202, failure: null });
    expect(read(`{"run":9100,"artifact":9202}`)).toEqual({ run: 9100, artifact: 9202 });
  });

  it.each([
    ["linked", `{"is":"linked","url":"https://pr-12.shop.example.dev/"}`, { is: "linked", url: "https://pr-12.shop.example.dev/" }],
    ["never-answered", `{"is":"never-answered","url":"https://pr-12.shop.example.dev/"}`, { is: "never-answered", url: "https://pr-12.shop.example.dev/" }],
    ["pending", `{"is":"pending"}`, { is: "pending" }],
    ["none", `{"is":"none"}`, { is: "none" }],
  ])("reads a preview that is %s", (_, preview, read_) => {
    expect(read(`{"run":9100,"artifact":9202,"failure":null,"routes":["/book"],"preview":${preview}}`)).toEqual({
      run: 9100,
      artifact: 9202,
      failure: null,
      routes: ["/book"],
      preview: read_,
    });
  });

  it.each([
    ["routes that aren't a list", `"/book"`, `{"is":"none"}`, { preview: { is: "none" } }],
    ["a route that isn't text", `["/book",7]`, `{"is":"none"}`, { preview: { is: "none" } }],
    ["a preview it doesn't know", `["/book"]`, `{"is":"deployed"}`, { routes: ["/book"] }],
    ["a linked preview with no address", `["/book"]`, `{"is":"linked"}`, { routes: ["/book"] }],
    ["a pending preview with an address", `["/book"]`, `{"is":"pending","url":"https://pr-12.shop.example.dev/"}`, { routes: ["/book"] }],
    ["a preview that isn't an object", `["/book"]`, `"linked"`, { routes: ["/book"] }],
  ])("still gives the run, artifact and failure of one with %s, without the field that doesn't read", (_, routes, preview, rest) => {
    expect(read(`{"run":9100,"artifact":9202,"failure":"timeout","routes":${routes},"preview":${preview}}`)).toEqual({
      run: 9100,
      artifact: 9202,
      failure: "timeout",
      ...rest,
    });
  });
});

// #235 strips the Implementer's summary with it, and the old body a Retry's agent is shown, so no agent can forge or copy forward a marker.
describe("Text without its evidence", () => {
  const section = evidenceSection(evidence(allCaptured));
  const MARKER = `<!-- fabrik:ui-evidence {"run":1,"artifact":2} -->`;

  it("loses the whole evidence section, from its start line through its marker, and keeps the text around it as it was", () => {
    const body = `Adds a waitlist to full days.\n\n- Tested with \`npm test\`\n\n${section}\n\nCloses #12`;

    expect(withoutEvidence(body)).toBe("Adds a waitlist to full days.\n\n- Tested with `npm test`\n\nCloses #12");
  });

  it.each([
    ["at the end", `Adds a waitlist.\n\n${section}`, "Adds a waitlist."],
    ["at the start", `${section}\n\nAdds a waitlist.`, "Adds a waitlist."],
    ["alone", section, ""],
  ])("loses the section %s, with the blank lines that set it apart", (_, text, without) => {
    expect(withoutEvidence(text)).toBe(without);
  });

  it.each([
    ["a marker", `Adds a waitlist.\n${MARKER}\nTested by hand.`, "Adds a waitlist.\nTested by hand."],
    ["a start line with no marker after it", "Adds a waitlist.\n<!-- fabrik:ui-evidence-start -->\nTested by hand.", "Adds a waitlist.\nTested by hand."],
    ["an indented marker with a carriage return", `Adds a waitlist.\n   ${MARKER}\r\nTested by hand.`, "Adds a waitlist.\nTested by hand."],
    ["a marker spaced oddly", `Adds a waitlist.\n<!--fabrik:ui-evidence {"run":1}-->\nTested by hand.`, "Adds a waitlist.\nTested by hand."],
    [
      "a marker recording routes and a linked preview",
      `Adds a waitlist.\n<!-- fabrik:ui-evidence {"run":1,"artifact":2,"failure":null,"routes":["/book"],"preview":{"is":"linked","url":"https://pr-12.shop.example.dev/"}} -->\nTested by hand.`,
      "Adds a waitlist.\nTested by hand.",
    ],
    ["a marker in a code block", `Adds a waitlist.\n\`\`\`\n${MARKER}\n\`\`\`\nTested by hand.`, "Adds a waitlist.\n```\n```\nTested by hand."],
  ])("loses any stray evidence line, such as %s, and only that line", (_, text, without) => {
    expect(withoutEvidence(text)).toBe(without);
  });

  it("keeps text with no evidence as it is, even text that mentions a marker inline", () => {
    const text = `Adds a waitlist.\n\nThe PR body ends with a \`${MARKER}\` line.\n\nCloses #12`;

    expect(withoutEvidence(text)).toBe(text);
  });
});

describe("The images a Reviewer gets", () => {
  /** A capture of this route and why, at this viewport and side, named as the capture step names its files. */
  const shot = (route: string, reason: Capture["reason"], viewport: Capture["viewport"], side: Capture["side"]): Capture => ({
    route,
    reason,
    viewport,
    side,
    status: 200,
    image: `${side}-${viewport}-${route === "/" ? "home" : route.slice(1).replace(/\//g, "-")}.png`,
  });

  it("put After before Before, mobile before desktop, and routes in reason order: the Ticket's, the Implementer's, then the defaults", () => {
    const captures = [
      shot("/", "default", "desktop", "after"),
      shot("/book", "ticket", "mobile", "before"),
      shot("/book/waitlist", "implementer", "mobile", "after"),
      shot("/book", "ticket", "desktop", "after"),
      shot("/book", "ticket", "mobile", "after"),
      shot("/book/waitlist", "implementer", "mobile", "before"),
      shot("/", "default", "mobile", "after"),
    ];

    expect(reviewerImages(captures).map(({ image }) => image)).toEqual([
      "after-mobile-book.png",
      "after-mobile-book-waitlist.png",
      "after-mobile-home.png",
      "after-desktop-book.png",
      "after-desktop-home.png",
      "before-mobile-book.png",
      "before-mobile-book-waitlist.png",
    ]);
  });

  it("stop at eight, so four routes at both viewports and sides give the Reviewer every After and no Before", () => {
    const routes: [string, Capture["reason"]][] = [["/book", "ticket"], ["/book/waitlist", "implementer"], ["/", "default"], ["/services", "default"]];
    const captures = (["before", "after"] as const).flatMap((side) =>
      (["desktop", "mobile"] as const).flatMap((viewport) => routes.map(([route, reason]) => shot(route, reason, viewport, side))),
    );

    expect(captures).toHaveLength(16);
    expect(reviewerImages(captures).map(({ image }) => image)).toEqual([
      "after-mobile-book.png",
      "after-mobile-book-waitlist.png",
      "after-mobile-home.png",
      "after-mobile-services.png",
      "after-desktop-book.png",
      "after-desktop-book-waitlist.png",
      "after-desktop-home.png",
      "after-desktop-services.png",
    ]);
  });

  it("are every capture when there are eight or fewer, and none when there are none", () => {
    expect(reviewerImages([shot("/book", "ticket", "desktop", "before")])).toEqual([shot("/book", "ticket", "desktop", "before")]);
    expect(reviewerImages([])).toEqual([]);
  });

  // The Reviewer gets nothing from a Prototype.
  it("leave out every capture of a Prototype's variant", () => {
    const captures = [variantCaptures[0]!, shot("/book", "ticket", "desktop", "after"), variantCaptures[3]!, shot("/book", "ticket", "mobile", "after")];

    expect(reviewerImages(captures).map(({ image }) => image)).toEqual(["after-mobile-book.png", "after-desktop-book.png"]);
    expect(reviewerImages(variantCaptures)).toEqual([]);
  });
});

describe("Linking the preview in a PR body's evidence section, once the push job has polled it", () => {
  const PREVIEW = "https://pr-12.shop.example.dev/";
  /** A UI PR's body as its push job opened it: run 9100's section, waiting on the preview. */
  const body = (run = 9100) =>
    `Adds a waitlist to full days.\n\n${evidenceSection(evidence(allCaptured, { run, preview: { kind: "pending" } }))}\n\nCloses #12`;
  const sectionSaying = (preview: UiEvidence["preview"]) =>
    `Adds a waitlist to full days.\n\n${evidenceSection(evidence(allCaptured, { preview }))}\n\nCloses #12`;

  it.each([
    ["links a preview that answered", { kind: "linked", url: PREVIEW }],
    ["says a preview never answered", { kind: "never-answered", url: PREVIEW }],
  ] as const)("%s, leaving the rest of the body as it was", (_, preview) => {
    expect(withPreviewLink(body(), 9100, preview)).toBe(sectionSaying(preview));
  });

  it("keeps whatever the Operator changed around the section", () => {
    const edited = body().replace("Adds a waitlist to full days.", "Adds a waitlist to full days.\r\n\r\nThe Operator's note.");

    expect(withPreviewLink(edited, 9100, { kind: "linked", url: PREVIEW })).toBe(
      sectionSaying({ kind: "linked", url: PREVIEW }).replace("Adds a waitlist to full days.", "Adds a waitlist to full days.\r\n\r\nThe Operator's note."),
    );
  });

  it("edits and records it in a body the Operator saved with \\r\\n line ends, keeping them", () => {
    const edited = withPreviewLink(body().replaceAll("\n", "\r\n"), 9100, { kind: "never-answered", url: PREVIEW });

    expect(edited).toBe(sectionSaying({ kind: "never-answered", url: PREVIEW }).replaceAll("\n", "\r\n"));
    expect(evidenceMarkerIn(edited!)?.preview).toEqual({ is: "never-answered", url: PREVIEW });
  });

  it("records it in the marker, keeping the routes and anything else the marker holds", () => {
    const waiting = body().replace(`"preview":{"is":"pending"}`, `"preview":{"is":"pending"},"later":1`);
    const marker = withPreviewLink(waiting, 9100, { kind: "linked", url: PREVIEW })!.split("\n").findLast((line) => line.startsWith("<!-- fabrik:ui-evidence {"));

    expect(marker).toBe(
      `<!-- fabrik:ui-evidence {"run":9100,"artifact":9202,"failure":null,"routes":["/book","/book/waitlist"],"preview":{"is":"linked","url":"https://pr-12.shop.example.dev/"},"later":1} -->`,
    );
  });

  it.each([
    ["holds another run's section, as after a later run replaced it", body(9300)],
    ["holds a section that already says what came of the preview", sectionSaying({ kind: "never-answered", url: PREVIEW })],
    ["holds a section of a repo with no preview declared", sectionSaying({ kind: "none" })],
    ["holds no section at all", "Adds a waitlist to full days.\n\nCloses #12"],
    ["holds the waiting line outside any section", "The preview deployment is linked here once it answers.\n\nCloses #12"],
  ])("changes nothing in a body that %s", (_, text) => {
    expect(withPreviewLink(text, 9100, { kind: "linked", url: PREVIEW })).toBeNull();
  });
});

describe("UI evidence of a route viewed signed in", () => {
  /** The owner's /today, After only, and a public /pricing, After and Before, as a capture behind a sign-in writes it. */
  const signedIn: CaptureResult<Capture> = {
    outcome: "captured",
    headSha: HEAD,
    captures: [
      { route: "/today", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-1-today.png", identity: "owner" },
      { route: "/today", reason: "ticket", viewport: "desktop", side: "after", status: 503, image: "after-desktop-1-today.png", identity: "owner" },
      { route: "/pricing", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-2-pricing.png" },
      { route: "/pricing", reason: "ticket", viewport: "mobile", side: "before", status: 200, image: "before-mobile-2-pricing.png" },
    ],
  };

  it("reads back with each capture's Capture identity, and a capture with none still reads", () => {
    expect(parseCaptureResult(JSON.stringify(signedIn))).toEqual({ ok: true, result: signedIn });
  });

  it("reads back a prototype turn's capture of a signed-in route", () => {
    const prototype: CaptureResult = {
      outcome: "captured",
      headSha: HEAD,
      captures: [{ route: "/today", variant: "A", viewport: "mobile", status: 200, image: "variant-a-mobile.png", identity: "owner" }],
    };

    expect(parseCaptureResult(JSON.stringify(prototype))).toEqual({ ok: true, result: prototype });
  });

  it.each([7, "", "the owner", "../owner", null])("refuses an identity that isn't a Capture identity's name: %j", (identity) => {
    const bad = { ...signedIn, captures: [{ ...signedIn.captures[0], identity }] };

    expect(parseCaptureResult(JSON.stringify(bad))).toEqual({
      ok: false,
      errors: ["captures[0].identity must be a Capture identity's name, such as owner: letters, digits, - and _"],
    });
  });

  it("reads back a capture that failed signing in", () => {
    const failed: CaptureResult = { outcome: "failed", reason: "sign-in-failed", headSha: HEAD, captures: signedIn.captures.slice(0, 1) };

    expect(parseCaptureResult(JSON.stringify(failed))).toEqual({ ok: true, result: failed });
  });

  it("names the identity on each signed-in route in the evidence section, and a public route reads as it does today", () => {
    const section = evidenceSection(evidence(signedIn)).split("\n");

    expect(section).toContain(
      "- `/today`, named by the Ticket, signed in as `owner`. **Server error:** it answered 503 for After at desktop, so that screenshot shows an error page, not the design.",
    );
    expect(section).toContain("- `/pricing`, named by the Ticket");
  });

  it("says why capture failed when signing in failed, never blocking the PR", () => {
    const section = evidenceSection(evidence({ outcome: "failed", reason: "sign-in-failed", headSha: HEAD, captures: [] }));

    expect(section).toContain(
      "**Capture failed:** signing in failed: a `ui.sign_in` command failed, ran out of time or left no session it could read, or a signed-in page landed on `ui.sign_in_path`, which its log names. There are no screenshots.",
    );
  });

  it("names the identity on each signed-in screenshot the Reviewer is given, and says a signed-in route has no Before", () => {
    const block = reviewerEvidenceBlock({ result: signedIn, given: reviewerImages(signedIn.captures), head: HEAD, recorded: null });

    expect(block[1]).toContain(
      "A screenshot signed in as a Capture identity, a fake user of the Sandbox's own server, has no Before, since Before is never signed in.",
    );
    expect(block[2]?.split("\n")).toEqual([
      "- `fabrik-ui-evidence/after-mobile-1-today.png`: `/today` at mobile width (390×844), After, signed in as `owner`",
      "- `fabrik-ui-evidence/after-mobile-2-pricing.png`: `/pricing` at mobile width (390×844), After",
      "- `fabrik-ui-evidence/after-desktop-1-today.png`: `/today` at desktop width (1440×900), After, signed in as `owner`. It answered 503, so it shows an error page, not the design",
      "- `fabrik-ui-evidence/before-mobile-2-pricing.png`: `/pricing` at mobile width (390×844), Before",
    ]);
  });

  it("says the screenshots capture took weren't copied for the Review, when none of a captured result's were", () => {
    const block = reviewerEvidenceBlock({ result: allCaptured, given: [], head: HEAD, recorded: null });

    expect(block).toEqual([
      "## UI evidence",
      `This pull request changes the Product repo's UI, but the 6 screenshots capture took of this branch at \`4f2b9c0\` weren't copied for this Review. There are no screenshots, so review the code as usual.`,
    ]);
  });

  it("leaves the Reviewer's block as it is today when no screenshot is signed in", () => {
    const block = reviewerEvidenceBlock({ result: allCaptured, given: reviewerImages(allCaptured.captures), head: HEAD, recorded: null });

    expect(block.join("\n")).not.toMatch(/signed in|Capture identity/);
  });
});

describe("UI evidence of a page that wouldn't load", () => {
  const refused = (route: string, reason: Capture["reason"], viewport: Capture["viewport"], side: Capture["side"] = "before"): MissedShot => ({
    route,
    reason,
    viewport,
    side,
    url: `${side === "before" ? "https://www.penrithphysio.com.au" : "http://127.0.0.1:4321"}${route}`,
    why: `${side}-unreachable`,
    error: "ERR_CONNECTION_REFUSED",
  });

  /** Production refused the browser: every After of /book and /book/waitlist taken, and no Before of /book. */
  const beforeRefused: CaptureResult<Capture> = {
    outcome: "captured",
    headSha: HEAD,
    captures: allCaptured.captures.filter(({ side }) => side === "after"),
    missed: [refused("/book", "ticket", "mobile"), refused("/book", "ticket", "desktop")],
  };

  it("reads back with the shots it missed, each with its side, URL and error", () => {
    expect(parseCaptureResult(JSON.stringify(beforeRefused))).toEqual({ ok: true, result: beforeRefused });
  });

  it("refuses a missed shot whose reason isn't its side's, or whose error isn't a browser error code", () => {
    const bad = { ...beforeRefused, missed: [{ ...refused("/book", "ticket", "mobile"), why: "after-unreachable", error: "refused\n<!-- x -->" }] };

    const read = parseCaptureResult(JSON.stringify(bad));

    expect(read.ok).toBe(false);
    expect(read.ok ? [] : read.errors).toEqual([
      "missed[0].why must be before-unreachable, its side's",
      "missed[0].error must be a browser error code, such as ERR_CONNECTION_REFUSED",
    ]);
  });

  it("keeps the After set in the evidence section and names the route whose Before was refused, and why", () => {
    expect(evidenceSection(evidence(beforeRefused)).split("\n").filter((line) => line.startsWith("- "))).toEqual([
      "- `/book`, named by the Ticket. Captured: After at mobile and desktop. **Not captured:** Before: unreachable, `ERR_CONNECTION_REFUSED`, at mobile and desktop.",
      "- `/book/waitlist`, named by the Implementer",
    ]);
  });

  it("lists a route that has no screenshot at all, and says plainly why capture failed when no page would load", () => {
    const nothing: CaptureResult<Capture> = {
      outcome: "failed",
      reason: "unreachable",
      headSha: HEAD,
      captures: [],
      missed: [refused("/book", "ticket", "mobile", "after"), refused("/book", "ticket", "desktop", "after")],
    };

    expect(evidenceSection(evidence(nothing, { evidencePage: null }))).toBe(
      [
        "<!-- fabrik:ui-evidence-start -->",
        "## UI evidence",
        "",
        "**Capture failed:** no page it went to would load, refused or not found. There are no screenshots.",
        "",
        "No preview link: Kit config declares no `preview.url`.",
        "",
        "Captured routes:",
        "",
        "- `/book`, named by the Ticket. Captured: nothing. **Not captured:** After: unreachable, `ERR_CONNECTION_REFUSED`, at mobile and desktop.",
        `<!-- fabrik:ui-evidence {"run":9100,"artifact":9202,"failure":"unreachable","routes":["/book"],"preview":{"is":"none"}} -->`,
      ].join("\n"),
    );
  });

  it("lists a route whose every After was missed in its place, the Ticket's before the Implementer's", () => {
    const ticketRefused: CaptureResult<Capture> = {
      ...allCaptured,
      captures: allCaptured.captures.filter(({ route }) => route !== "/book"),
      missed: (["mobile", "desktop"] as const).flatMap((viewport) => [refused("/book", "ticket", viewport, "after"), refused("/book", "ticket", viewport)]),
    };

    expect(evidenceSection(evidence(ticketRefused)).split("\n").filter((line) => line.startsWith("- "))).toEqual([
      "- `/book`, named by the Ticket. Captured: nothing. **Not captured:** After: unreachable, `ERR_CONNECTION_REFUSED`, at mobile and desktop; Before: unreachable, `ERR_CONNECTION_REFUSED`, at mobile and desktop.",
      "- `/book/waitlist`, named by the Implementer",
    ]);
  });

  it("tells the Reviewer Before is missing for those routes, rather than that capture failed", () => {
    const block = reviewerEvidenceBlock({ result: beforeRefused, given: reviewerImages(beforeRefused.captures), head: HEAD, recorded: null });

    expect(block[1]).toContain("so the Kit captured screenshots of this branch");
    expect(block[1]).not.toContain("capture failed");
    expect(block[1]).toContain("Before is missing for `/book`, where the production site wouldn't load (`ERR_CONNECTION_REFUSED`), so there's no Before to compare its After against.");
  });

  it("tells the Reviewer After is missing for a route whose page on this branch wouldn't load", () => {
    const afterRefused: CaptureResult<Capture> = {
      ...allCaptured,
      captures: allCaptured.captures.filter(({ route }) => route !== "/book/waitlist"),
      missed: [refused("/book/waitlist", "implementer", "mobile", "after"), { ...refused("/book/waitlist", "implementer", "desktop", "after"), error: "ERR_TOO_MANY_REDIRECTS" }],
    };

    const block = reviewerEvidenceBlock({ result: afterRefused, given: reviewerImages(afterRefused.captures), head: HEAD, recorded: null });

    expect(block[1]).toContain(
      "After is missing for `/book/waitlist`, where this branch's page wouldn't load (`ERR_CONNECTION_REFUSED` and `ERR_TOO_MANY_REDIRECTS`), so there's no screenshot of it.",
    );
  });
});
