import { describe, expect, it } from "vitest";
import type { PrototypeVariant } from "../loop/designOutput.ts";
import { prototypeGallery, type VariantShot } from "./gallery.ts";
import type { VariantCapture } from "./uiEvidence.ts";

const HEAD = "4f2b9c0d1e3a5b7c9d0e1f2a3b4c5d6e7f8a9b0c";

/** Bytes of their own, so each file shows up as itself in the page. */
const bytes = (at: number, kind: number) => Uint8Array.of(0x1a, 0x45, kind, at, at * 7);

/** A Prototype of /book in three variants, each at both viewports with its video, but for C at desktop, whose video wasn't recorded. */
const captures: VariantCapture[] = [
  { route: "/book", variant: "A", viewport: "mobile", status: 200, image: "variant-a-mobile.png", video: "variant-a-mobile.webm" },
  { route: "/book", variant: "A", viewport: "desktop", status: 200, image: "variant-a-desktop.png", video: "variant-a-desktop.webm" },
  { route: "/book", variant: "B", viewport: "mobile", status: 200, image: "variant-b-mobile.png", video: "variant-b-mobile.webm" },
  { route: "/book", variant: "B", viewport: "desktop", status: 200, image: "variant-b-desktop.png", video: "variant-b-desktop.webm" },
  { route: "/book", variant: "C", viewport: "mobile", status: 200, image: "variant-c-mobile.png", video: "variant-c-mobile.webm" },
  { route: "/book", variant: "C", viewport: "desktop", status: 200, image: "variant-c-desktop.png" },
];

/** Each capture with its PNG's bytes, and its WebM's where it has a video. */
const shots: VariantShot[] = captures.map((capture, at) => ({
  ...capture,
  png: bytes(at, 1),
  ...(capture.video === undefined ? {} : { webm: bytes(at, 2) }),
}));

/** The variants as the prototype round's output names them, passed in as they are. */
const variants: PrototypeVariant[] = [
  { letter: "A", summary: "The calendar first, times below it", component: "src/prototypes/book/VariantA.astro" },
  { letter: "B", summary: "A list of the next free times, no calendar", component: "src/prototypes/book/VariantB.astro" },
  { letter: "C", summary: "Practitioner first, then their times", component: "src/prototypes/book/VariantC.astro" },
];

const meta = { issue: 12, route: "/book", headSha: HEAD };

/** The value of every attribute in the page that can load something: what a browser would fetch. */
const loaded = (html: string) => [...html.matchAll(/\s(?:src|href|srcset|action|data|poster)\s*=\s*"([^"]*)"/gi)].map(([, value = ""]) => value);

const base64 = (data: Uint8Array) => Buffer.from(data).toString("base64");

describe("The prototype gallery", () => {
  it("is one page holding every variant's screenshots and videos inline", () => {
    const html = prototypeGallery(shots, variants, meta);

    for (const { png, webm } of shots) {
      expect(html.split(`src="data:image/png;base64,${base64(png)}"`)).toHaveLength(2);
      if (webm !== undefined) expect(html.split(`src="data:video/webm;base64,${base64(webm)}"`)).toHaveLength(2);
    }
    expect(loaded(html)).toHaveLength(shots.length + 5);
  });

  it("refers to nothing outside itself, and its policy lets a browser load nothing else", () => {
    const html = prototypeGallery(shots, variants, meta);

    expect(loaded(html).every((value) => value.startsWith("data:image/png;base64,") || value.startsWith("data:video/webm;base64,"))).toBe(true);
    expect(html).not.toMatch(/<script|<link|<iframe|<object|<embed|<source|@import|url\(/i);
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'">`,
    );
  });

  it("names the issue, the route prototyped and the commit it shows", () => {
    const html = prototypeGallery(shots, variants, meta);

    expect(html).toContain("<title>Prototype of /book for #12 at 4f2b9c0</title>");
    expect(html).toContain("<h1>Prototype of <code>/book</code> for #12</h1>");
    expect(html).toContain(`<code>${HEAD}</code>`);
  });
});

/**
 * Each variant's section in the page: its heading, its summary, and its row,
 * side by side: each figure's caption and the files whose bytes it holds.
 */
const sectionsOf = (html: string, from: readonly VariantShot[]) => {
  const fileOf = (data: string, kind: "png" | "webm") =>
    from.find((shot) => shot[kind] !== undefined && base64(shot[kind]) === data)?.[kind === "png" ? "image" : "video"];
  return [...html.matchAll(/<section>\n<h2>([^<]*)<\/h2>\n(?:<p>([^<]*)<\/p>\n)?([\s\S]*?)\n<\/section>/g)].map(([, heading, summary, body = ""]) => ({
    heading,
    summary,
    row: [...body.matchAll(/<figure class="([^"]*)"><figcaption>([^<]*)<\/figcaption><img alt="([^"]*)" src="data:image\/png;base64,([^"]*)">(?:<video [^>]*src="data:video\/webm;base64,([^"]*)"><\/video>)?<\/figure>/g)].map(
      ([, , caption, alt, png = "", webm]) => `${caption} (${alt}): ${fileOf(png, "png")}${webm === undefined ? "" : `, ${fileOf(webm, "webm")}`}`,
    ),
    rows: [...body.matchAll(/<div class="viewports">/g)].length,
    rest: body.replace(/<div class="viewports">[\s\S]*<\/div>/, "").trim(),
  }));
};

describe("The prototype gallery's variants", () => {
  it("each sit under its letter and summary, in letter order, with its mobile and desktop screenshots side by side and each one's video beneath it", () => {
    expect(sectionsOf(prototypeGallery(shots, variants, meta), shots)).toEqual([
      {
        heading: "Variant A",
        summary: "The calendar first, times below it",
        row: [
          "Mobile, 390 × 844 (Variant A at mobile): variant-a-mobile.png, variant-a-mobile.webm",
          "Desktop, 1440 × 900 (Variant A at desktop): variant-a-desktop.png, variant-a-desktop.webm",
        ],
        rows: 1,
        rest: "",
      },
      {
        heading: "Variant B",
        summary: "A list of the next free times, no calendar",
        row: [
          "Mobile, 390 × 844 (Variant B at mobile): variant-b-mobile.png, variant-b-mobile.webm",
          "Desktop, 1440 × 900 (Variant B at desktop): variant-b-desktop.png, variant-b-desktop.webm",
        ],
        rows: 1,
        rest: "",
      },
      {
        heading: "Variant C",
        summary: "Practitioner first, then their times",
        row: [
          "Mobile, 390 × 844 (Variant C at mobile): variant-c-mobile.png, variant-c-mobile.webm",
          "Desktop, 1440 × 900 (Variant C at desktop): variant-c-desktop.png",
        ],
        rows: 1,
        rest: "",
      },
    ]);
  });

  it("sit the same way whatever order capture took them in, or the round names them in", () => {
    const reversed = shots.toReversed();

    expect(prototypeGallery(reversed, variants.toReversed(), meta)).toBe(prototypeGallery(shots, variants, meta));
  });

  it("show a variant capture took nothing of under its letter and summary, saying so", () => {
    const stopped = shots.filter(({ variant }) => variant !== "C");

    expect(sectionsOf(prototypeGallery(stopped, variants, meta), stopped)[2]).toEqual({
      heading: "Variant C",
      summary: "Practitioner first, then their times",
      row: [],
      rows: 0,
      rest: "<p>Capture took no screenshot of this variant.</p>",
    });
  });

  it("show a variant capture stopped before its desktop screenshot with its mobile one alone", () => {
    const stopped = shots.filter(({ variant, viewport }) => !(variant === "B" && viewport === "desktop"));

    expect(sectionsOf(prototypeGallery(stopped, variants, meta), stopped)[1]?.row).toEqual([
      "Mobile, 390 × 844 (Variant B at mobile): variant-b-mobile.png, variant-b-mobile.webm",
    ]);
  });

  // The gallery holds every capture, as the PR's does.
  it("show a capture of a variant the round doesn't name, under its letter alone", () => {
    const sections = sectionsOf(prototypeGallery(shots, variants.slice(0, 2), meta), shots);

    expect(sections.map(({ heading, summary }) => [heading, summary])).toEqual([
      ["Variant A", "The calendar first, times below it"],
      ["Variant B", "A list of the next free times, no calendar"],
      ["Variant C", undefined],
    ]);
    expect(sections[2]?.row).toHaveLength(2);
  });

  it("flag a screenshot of a page that answered a server error, so it isn't mistaken for the design", () => {
    const failing = shots.map((shot) => (shot.variant === "B" && shot.viewport === "mobile" ? { ...shot, status: 500 } : shot));
    const html = prototypeGallery(failing, variants, meta);

    expect(sectionsOf(html, failing)[1]?.row).toEqual([
      "Mobile, 390 × 844: answered 500, so this is an error page, not the design (Variant B at mobile): variant-b-mobile.png, variant-b-mobile.webm",
      "Desktop, 1440 × 900 (Variant B at desktop): variant-b-desktop.png, variant-b-desktop.webm",
    ]);
    expect(html).toContain('<figure class="mobile error">');
  });
});

// A summary and the route are agent text: the page shows them and never runs or loads them.
describe("The prototype gallery's text", () => {
  const evil = `"><script>alert(1)</script><img src="https://evil.example/x.png">`;

  it("shows a variant's summary as text, whatever HTML it holds", () => {
    const html = prototypeGallery(shots, [{ letter: "A", summary: `Calendar ${evil}` }], meta);

    expect(html).toContain("<p>Calendar &quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=&quot;https://evil.example/x.png&quot;&gt;</p>");
    expect(html).not.toMatch(/<script|evil\.example\/x\.png"/);
  });

  it("shows the route as text, whatever HTML it holds", () => {
    const html = prototypeGallery(shots, variants, { ...meta, route: `/book${evil}` });

    expect(html).toContain("<h1>Prototype of <code>/book&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=&quot;https://evil.example/x.png&quot;&gt;</code> for #12</h1>");
    expect(html).not.toMatch(/<script|evil\.example\/x\.png"/);
    expect(loaded(html).every((value) => value.startsWith("data:"))).toBe(true);
  });
});
