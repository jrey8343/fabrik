// The UI evidence gallery (#153): one self-contained HTML page holding every
// screenshot capture took, for the Operator to open in one click. Uncapped,
// unlike the Reviewer's images. Pure, no I/O: the capture step reads the
// images and writes the page.
import { Buffer } from "node:buffer";
import { UI_VIEWPORTS } from "../kit/config.ts";
import { type Capture, CAPTURE_SIDES, ROUTE_REASON_WORDS, SIDE_WORDS } from "./uiEvidence.ts";

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
    ...routesOf(captures).flatMap((route) => routeSection(route, captures)),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** Each route once, in the order capture first took it. */
function routesOf(captures: readonly GalleryShot[]): GalleryShot[] {
  return captures.filter(({ route }, at) => captures.findIndex((other) => other.route === route) === at);
}

/** A route's heading, then a row per viewport it was captured at, mobile first, with Before beside After. */
function routeSection({ route, reason }: GalleryShot, captures: readonly GalleryShot[]): string[] {
  const rows = UI_VIEWPORTS.flatMap((viewport) => {
    const row = CAPTURE_SIDES.flatMap((side) =>
      captures.filter((capture) => capture.route === route && capture.viewport === viewport.name && capture.side === side),
    );
    return row.length === 0 ? [] : [`<h3>${capitalised(viewport.name)}, ${viewport.width} × ${viewport.height}</h3>`, `<div class="pair">${row.map(figure).join("")}</div>`];
  });
  return ["<section>", `<h2><code>${escaped(route)}</code>, ${ROUTE_REASON_WORDS[reason]}</h2>`, ...rows, "</section>"];
}

/** One screenshot, inlined, captioned with its side. */
function figure({ route, viewport, side, png }: GalleryShot): string {
  const alt = escaped(`${route} at ${viewport}, ${SIDE_WORDS[side]}`);
  const source = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  return `<figure><img alt="${alt}" src="${source}"><figcaption>${SIDE_WORDS[side]}</figcaption></figure>`;
}

function capitalised(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** Text as HTML text or an attribute's value. */
function escaped(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
