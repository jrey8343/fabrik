import { describe, expect, it } from "vitest";
import { gallery, type GalleryShot } from "./gallery.ts";
import type { Capture } from "./uiEvidence.ts";

const HEAD = "4f2b9c0d1e3a5b7c9d0e1f2a3b4c5d6e7f8a9b0c";

/** A capture with its PNG: bytes of its own, so each shows up as itself in the page. */
const shot = (capture: Capture, at: number): GalleryShot => ({ ...capture, png: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, at, at * 7) });

/** The Ticket's /book at both viewports and sides, and the Implementer's /book/waitlist at both viewports, After only. */
const shots: GalleryShot[] = [
  { route: "/book", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-book.png" },
  { route: "/book", reason: "ticket", viewport: "desktop", side: "after", status: 200, image: "after-desktop-book.png" },
  { route: "/book/waitlist", reason: "implementer", viewport: "mobile", side: "after", status: 200, image: "after-mobile-book-waitlist.png" },
  { route: "/book/waitlist", reason: "implementer", viewport: "desktop", side: "after", status: 200, image: "after-desktop-book-waitlist.png" },
  { route: "/book", reason: "ticket", viewport: "mobile", side: "before", status: 200, image: "before-mobile-book.png" },
  { route: "/book", reason: "ticket", viewport: "desktop", side: "before", status: 200, image: "before-desktop-book.png" },
].map((capture, at) => shot(capture as Capture, at + 1));

const meta = { ticket: 12, headSha: HEAD };

/** The value of every attribute in the page that can load something: what a browser would fetch. */
const loaded = (html: string) => [...html.matchAll(/\s(?:src|href|srcset|action|data|poster)\s*=\s*"([^"]*)"/gi)].map(([, value = ""]) => value);

describe("The gallery", () => {
  it("is one page holding every capture's image inline", () => {
    const html = gallery(shots, meta);

    for (const { png } of shots) {
      expect(html.split(`src="data:image/png;base64,${Buffer.from(png).toString("base64")}"`)).toHaveLength(2);
    }
    expect(loaded(html)).toHaveLength(shots.length);
  });

  it("refers to nothing outside itself, and its policy lets a browser load nothing else", () => {
    const html = gallery(shots, meta);

    expect(loaded(html).every((value) => value.startsWith("data:image/png;base64,"))).toBe(true);
    expect(html).not.toMatch(/<script|<link|<iframe|<object|<embed|@import|url\(/i);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`);
  });

  it("names the Ticket and the commit it shows", () => {
    const html = gallery(shots, meta);

    expect(html).toContain("<title>UI evidence for #12 at 4f2b9c0</title>");
    expect(html).toContain(`<code>${HEAD}</code>`);
  });
});

/** Each row of the page, side by side: which image each shows, by its alt text and the capture whose bytes it holds. */
const rows = (html: string, from: readonly GalleryShot[]) =>
  [...html.matchAll(/<div class="pair">([\s\S]*?)<\/div>/g)].map(([, row = ""]) =>
    [...row.matchAll(/<img alt="([^"]*)" src="data:image\/png;base64,([^"]*)"/g)].map(([, alt, base64]) => {
      const image = from.find(({ png }) => Buffer.from(png).toString("base64") === base64)?.image;
      return `${alt}: ${image}`;
    }),
  );

describe("The gallery's rows", () => {
  it("pair Before beside After for each route and viewport, routes in the order captured, mobile first", () => {
    expect(rows(gallery(shots, meta), shots)).toEqual([
      ["/book at mobile, Before: before-mobile-book.png", "/book at mobile, After: after-mobile-book.png"],
      ["/book at desktop, Before: before-desktop-book.png", "/book at desktop, After: after-desktop-book.png"],
      ["/book/waitlist at mobile, After: after-mobile-book-waitlist.png"],
      ["/book/waitlist at desktop, After: after-desktop-book-waitlist.png"],
    ]);
  });

  it("pair the same way whatever order capture took them in", () => {
    const reversed = shots.toReversed();

    expect(rows(gallery(reversed, meta), reversed)).toEqual(rows(gallery(shots, meta), shots));
  });

  it("show a Before alone when capture stopped before its After", () => {
    const stopped = shots.filter(({ route, viewport, side }) => !(route === "/book" && viewport === "desktop" && side === "after"));

    expect(rows(gallery(stopped, meta), stopped)[1]).toEqual(["/book at desktop, Before: before-desktop-book.png"]);
  });

  it("head each route's rows with the route and why it was captured", () => {
    const html = gallery(shots, meta);

    expect(html).toContain("<h2><code>/book</code>, named by the Ticket</h2>");
    expect(html).toContain("<h2><code>/book/waitlist</code>, named by the Implementer</h2>");
  });
});
