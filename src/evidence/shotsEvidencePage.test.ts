// A pull request's Evidence page of Evidence shots (#820): every shot the
// named check's run took, at both sizes, the named ones first.
import { describe, expect, it } from "vitest";
import { type PageShot, shotsEvidencePage } from "./evidencePage.ts";

const HEAD = "4f2b9c0d1e3a5b7c9d0e1f2a3b4c5d6e7f8a9b0c";

/** Bytes of their own, so each image shows up as itself in the page. */
const bytes = (at: number) => Uint8Array.of(0x89, 0x50, at, at * 7);
const base64 = (data: Uint8Array) => Buffer.from(data).toString("base64");

/** Three shots in the manifest's order, the last at mobile alone. */
const shots: PageShot[] = [
  { name: "inbox: empty", images: { mobile: bytes(1), desktop: bytes(2) } },
  { name: "composer: draft ready", journey: "write-a-clinical-note", path: "/patients/6f1b2c3d/notes/new", images: { mobile: bytes(3), desktop: bytes(4) } },
  { name: "sign in: form", images: { mobile: bytes(5) } },
];

const meta = { ticket: 12, headSha: HEAD, check: "e2e", named: ["composer: draft ready", "sign in: form"] };

/** The page's headings, in order, with their markup. */
const headings = (html: string) => [...html.matchAll(/<h2>(.*?)<\/h2>/g)].map(([, text]) => text);

/** The value of every attribute in the page that can load something: what a browser would fetch. */
const loaded = (html: string) => [...html.matchAll(/\s(?:src|href|srcset|action|data|poster)\s*=\s*"([^"]*)"/gi)].map(([, value = ""]) => value);

describe("The Evidence page of a pull request's Evidence shots (#820)", () => {
  it("holds every shot of the run, the named ones first in the Implementer's order, then the rest in the manifest's", () => {
    expect(headings(shotsEvidencePage(shots, meta))).toEqual(["<code>composer: draft ready</code>, named", "<code>sign in: form</code>, named", "<code>inbox: empty</code>"]);
  });

  it("shows each shot under its name with its Journey and path, at both sizes, mobile first", () => {
    const html = shotsEvidencePage(shots, meta);
    const section = html.slice(html.indexOf("<code>composer: draft ready</code>"), html.indexOf("<code>sign in: form</code>, named"));

    expect(section).toContain("<p>From the Journey <code>write-a-clinical-note</code>, at <code>/patients/6f1b2c3d/notes/new</code>.</p>");
    expect(section.indexOf(base64(bytes(3)))).toBeLessThan(section.indexOf(base64(bytes(4))));
    expect(section).toContain("Mobile, 390 × 844");
    expect(section).toContain("Desktop, 1440 × 900");
  });

  it("says which size a shot lacks", () => {
    const html = shotsEvidencePage(shots, meta);

    expect(html.slice(html.indexOf("<code>sign in: form</code>"), html.indexOf("<code>inbox: empty</code>"))).toContain("<p>It has no desktop image.</p>");
  });

  it("says what it is of: the Ticket, the check and the head", () => {
    const html = shotsEvidencePage(shots, meta);

    expect(html).toContain(`<title>Evidence page: Evidence shots for #12 at 4f2b9c0</title>`);
    expect(html).toContain(`<code>e2e</code>`);
    expect(html).toContain(`<code>${HEAD}</code>`);
  });

  it("inlines every image, so it loads nothing from outside itself", () => {
    const html = shotsEvidencePage(shots, meta);

    expect(loaded(html).every((value) => value.startsWith("data:image/png;base64,"))).toBe(true);
    expect(loaded(html)).toHaveLength(5);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`);
  });

  it("escapes the artifact's text, which the pull request's own code wrote", () => {
    const html = shotsEvidencePage([{ name: "a", journey: "j", path: '/x"><script>', images: { mobile: bytes(1) } }], { ...meta, named: [] });

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
