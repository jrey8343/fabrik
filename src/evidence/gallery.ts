// The UI evidence gallery (#153): one self-contained HTML page holding every
// screenshot capture took, for the Operator to open in one click. Uncapped,
// unlike the Reviewer's images. Beside it, the prototype gallery (#155): one
// such page of a Prototype's variants, with their videos. Pure, no I/O: the
// capture step reads the images and videos and writes the page.
import { Buffer } from "node:buffer";
import { UI_VIEWPORTS } from "../kit/config.ts";
import {
  type Capture,
  CAPTURE_SIDES,
  isServerError,
  ROUTE_REASON_WORDS,
  serverErrorWords,
  SIDE_WORDS,
  VARIANT_LETTERS,
  type VariantCapture,
  type VariantLetter,
} from "./uiEvidence.ts";

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

/** Before and After share a row, half each, and a side alone takes the whole row. */
const STYLE = [
  ":root { color-scheme: light dark; font-family: system-ui, sans-serif; }",
  "body { margin: 0 auto; max-width: 1600px; padding: 16px; }",
  "section { margin-top: 32px; }",
  ".pair { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 16px; align-items: start; }",
  "figure { margin: 0; }",
  "figcaption { margin-bottom: 4px; font-weight: 600; }",
  "figure.error figcaption { color: #c62828; }",
  "img { display: block; max-width: 100%; height: auto; border: 1px solid #8888; }",
].join(" ");

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
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    `<h1>UI evidence for #${ticket}</h1>`,
    `<p>Captured at <code>${headSha}</code>. After is this branch, served in the Sandbox; Before, where there is one, is the production site.</p>`,
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

/** One screenshot, inlined, captioned with its side, and flagged when its page answered a server error. */
function figure({ route, viewport, side, status, png }: GalleryShot): string {
  const alt = escaped(`${route} at ${viewport}, ${SIDE_WORDS[side]}`);
  const source = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  const caption = isServerError(status) ? `${SIDE_WORDS[side]}: ${serverErrorWords(String(status), "this is")}` : SIDE_WORDS[side];
  return `<figure${isServerError(status) ? ' class="error"' : ""}><figcaption>${caption}</figcaption><img alt="${alt}" src="${source}"></figure>`;
}

/** A capture of a Prototype's variant with its image's bytes, a PNG, and its video's, a WebM, when it has a video. */
export interface VariantShot extends VariantCapture {
  readonly png: Uint8Array;
  readonly webm?: Uint8Array;
}

/** A Prototype's variant as its prototype round names it: its letter and one-line summary. */
export interface GalleryVariant {
  readonly letter: VariantLetter;
  readonly summary: string;
}

/** What a prototype gallery is of: the Design session's issue, the route prototyped, and the commit captured. */
export interface PrototypeGalleryMeta {
  readonly issue: number;
  readonly route: string;
  readonly headSha: string;
}

/** As POLICY, letting the page play its own inline videos too. */
const PROTOTYPE_POLICY = "default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'";

/**
 * A variant's viewports share a row, each column as wide as its viewport, so
 * mobile and desktop show at one scale side by side; a narrow screen stacks them.
 */
const PROTOTYPE_STYLE = [
  ":root { color-scheme: light dark; font-family: system-ui, sans-serif; }",
  "body { margin: 0 auto; max-width: 1600px; padding: 16px; }",
  "section { margin-top: 32px; }",
  `.viewports { display: grid; grid-template-columns: ${UI_VIEWPORTS.map(({ width }) => `minmax(0, ${width}fr)`).join(" ")}; gap: 16px; align-items: start; }`,
  ...UI_VIEWPORTS.map(({ name }, at) => `figure.${name} { grid-column: ${at + 1}; }`),
  "@media (max-width: 720px) { .viewports { grid-template-columns: minmax(0, 1fr); } .viewports > figure { grid-column: auto; } }",
  "figure { margin: 0; }",
  "figcaption { margin-bottom: 4px; font-weight: 600; }",
  "figure.error figcaption { color: #c62828; }",
  "img, video { display: block; max-width: 100%; height: auto; border: 1px solid #8888; }",
  "video { margin-top: 8px; }",
].join(" ");

/**
 * The prototype gallery: every variant under its letter and one-line
 * summary, its mobile and desktop screenshots side by side, each with its
 * video beneath it, all inlined so the page refers to nothing outside itself.
 * Uncapped, and never a pull request's: the Reviewer gets nothing from a Prototype.
 */
export function prototypeGallery(captures: readonly VariantShot[], variants: readonly GalleryVariant[], meta: PrototypeGalleryMeta): string {
  const { issue, route, headSha } = meta;
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${PROTOTYPE_POLICY}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escaped(`Prototype of ${route} for #${issue} at ${headSha.slice(0, 7)}`)}</title>`,
    `<style>${PROTOTYPE_STYLE}</style>`,
    "</head>",
    "<body>",
    `<h1>Prototype of <code>${escaped(route)}</code> for #${issue}</h1>`,
    `<p>Captured at <code>${headSha}</code>, served in the Sandbox: each variant is the route with <code>?variant=</code> and its letter, with a short video of it loading and scrolling where capture recorded one.</p>`,
    ...VARIANT_LETTERS.flatMap((letter) => variantSection(letter, variants, captures)),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** A variant's heading and summary, then its screenshots and videos, mobile beside desktop; none for a letter neither names. */
function variantSection(letter: VariantLetter, variants: readonly GalleryVariant[], captures: readonly VariantShot[]): string[] {
  const variant = variants.find((each) => each.letter === letter);
  const shots = UI_VIEWPORTS.flatMap(({ name }) => captures.filter((capture) => capture.variant === letter && capture.viewport === name));
  if (variant === undefined && shots.length === 0) return [];
  return [
    "<section>",
    `<h2>Variant ${letter}</h2>`,
    ...(variant === undefined ? [] : [`<p>${escaped(variant.summary)}</p>`]),
    shots.length === 0 ? "<p>Capture took no screenshot of this variant.</p>" : `<div class="viewports">${shots.map(variantFigure).join("")}</div>`,
    "</section>",
  ];
}

/** One viewport of a variant: its screenshot, inlined, and its video beneath it, captioned with the viewport and flagged when its page answered a server error. */
function variantFigure({ variant, viewport, status, png, webm }: VariantShot): string {
  const size = UI_VIEWPORTS.find(({ name }) => name === viewport);
  const named = size === undefined ? capitalised(viewport) : `${capitalised(viewport)}, ${size.width} × ${size.height}`;
  const caption = isServerError(status) ? `${named}: ${serverErrorWords(String(status), "this is")}` : named;
  const image = `<img alt="Variant ${variant} at ${viewport}" src="data:image/png;base64,${Buffer.from(png).toString("base64")}">`;
  const video =
    webm === undefined
      ? ""
      : `<video controls muted playsinline aria-label="Variant ${variant} at ${viewport}, loading and scrolling" src="data:video/webm;base64,${Buffer.from(webm).toString("base64")}"></video>`;
  return `<figure class="${viewport}${isServerError(status) ? " error" : ""}"><figcaption>${caption}</figcaption>${image}${video}</figure>`;
}

function capitalised(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** Text as HTML text or an attribute's value. */
function escaped(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
