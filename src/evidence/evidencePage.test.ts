import { describe, expect, it } from "vitest";
import { evidencePage, type EvidencePageShot } from "./evidencePage.ts";
import type { Capture } from "./uiEvidence.ts";

const HEAD = "4f2b9c0d1e3a5b7c9d0e1f2a3b4c5d6e7f8a9b0c";

/** A capture with its PNG: bytes of its own, so each shows up as itself in the page. */
const shot = (capture: Capture, at: number): EvidencePageShot => ({ ...capture, png: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, at, at * 7) });

/** The Ticket's /book at both viewports and sides, and the Implementer's /book/waitlist at both viewports, After only. */
const shots: EvidencePageShot[] = [
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

describe("The Evidence page", () => {
  it("is one page holding every capture's image inline", () => {
    const html = evidencePage(shots, meta);

    for (const { png } of shots) {
      expect(html.split(`src="data:image/png;base64,${Buffer.from(png).toString("base64")}"`)).toHaveLength(2);
    }
    expect(loaded(html)).toHaveLength(shots.length);
  });

  it("refers to nothing outside itself, and its policy lets a browser load nothing else", () => {
    const html = evidencePage(shots, meta);

    expect(loaded(html).every((value) => value.startsWith("data:image/png;base64,"))).toBe(true);
    expect(html).not.toMatch(/<script|<link|<iframe|<object|<embed|@import|url\(/i);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`);
  });

  it("names itself the Evidence page, with the Ticket and the commit it shows", () => {
    const html = evidencePage(shots, meta);

    expect(html).toContain("<title>Evidence page: UI evidence for #12 at 4f2b9c0</title>");
    expect(html).toContain(`<code>${HEAD}</code>`);
  });
});

/** Each row of the page, side by side: which image each shows, by its alt text and the capture whose bytes it holds. */
const rows = (html: string, from: readonly EvidencePageShot[]) =>
  [...html.matchAll(/<div class="pair">([\s\S]*?)<\/div>/g)].map(([, row = ""]) =>
    [...row.matchAll(/<img alt="([^"]*)" src="data:image\/png;base64,([^"]*)"/g)].map(([, alt, base64]) => {
      const image = from.find(({ png }) => Buffer.from(png).toString("base64") === base64)?.image;
      return `${alt}: ${image}`;
    }),
  );

describe("The Evidence page's rows", () => {
  it("pair Before beside After for each route and viewport, routes in the order captured, mobile first", () => {
    expect(rows(evidencePage(shots, meta), shots)).toEqual([
      ["/book at mobile, Before: before-mobile-book.png", "/book at mobile, After: after-mobile-book.png"],
      ["/book at desktop, Before: before-desktop-book.png", "/book at desktop, After: after-desktop-book.png"],
      ["/book/waitlist at mobile, After: after-mobile-book-waitlist.png"],
      ["/book/waitlist at desktop, After: after-desktop-book-waitlist.png"],
    ]);
  });

  it("pair the same way whatever order capture took them in", () => {
    const reversed = shots.toReversed();

    expect(rows(evidencePage(reversed, meta), reversed)).toEqual(rows(evidencePage(shots, meta), shots));
  });

  it("show a Before alone when capture stopped before its After", () => {
    const stopped = shots.filter(({ route, viewport, side }) => !(route === "/book" && viewport === "desktop" && side === "after"));

    expect(rows(evidencePage(stopped, meta), stopped)[1]).toEqual(["/book at desktop, Before: before-desktop-book.png"]);
  });

  it("head each route's rows with the route and why it was captured", () => {
    const html = evidencePage(shots, meta);

    expect(html).toContain("<h2><code>/book</code>, named by the Ticket</h2>");
    expect(html).toContain("<h2><code>/book/waitlist</code>, named by the Implementer</h2>");
  });
});

describe("The Evidence page's captions", () => {
  // A route may be the Implementer's: agent text, which the page shows and never runs or loads.
  it("show a route as text, whatever HTML it holds", () => {
    const route = `/book"><script>alert(1)</script><img src="https://evil.example/x.png">`;
    const html = evidencePage([{ ...shots[2]!, route }], meta);

    expect(html).toContain(
      "<h2><code>/book&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=&quot;https://evil.example/x.png&quot;&gt;</code>, named by the Implementer</h2>",
    );
    expect(html).not.toMatch(/<script|evil\.example\/x\.png"/);
    expect(loaded(html).every((value) => value.startsWith("data:image/png;base64,"))).toBe(true);
  });

  it("flag a screenshot of a page that answered a server error, so it isn't mistaken for the design", () => {
    const html = evidencePage([shots[0]!, { ...shots[4]!, status: 503 }], meta);

    expect(html).toContain("<figcaption>Before: answered 503, so this is an error page, not the design</figcaption>");
    expect(html).toContain("<figcaption>After</figcaption>");
  });
});

describe("The Evidence page of a route viewed signed in", () => {
  const signedIn: EvidencePageShot[] = [
    { route: "/today", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-1-today.png", identity: "owner" },
    { route: "/pricing", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-2-pricing.png" },
    { route: "/pricing", reason: "ticket", viewport: "mobile", side: "before", status: 200, image: "before-mobile-2-pricing.png" },
  ].map((capture, at) => shot(capture as Capture, at + 1));

  it("names the identity on the route and its screenshots, and says why it has no Before", () => {
    const html = evidencePage(signedIn, meta);

    expect(html).toContain("<h2><code>/today</code>, named by the Ticket, signed in as <code>owner</code></h2>");
    expect(html).toContain(
      "<p>Signed in as <code>owner</code>, so it never has a Before: the Kit only ever signs in to the Sandbox's own server, never to the production site Before is taken from.</p>",
    );
    expect(html).toContain("<figcaption>After, signed in as owner</figcaption>");
  });

  it("shows a public route as it does today", () => {
    const html = evidencePage(signedIn, meta);

    expect(html).toContain("<h2><code>/pricing</code>, named by the Ticket</h2>");
    expect(html).toContain("<figcaption>Before</figcaption>");
    expect(html.match(/never has a Before/g)).toHaveLength(1);
  });
});
