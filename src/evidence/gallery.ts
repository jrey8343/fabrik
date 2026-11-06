// The UI evidence gallery (#153): one self-contained HTML page holding every
// screenshot capture took, for the Operator to open in one click. Uncapped,
// unlike the Reviewer's images. Pure, no I/O: the capture step reads the
// images and writes the page.
import { Buffer } from "node:buffer";
import type { Capture } from "./uiEvidence.ts";

/** A capture with its image's bytes, a PNG. */
export interface GalleryShot extends Capture {
  readonly png: Uint8Array;
}

/** What the gallery is of: the Ticket's pull request, at the commit captured. */
export interface GalleryMeta {
  readonly ticket: number;
  readonly headSha: string;
}

/**
 * Lets the page load nothing but its own inline images and styles, so even a
 * route that slipped past escaping could never fetch or run anything.
 */
const POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

/** The gallery page: every capture's image inlined, so it refers to nothing outside itself. */
export function gallery(captures: readonly GalleryShot[], meta: GalleryMeta): string {
  const { ticket, headSha } = meta;
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>UI evidence for #${ticket} at ${headSha.slice(0, 7)}</title>`,
    "</head>",
    "<body>",
    `<h1>UI evidence for #${ticket}</h1>`,
    `<p>Captured at <code>${headSha}</code>.</p>`,
    ...captures.map((capture) => `<img src="data:image/png;base64,${Buffer.from(capture.png).toString("base64")}">`),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
