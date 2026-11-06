// The UI evidence module (#153): whether a pull request is UI, which routes to
// capture and why, the capture result the Implement job's capture step
// writes and every later reader shares, which of its screenshots the Reviewer
// gets, and what the Operator reads of it on the PR: the evidence section, its
// marker, which the PR snapshot reads back, and withoutEvidence, which keeps
// both out of agent text. The gallery is beside it (src/evidence/gallery.ts).
// Pure, no I/O.
import { posix } from "node:path";
import { REVIEWER_IMAGE_CAP, UI_ROUTE_CAP, UI_VIEWPORTS, type UiConfig, type Viewport } from "../kit/config.ts";
import { linesOutsideCode } from "../loop/markers.ts";
import { withoutMentions } from "../loop/mentions.ts";
import { FULL_SHA } from "../skills/lock.ts";

/**
 * Whether a pull request is UI: some changed path matches one of `ui.paths`,
 * read as Node's path globs. Only the Kit makes this call, from the diff, never an agent.
 */
export function isUi(diffPaths: readonly string[], ui: UiConfig | null): boolean {
  return ui !== null && diffPaths.some((path) => ui.paths.some((glob) => posix.matchesGlob(path, glob)));
}

/** Why a route is captured, in the order routes are chosen: the Ticket named it, the Implementer did, or it's one of `ui.default_routes`. */
export const ROUTE_REASONS = ["ticket", "implementer", "default"] as const;

export type RouteReason = (typeof ROUTE_REASONS)[number];

/** A route UI evidence captures, and why. */
export interface ChosenRoute {
  readonly route: string;
  readonly reason: RouteReason;
}

/** An inline code span in a Ticket body: text between single backticks on one line. */
const CODE_SPAN = /`([^`\n]+)`/g;

/** A route a Ticket names: a path starting with a single `/` (so never `//host/...`), with no spaces. */
const TICKET_ROUTE = /^\/(?!\/)\S*$/;

/**
 * The routes a Ticket body names, in the order it names them. A Ticket names
 * a route by putting the path alone in an inline code span: `/book` or
 * `/services/physio` does, and so does `/` for the home page. A bare /book in
 * the text doesn't, nor does a code span holding anything else beside or
 * instead of one path (`GET /api/slots`, `src/pages/book.astro`, `/book now`),
 * nor anything in a fenced code block, which quotes code rather than names a route.
 */
function ticketRoutes(body: string): string[] {
  return linesOutsideCode(body)
    .flatMap((line) => [...line.matchAll(CODE_SPAN)].map(([, text = ""]) => text))
    .filter((text) => TICKET_ROUTE.test(text));
}

/**
 * The routes to capture, each with its reason: every route the Ticket names,
 * then the Implementer's, or `ui.default_routes` when neither names one. Each
 * route comes once, under the reason it was first named for, and the list
 * stops at UI_ROUTE_CAP unless the Ticket alone names more. An empty list is
 * what capture records as `no-routes`.
 */
export function routesFor(
  ticketBody: string,
  implementerRoutes: readonly string[],
  defaultRoutes: readonly string[],
): readonly ChosenRoute[] {
  const named = onceEach([
    ...ticketRoutes(ticketBody).map((route): ChosenRoute => ({ route, reason: "ticket" })),
    ...implementerRoutes.map((route): ChosenRoute => ({ route, reason: "implementer" })),
  ]);
  const routes = named.length > 0 ? named : onceEach(defaultRoutes.map((route) => ({ route, reason: "default" })));
  // The cap trims every route but the Ticket's, which always come first.
  return routes.filter(({ reason }, index) => reason === "ticket" || index < UI_ROUTE_CAP);
}

/** Each route once, where it first appears. */
function onceEach(routes: readonly ChosenRoute[]): ChosenRoute[] {
  return routes.filter(({ route }, index) => routes.findIndex((other) => other.route === route) === index);
}

/** Which site a capture is of: the production site at `ui.before_url`, or the branch served in the Sandbox. */
export const CAPTURE_SIDES = ["before", "after"] as const;

export type CaptureSide = (typeof CAPTURE_SIDES)[number];

/**
 * Why capture failed: the server never answered at `ui.url`, capture ran out
 * of time, there was no route to capture, or anything else it caught. The
 * push job records the last, `no-result`, itself: a UI pull request whose
 * Implement job passed it no capture result it could read.
 */
export const CAPTURE_FAILURES = ["server-did-not-start", "timeout", "no-routes", "error", "no-result"] as const;

export type CaptureFailure = (typeof CAPTURE_FAILURES)[number];

/** One screenshot: of which route and why, at which viewport, of which side, and what the page answered. */
export interface Capture {
  readonly route: string;
  readonly reason: RouteReason;
  readonly viewport: Viewport["name"];
  readonly side: CaptureSide;
  /** The HTTP status the page answered with; a 5xx is an error page, not a design. */
  readonly status: number;
  /** The image's file name: a plain name, in the same folder as the capture result. */
  readonly image: string;
}

/**
 * What the Implement job's capture step records, as a contract every later
 * reader shares: the PR body's evidence section, the Reviewer's images, and
 * the UI prototypes Spec (#80). A failed capture keeps whatever it took first.
 */
export type CaptureResult =
  | {
      readonly outcome: "captured";
      /** The head commit the branch was captured at. */
      readonly headSha: string;
      /** Never empty. */
      readonly captures: readonly Capture[];
    }
  | {
      readonly outcome: "failed";
      readonly reason: CaptureFailure;
      readonly headSha: string;
      readonly captures: readonly Capture[];
    };

export type CaptureResultRead =
  | { readonly ok: true; readonly result: CaptureResult }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Parses the capture result's text, then checks it against the contract. */
export function parseCaptureResult(text: string): CaptureResultRead {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`the capture result is not valid JSON: ${(error as Error).message}`] };
  }
  return readCaptureResult(value);
}

/** Checks an already-parsed capture result against the contract, naming every problem. */
export function readCaptureResult(value: unknown): CaptureResultRead {
  if (!isObject(value)) return { ok: false, errors: ["the capture result must be a JSON object"] };
  const { outcome, reason, headSha, captures } = value;
  const errors: string[] = [];
  if (outcome !== "captured" && outcome !== "failed") errors.push(`outcome must be "captured" or "failed"`);
  if (outcome === "failed" && !isOneOf(CAPTURE_FAILURES, reason)) errors.push(`reason must be ${spelled(CAPTURE_FAILURES)}`);
  if (typeof headSha !== "string" || !FULL_SHA.test(headSha)) errors.push("headSha must be a full commit SHA");
  if (!Array.isArray(captures)) errors.push("captures must be a list");
  else if (outcome === "captured" && captures.length === 0) errors.push(`captures can't be empty when the outcome is "captured"`);
  const read = Array.isArray(captures) ? captures.map((capture, at) => readCapture(capture, `captures[${at}]`, errors)) : [];
  errors.push(...repeatedCaptures(read));
  if (errors.length > 0) return { ok: false, errors };
  const checked = read as Capture[];
  const result: CaptureResult =
    outcome === "captured"
      ? { outcome, headSha: headSha as string, captures: checked }
      : { outcome: "failed", reason: reason as CaptureFailure, headSha: headSha as string, captures: checked };
  return { ok: true, result };
}

const VIEWPORT_NAMES = UI_VIEWPORTS.map(({ name }) => name);

/** A plain file name in the capture's folder: never a path, `..`, or a hidden file. */
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One capture, or null after naming its problems in `errors`. */
function readCapture(value: unknown, at: string, errors: string[]): Capture | null {
  if (!isObject(value)) {
    errors.push(`${at} must be an object`);
    return null;
  }
  const { route, reason, viewport, side, status, image } = value;
  const before = errors.length;
  // As the Implementer output reads a route, so a route it named never makes its capture unreadable.
  if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//")) {
    errors.push(`${at}.route must be a path starting with one /, such as /book`);
  }
  if (!isOneOf(ROUTE_REASONS, reason)) errors.push(`${at}.reason must be ${spelled(ROUTE_REASONS)}`);
  if (!isOneOf(VIEWPORT_NAMES, viewport)) errors.push(`${at}.viewport must be ${spelled(VIEWPORT_NAMES)}`);
  if (!isOneOf(CAPTURE_SIDES, side)) errors.push(`${at}.side must be ${spelled(CAPTURE_SIDES)}`);
  if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599) {
    errors.push(`${at}.status must be an HTTP status from 100 to 599`);
  }
  if (typeof image !== "string" || !IMAGE_NAME.test(image) || image.includes("..")) {
    errors.push(`${at}.image must be a plain file name, such as after-mobile-book.png, with no / or ..`);
  }
  if (errors.length > before) return null;
  return {
    route: route as string,
    reason: reason as RouteReason,
    viewport: viewport as Viewport["name"],
    side: side as CaptureSide,
    status: status as number,
    image: image as string,
  };
}

/**
 * Each image file and each route, viewport and side is one capture's alone,
 * since the gallery pairs Before and After by them and opens each file by name.
 */
function repeatedCaptures(captures: readonly (Capture | null)[]): string[] {
  const problems: string[] = [];
  captures.forEach((capture, at) => {
    if (capture === null) return;
    const earlier = captures.slice(0, at);
    const sameFile = earlier.findIndex((other) => other?.image === capture.image);
    const sameShot = earlier.findIndex(
      (other) => other?.route === capture.route && other.viewport === capture.viewport && other.side === capture.side,
    );
    if (sameFile !== -1) problems.push(`captures[${at}].image ${capture.image} is captures[${sameFile}]'s too`);
    if (sameShot !== -1) {
      problems.push(`captures[${at}] is ${capture.route} at ${capture.viewport}, ${capture.side}, which captures[${sameShot}] already is`);
    }
  });
  return problems;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return (options as readonly unknown[]).includes(value);
}

/** `a`, `a or b`, or `a, b or c`; or with `and`. */
function spelled(options: readonly string[], conjunction: "or" | "and" = "or"): string {
  return options.length <= 1 ? options.join("") : `${options.slice(0, -1).join(", ")} ${conjunction} ${options.at(-1)}`;
}

/**
 * The screenshots a Reviewer gets, at most REVIEWER_IMAGE_CAP so they fit in
 * its context, the ones that matter most first: After before Before, mobile
 * before desktop, then routes in reason order (the Ticket's, the
 * Implementer's, the defaults), each reason's routes in the order they were
 * captured. The Operator's gallery has them all.
 */
export function reviewerImages(captures: readonly Capture[]): readonly Capture[] {
  const routes = captures.map(({ route }) => route);
  const rank = ({ side, viewport, reason, route }: Capture): number[] => [
    side === "after" ? 0 : 1,
    UI_VIEWPORTS.findIndex(({ name }) => name === viewport),
    ROUTE_REASONS.indexOf(reason),
    routes.indexOf(route),
  ];
  return captures
    .toSorted((a, b) => {
      const [ranked, other] = [rank(a), rank(b)];
      return ranked.reduce((order, value, at) => order || value - (other[at] ?? 0), 0);
    })
    .slice(0, REVIEWER_IMAGE_CAP);
}

/** How the evidence section names why each route was captured. */
export const ROUTE_REASON_WORDS: Readonly<Record<RouteReason, string>> = {
  ticket: "named by the Ticket",
  implementer: "named by the Implementer",
  default: "a default route",
};

/**
 * Whether a pull request's preview deployment is linked: none is declared,
 * one is declared but not yet polled (the push job polls it once it has
 * pushed), it answered and is linked, or it never answered.
 */
export type PreviewLink =
  | { readonly kind: "none" }
  | { readonly kind: "pending" }
  | { readonly kind: "linked"; readonly url: string }
  | { readonly kind: "never-answered"; readonly url: string };

/** Where a UI pull request's evidence is kept, as its marker records it. */
export interface EvidenceMarker {
  /** The Actions run whose Implement job captured it. */
  readonly run: number;
  /** The id of that run's artifact holding the screenshots and the capture result, or null when it kept none. */
  readonly artifact: number | null;
}

/** A UI pull request's evidence, as the push job puts it together for the PR body. */
export interface UiEvidence extends EvidenceMarker {
  /** What capture recorded. */
  readonly result: CaptureResult;
  /** The gallery's web address, or null when the run kept none. */
  readonly gallery: string | null;
  readonly preview: PreviewLink;
}

/** The hidden line the evidence section opens with, so it can be found and replaced whole. */
const SECTION_START = "<!-- fabrik:ui-evidence-start -->";

/**
 * The evidence section of a UI pull request's body, between a hidden start
 * line and the marker (evidenceMarkerIn): why capture failed, when it did;
 * the gallery link; the preview link, or why there is none; and each
 * captured route with why it was chosen, flagged when it answered a server
 * error. A failed capture keeps the screenshots it took first, so the
 * section shows those too. Its routes may be agent text, so each shows as
 * code on one line and mentions nobody.
 */
export function evidenceSection(evidence: UiEvidence): string {
  const { result, gallery, preview } = evidence;
  const { captures } = result;
  return [
    SECTION_START,
    "## UI evidence",
    ...(result.outcome === "failed" ? ["", failureLine(result.reason, captures)] : []),
    ...(captures.length === 0 ? [] : ["", galleryLine(gallery, result)]),
    "",
    previewLine(preview),
    ...(captures.length === 0 ? [] : ["", "Captured routes:", "", ...capturedRoutes(captures).map((chosen) => routeLine(chosen, captures))]),
    evidenceMarker(evidence),
  ].join("\n");
}

/** Why capture failed, in plain words. */
export const FAILURE_WORDS: Readonly<Record<CaptureFailure, string>> = {
  "server-did-not-start": "the server wouldn't start: nothing answered at `ui.url` once `ui.serve` ran",
  timeout: "it ran out of time",
  "no-routes": "there was no route to capture: neither the Ticket nor the Implementer named one, and Kit config sets no `ui.default_routes`",
  error: "it hit an error the Kit didn't expect, which the Implement job's log shows",
  "no-result": "it left no result the push job could read",
};

/** A failed capture's reason, and the screenshots it took first: a failed capture keeps them. */
function failureLine(reason: CaptureFailure, captures: readonly Capture[]): string {
  const took = captures.length === 0 ? "There are no screenshots." : `It took ${screenshots(captures.length)} first.`;
  return `**Capture failed:** ${FAILURE_WORDS[reason]}. ${took}`;
}

function screenshots(count: number): string {
  return `${count} screenshot${count === 1 ? "" : "s"}`;
}

/** A captured route, why it was chosen, and every screenshot of it that shows a server's error page rather than the design. */
function routeLine({ route, reason }: ChosenRoute, captures: readonly Capture[]): string {
  // Its route may be the Implementer's: agent text, which never mentions anyone.
  const line = `- ${code(withoutMentions(route))}, ${ROUTE_REASON_WORDS[reason]}`;
  const errors = captures.filter((capture) => capture.route === route && isServerError(capture.status));
  if (errors.length === 0) return line;
  const answered = errors.map(({ status, side, viewport }) => `${status} for ${SIDE_WORDS[side]} at ${viewport}`);
  const shows = errors.length === 1 ? "that screenshot shows" : "those screenshots show";
  return `${line}. **Server error:** it answered ${spelled(answered, "and")}, so ${shows} an error page, not the design.`;
}

/** Whether a page answered with a server error, so its screenshot is of an error page. */
export function isServerError(status: number): boolean {
  return status >= 500 && status <= 599;
}

/** How the evidence names each side. */
export const SIDE_WORDS: Readonly<Record<CaptureSide, string>> = { before: "Before", after: "After" };

function galleryLine(url: string | null, { headSha, captures }: CaptureResult): string {
  if (url === null) return `The Implement run kept no gallery of its ${screenshots(captures.length)}.`;
  const besideProduction = captures.some(({ side }) => side === "before") ? " beside the production site" : "";
  const viewports = UI_VIEWPORTS.map(({ name }) => name).filter((name) => captures.some(({ viewport }) => viewport === name));
  return `${link("Open the gallery", url)} of ${screenshots(captures.length)}: this branch at \`${headSha.slice(0, 7)}\`${besideProduction}, at ${spelled(viewports, "and")} ${viewports.length === 1 ? "width" : "widths"}.`;
}

function previewLine(preview: PreviewLink): string {
  switch (preview.kind) {
    case "linked":
      return `${link("Open the preview deployment", preview.url)}.`;
    case "never-answered":
      // As code, so GitHub doesn't link an address that never answered.
      return `No preview link: the preview at ${code(preview.url)} never answered.`;
    case "pending":
      return "The preview deployment is linked here once it answers.";
    case "none":
      return "No preview link: Kit config declares no `preview.url`.";
  }
}

/** Each captured route once, in the order it was first captured, with its reason. */
function capturedRoutes(captures: readonly Capture[]): ChosenRoute[] {
  return onceEach(captures.map(({ route, reason }) => ({ route, reason })));
}

/** The marker line closing the evidence section. */
function evidenceMarker({ run, artifact }: EvidenceMarker): string {
  return `<!-- fabrik:ui-evidence ${JSON.stringify({ run, artifact })} -->`;
}

/** The marker line, matched against a whole line with its outer whitespace trimmed. */
const EVIDENCE_MARKER = /^<!-- fabrik:ui-evidence (\{.*\}) -->$/;

/**
 * Where the marker in this body says its UI evidence is kept, or null when it
 * has none: not a UI pull request. Read only from a body the Fabrik App wrote
 * (src/github/snapshot.ts). The last marker counts, the section being Kit
 * text after the Implementer's summary, and one that doesn't read is none.
 */
export function evidenceMarkerIn(body: string): EvidenceMarker | null {
  const markers = body.split("\n").flatMap((line) => {
    const marker = markerOf(EVIDENCE_MARKER.exec(line.trim())?.[1]);
    return marker === null ? [] : [marker];
  });
  return markers.at(-1) ?? null;
}

function markerOf(json: string | undefined): EvidenceMarker | null {
  if (json === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const { run, artifact } = value;
  if (!isId(run) || !(artifact === null || isId(artifact))) return null;
  return { run, artifact };
}

/** A GitHub id: a whole number above zero. */
function isId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * A line that looks like one of the evidence section's hidden lines, matched
 * with its outer whitespace trimmed: its start line, its marker, or anything
 * spaced or spelled near enough to pass for either. withoutEvidence drops them all.
 */
const EVIDENCE_LINE = /^<!--\s*fabrik:ui-evidence\b.*-->$/;

const SECTION_START_LINE = /^<!--\s*fabrik:ui-evidence-start\s*-->$/;

/**
 * The text without its evidence: every evidence section, from its start line
 * through the marker after it, and any other line that looks like an evidence
 * line, even in a code block, each with the blank lines that set it apart.
 * The rest stays as it was. Run on agent text, so no agent can forge a marker
 * or carry an old section forward.
 */
export function withoutEvidence(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? "";
    if (!EVIDENCE_LINE.test(line.trim())) {
      kept.push(line);
      continue;
    }
    // A start line opens a section through the marker after it; with no marker after it, it goes alone.
    const end = SECTION_START_LINE.test(line.trim())
      ? lines.findIndex((each, i) => i > at && EVIDENCE_LINE.test(each.trim()) && !SECTION_START_LINE.test(each.trim()))
      : -1;
    if (end !== -1) at = end;
    while (at + 1 < lines.length && isBlank(lines[at + 1])) at++;
    if (at === lines.length - 1) while (kept.length > 0 && isBlank(kept.at(-1))) kept.pop();
  }
  return kept.join("\n");
}

function isBlank(line: string | undefined): boolean {
  return line !== undefined && line.trim() === "";
}

/** A Markdown link. */
function link(text: string, url: string): string {
  return `[${text}](<${url}>)`;
}

/**
 * Text as one Markdown code span on one line, whatever it holds: a line
 * break or other control character shows as U+FFFD, so agent text can never
 * start a line of its own, and the span's backticks outnumber any run of them inside.
 */
export function code(text: string): string {
  const oneLine = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "\uFFFD");
  const longest = Math.max(0, ...[...oneLine.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = "`".repeat(longest + 1);
  // CommonMark drops one space each side, so a backtick at either end stays in the span.
  const pad = oneLine.startsWith("`") || oneLine.endsWith("`") ? " " : "";
  return `${fence}${pad}${oneLine}${pad}${fence}`;
}
