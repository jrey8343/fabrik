// The UI evidence module (#153): whether a pull request is UI, which routes to
// capture and why, the capture result the Implement job's capture step
// writes and every later reader shares, which of its screenshots the Reviewer
// gets and what its prompt says of them (src/agent/review.ts only reads the
// files in), and what the Operator reads of it on the PR: the evidence
// section, its marker, which the PR snapshot reads back, and withoutEvidence,
// which keeps both out of agent text. A prototype turn's capture of its
// variants (#155) shares the capture result, and neither the Reviewer nor the
// evidence section ever shows it. The Evidence pages, the PR's and the
// prototype's, are beside it (src/evidence/evidencePage.ts). Pure, no I/O.
import { posix } from "node:path";
import {
  type CaptureIdentity,
  isCaptureIdentity,
  isRoute,
  NAMED_SHOT_CAP,
  REVIEWER_IMAGE_CAP,
  UI_ROUTE_CAP,
  UI_VIEWPORTS,
  type UiConfig,
  type Viewport,
} from "../kit/config.ts";
import { PROTOTYPE_VARIANT_CAP, variantLetter } from "../loop/designOutput.ts";
import { isShotName, SHOT_NAME_RULE, type ShotMiss } from "./shotsManifest.ts";
import { linesOutsideCode, markerJson } from "../loop/markers.ts";
import { withoutMentions } from "../loop/mentions.ts";
import { spelled } from "../loop/readable.ts";
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

/** A route a Ticket names: a route (isRoute), and with no spaces, so `/book now` is prose, not a route. */
function isTicketRoute(text: string): boolean {
  return isRoute(text) && !/\s/.test(text);
}

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
    .filter(isTicketRoute);
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

/**
 * A path segment that stands for a value rather than names a page, as a
 * framework's route files spell one: `[patientId]` (or `[...slug]`),
 * `<patientId>`, or `:patientId`.
 */
const DYNAMIC_SEGMENT = /\[[^\]/]*\]|<[^>/]*>|^:[A-Za-z_]/;

/**
 * Whether a route has a dynamic segment (DYNAMIC_SEGMENT) in its path, its
 * query and fragment left out: a route no page answers as written, which
 * capture resolves through `ui.resolve_route` (ADR-0024) or misses.
 */
export function hasDynamicSegment(route: string): boolean {
  return route
    .replace(/[?#].*$/s, "")
    .split("/")
    .some((segment) => DYNAMIC_SEGMENT.test(segment));
}

/** Which site a capture is of: the production site at `ui.before_url`, or the branch served in the Sandbox. */
export const CAPTURE_SIDES = ["before", "after"] as const;

export type CaptureSide = (typeof CAPTURE_SIDES)[number];

/**
 * Why capture failed: `sandbox.build` failed, the server never answered at
 * `ui.url`, capture ran out of time, there was no route to capture, a
 * prototype turn's capture had no variant to capture, a Capture identity's
 * sign-in failed (ADR-0012), no page it went to would load, so it took no
 * screenshot, or anything else it caught. The push job records the last, `no-result`, itself: a UI pull
 * request whose Implement job passed it no capture result it could read. The capture step's own
 * timeout, which kills it before it records a result, is `timeout` all the same.
 */
export const CAPTURE_FAILURES = ["build-failed", "server-did-not-start", "timeout", "no-routes", "no-variants", "sign-in-failed", "unreachable", "error", "no-result"] as const;

export type CaptureFailure = (typeof CAPTURE_FAILURES)[number];

/** One screenshot of a pull request: of which route and why, at which viewport, of which side, and what the page answered. */
export interface Capture {
  readonly route: string;
  readonly reason: RouteReason;
  readonly viewport: Viewport["name"];
  readonly side: CaptureSide;
  /** The HTTP status the page answered with; a 5xx is an error page, not a design. */
  readonly status: number;
  /** The image's file name: a plain name, in the same folder as the capture result. */
  readonly image: string;
  /**
   * The Capture identity the page was viewed as (ADR-0012), or absent when it
   * was viewed signed out, as every capture written before sign-ins was.
   */
  readonly identity?: CaptureIdentity;
  /**
   * The path the page was captured at, when `route` has a dynamic segment
   * that `ui.resolve_route` resolved (ADR-0024); absent, it was captured at
   * `route`, as every capture written before resolving was.
   */
  readonly resolved?: string;
}

/** Why capture missed a shot of a side and went on to the rest: its page wouldn't load, refused or not found (MissedShot). */
export type Unreachable = `${CaptureSide}-unreachable`;

/**
 * Why a route with a dynamic segment wasn't resolved, so none of it was
 * captured (ADR-0024): Kit config sets no `ui.resolve_route`; its command
 * exited non-zero, with its code, or was killed by a signal; it ran past its
 * time; it printed no path; or the path it printed still has a dynamic segment.
 */
export type UnresolvedError = "no-resolve-route" | `exit-${number}` | "exit-signal" | "timed-out" | "bad-output" | "still-dynamic";

/** What reads as an UnresolvedError. */
const UNRESOLVED_ERROR = /^(?:no-resolve-route|exit-(?:\d{1,3}|signal)|timed-out|bad-output|still-dynamic)$/;

/**
 * A screenshot of a pull request capture meant to take but missed, going on
 * to the rest: of which route and why, at which viewport, of which side and
 * URL, and why it missed. Its page wouldn't load, with the browser's error
 * code, such as ERR_CONNECTION_REFUSED when production was down or refused
 * the browser; its route's dynamic segment wasn't resolved, so no page was
 * visited; or, an After, its page answered a 4xx or 5xx, so no screenshot was kept.
 */
export type MissedShot = MissedShotFields &
  (
    | { readonly why: Unreachable; readonly error: string }
    | { readonly why: "unresolved-route"; readonly error: UnresolvedError }
    | { readonly why: "error-status"; readonly status: number }
  );

/** What every missed shot names, whatever it missed for. */
interface MissedShotFields extends ChosenRoute {
  readonly viewport: Viewport["name"];
  readonly side: CaptureSide;
  /** The URL capture went to, or would have gone to for an unresolved route. */
  readonly url: string;
  /** The path `route` was resolved to (ADR-0024), when it was. */
  readonly resolved?: string;
}

/** Whether a page's status is an error page's, 4xx or 5xx, which an After never keeps as a capture. */
export function isErrorStatus(status: number): boolean {
  return status >= 400 && status <= 599;
}

/** Whether a path a route resolved to reads: a route with nothing a URL's path can't hold as it is, and no dynamic segment left. */
export function isResolvedPath(value: unknown): value is string {
  return isRoute(value) && !/[\s\u0000-\u001f\u007f]/.test(value) && !hasDynamicSegment(value);
}

/** The letters a Prototype's variants go by, in order, one for each up to PROTOTYPE_VARIANT_CAP: A is the first (variantLetter). */
export const VARIANT_LETTERS: readonly string[] = Array.from({ length: PROTOTYPE_VARIANT_CAP }, (_, at) => variantLetter(at));

/**
 * One capture of a Prototype's variant, served at `route?variant=<letter>`:
 * a capture like a pull request's, but of a variant rather than a side, and
 * with the short load-and-scroll video capture recorded beside its screenshot,
 * when it recorded one. Its route is the one the Prototype was approved for,
 * so it has no reason.
 */
export interface VariantCapture extends Omit<Capture, "reason" | "side"> {
  /** One of VARIANT_LETTERS. */
  readonly variant: string;
  /** The video's file name, a plain name beside the image. */
  readonly video?: string;
}

/** Whether a capture is of a Prototype's variant rather than a pull request's side. */
export function isVariantCapture(capture: Capture | VariantCapture): capture is VariantCapture {
  return "variant" in capture;
}

/** The captures of a pull request's sides, leaving out any of a Prototype's variants. */
function sideCaptures(captures: readonly (Capture | VariantCapture)[]): Capture[] {
  return captures.filter((capture): capture is Capture => !isVariantCapture(capture));
}

/**
 * What the Implement job's capture step records, and a prototype turn's
 * capture of its variants, as a contract every later reader shares: the PR
 * body's evidence section, the Reviewer's images, and the prototype round
 * (#155). A failed capture keeps whatever it took first. A pull request's
 * capture holds only Captures, and a prototype turn's only VariantCaptures,
 * as CaptureResult<Capture> and CaptureResult<VariantCapture> say; a reader
 * takes either. A pull request's capture names any shot it missed and went on
 * past in `missed`, absent when it missed none.
 */
export type CaptureResult<C extends Capture | VariantCapture = Capture | VariantCapture> =
  | {
      readonly outcome: "captured";
      /** The head commit the branch was captured at. */
      readonly headSha: string;
      /** Never empty. */
      readonly captures: readonly C[];
      readonly missed?: readonly MissedShot[];
    }
  | {
      readonly outcome: "failed";
      readonly reason: CaptureFailure;
      readonly headSha: string;
      readonly captures: readonly C[];
      readonly missed?: readonly MissedShot[];
    };

/**
 * The capture result's file, beside the screenshots in the folder capture
 * writes (EVIDENCE_DIR) and in its zipped artifact: the one name the capture
 * step writes it under and the Reviewer and every reader of the read library
 * look for, so it sits here beside its reader, which a Worker can load.
 */
export const CAPTURE_RESULT_FILE = "capture-result.json";

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
  const { outcome, reason, headSha, captures, missed } = value;
  const errors: string[] = [];
  if (outcome !== "captured" && outcome !== "failed") errors.push(`outcome must be "captured" or "failed"`);
  if (outcome === "failed" && !isOneOf(CAPTURE_FAILURES, reason)) errors.push(`reason must be ${spelled(CAPTURE_FAILURES)}`);
  if (typeof headSha !== "string" || !FULL_SHA.test(headSha)) errors.push("headSha must be a full commit SHA");
  if (!Array.isArray(captures)) errors.push("captures must be a list");
  else if (outcome === "captured" && captures.length === 0) errors.push(`captures can't be empty when the outcome is "captured"`);
  const read = Array.isArray(captures) ? captures.map((capture, at) => readCapture(capture, `captures[${at}]`, errors)) : [];
  errors.push(...repeatedCaptures(read));
  if (missed !== undefined && !Array.isArray(missed)) errors.push("missed must be a list");
  const readMissed = Array.isArray(missed) ? missed.map((shot, at) => readMissedShot(shot, `missed[${at}]`, errors)) : [];
  if (errors.length > 0) return { ok: false, errors };
  const checked = read as (Capture | VariantCapture)[];
  const named = missed === undefined ? {} : { missed: readMissed as MissedShot[] };
  const result: CaptureResult =
    outcome === "captured"
      ? { outcome, headSha: headSha as string, captures: checked, ...named }
      : { outcome: "failed", reason: reason as CaptureFailure, headSha: headSha as string, captures: checked, ...named };
  return { ok: true, result };
}

const VIEWPORT_NAMES = UI_VIEWPORTS.map(({ name }) => name);

/** A plain file name in the capture's folder: never a path, `..`, or a hidden file. */
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isFileName(value: unknown): value is string {
  return typeof value === "string" && IMAGE_NAME.test(value) && !value.includes("..");
}

/** One capture, or null after naming its problems in `errors`: a variant's when it names a variant, else a side's. */
function readCapture(value: unknown, at: string, errors: string[]): Capture | VariantCapture | null {
  if (!isObject(value)) {
    errors.push(`${at} must be an object`);
    return null;
  }
  const { route, reason, viewport, side, variant, status, image, video, identity, resolved } = value;
  const ofVariant = variant !== undefined;
  const before = errors.length;
  // As the Implementer output reads a route, so a route it named never makes its capture unreadable.
  if (!isRoute(route)) {
    errors.push(`${at}.route must be a path starting with one /, such as /book`);
  }
  if (!ofVariant && !isOneOf(ROUTE_REASONS, reason)) errors.push(`${at}.reason must be ${spelled(ROUTE_REASONS)}`);
  if (!isOneOf(VIEWPORT_NAMES, viewport)) errors.push(`${at}.viewport must be ${spelled(VIEWPORT_NAMES)}`);
  if (!ofVariant && !isOneOf(CAPTURE_SIDES, side)) errors.push(`${at}.side must be ${spelled(CAPTURE_SIDES)}`);
  if (ofVariant && !isOneOf(VARIANT_LETTERS, variant)) errors.push(`${at}.variant must be ${spelled(VARIANT_LETTERS)}`);
  if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599) {
    errors.push(`${at}.status must be an HTTP status from 100 to 599`);
  }
  if (!isFileName(image)) {
    const example = ofVariant ? "variant-a-mobile.png" : "after-mobile-book.png";
    errors.push(`${at}.image must be a plain file name, such as ${example}, with no / or ..`);
  }
  if (ofVariant && video !== undefined && !isFileName(video)) {
    errors.push(`${at}.video must be a plain file name, such as variant-a-mobile.webm, with no / or ..`);
  }
  if (identity !== undefined && !isCaptureIdentity(identity)) {
    errors.push(`${at}.identity must be a Capture identity's name, such as owner: letters, digits, - and _`);
  }
  if (!ofVariant && resolved !== undefined && !isResolvedPath(resolved)) errors.push(resolvedProblem(at));
  // Whether it's a side's or a variant's decides how every reader shows it.
  if (ofVariant && side !== undefined) errors.push(`${at} must have a side or a variant, not both`);
  if (errors.length > before) return null;
  const signedIn = identity === undefined ? {} : { identity: identity as CaptureIdentity };
  if (ofVariant) {
    return {
      route: route as string,
      variant: variant as string,
      viewport: viewport as Viewport["name"],
      status: status as number,
      image: image as string,
      ...(video === undefined ? {} : { video: video as string }),
      ...signedIn,
    };
  }
  return {
    route: route as string,
    reason: reason as RouteReason,
    viewport: viewport as Viewport["name"],
    side: side as CaptureSide,
    status: status as number,
    image: image as string,
    ...signedIn,
    ...(resolved === undefined ? {} : { resolved: resolved as string }),
  };
}

function resolvedProblem(at: string): string {
  return `${at}.resolved must be the path a dynamic route was captured at, such as /patients/0b7e, with no dynamic segment left`;
}

/** A browser's error code for a page that wouldn't load, as Chromium names it: ERR_CONNECTION_REFUSED. */
const BROWSER_ERROR = /^ERR_[A-Z0-9_]+$/;

/** One missed shot, or null after naming its problems in `errors`. */
function readMissedShot(value: unknown, at: string, errors: string[]): MissedShot | null {
  if (!isObject(value)) {
    errors.push(`${at} must be an object`);
    return null;
  }
  const { route, reason, viewport, side, url, why, error, status, resolved } = value;
  const before = errors.length;
  if (!isRoute(route)) errors.push(`${at}.route must be a path starting with one /, such as /book`);
  if (!isOneOf(ROUTE_REASONS, reason)) errors.push(`${at}.reason must be ${spelled(ROUTE_REASONS)}`);
  if (!isOneOf(VIEWPORT_NAMES, viewport)) errors.push(`${at}.viewport must be ${spelled(VIEWPORT_NAMES)}`);
  if (typeof url !== "string" || !URL.canParse(url)) errors.push(`${at}.url must be the URL capture went to`);
  if (resolved !== undefined && !isResolvedPath(resolved)) errors.push(resolvedProblem(at));
  if (!isOneOf(CAPTURE_SIDES, side)) errors.push(`${at}.side must be ${spelled(CAPTURE_SIDES)}`);
  else if (why === "unresolved-route" || why === "error-status") {
    // Only an After is ever missed for these: a dynamic route has no Before, and a Before's error page is kept.
    if (side !== "after") errors.push(`${at}.side must be after for a shot missed as ${why}`);
    if (why === "unresolved-route" && (typeof error !== "string" || !UNRESOLVED_ERROR.test(error))) {
      errors.push(`${at}.error must say why the route wasn't resolved: no-resolve-route, exit- and its code, exit-signal, timed-out, bad-output or still-dynamic`);
    }
    if (why === "error-status" && (!Number.isInteger(status) || !isErrorStatus(status as number))) errors.push(`${at}.status must be an HTTP error status from 400 to 599`);
  } else if (why !== `${side}-unreachable`) errors.push(`${at}.why must be ${side}-unreachable, its side's, unresolved-route or error-status`);
  if (why !== "unresolved-route" && why !== "error-status" && (typeof error !== "string" || !BROWSER_ERROR.test(error))) {
    errors.push(`${at}.error must be a browser error code, such as ERR_CONNECTION_REFUSED`);
  }
  if (errors.length > before) return null;
  const shot = { route, reason, viewport, side, url, ...(resolved === undefined ? {} : { resolved }) };
  return (why === "error-status" ? { ...shot, why, status } : { ...shot, why, error }) as MissedShot;
}

/** Which shot of its route and viewport a capture is: its side, or its variant. */
function shotOf(capture: Capture | VariantCapture): string {
  return isVariantCapture(capture) ? `variant ${capture.variant}` : capture.side;
}

/** A capture's files, each by the field that names it: its image, then its video when it has one. */
function filesOf(capture: Capture | VariantCapture): ["image" | "video", string][] {
  const video = isVariantCapture(capture) ? capture.video : undefined;
  return [["image", capture.image], ...(video === undefined ? [] : [["video", video] as ["video", string]])];
}

/**
 * Each image or video file and each route, viewport and side or variant is
 * one capture's alone, since the Evidence pages pair captures by them and
 * open each file by name.
 */
function repeatedCaptures(captures: readonly (Capture | VariantCapture | null)[]): string[] {
  const problems: string[] = [];
  /** Every file named so far, with the capture that named it. */
  const named: { readonly name: string; readonly at: number }[] = [];
  captures.forEach((capture, at) => {
    if (capture === null) return;
    const earlier = captures.slice(0, at);
    for (const [field, name] of filesOf(capture)) {
      const owner = named.find((file) => file.name === name);
      if (owner !== undefined) problems.push(`captures[${at}].${field} ${name} is captures[${owner.at}]'s too`);
      named.push({ name, at });
    }
    const sameShot = earlier.findIndex(
      (other) => other !== null && other.route === capture.route && other.viewport === capture.viewport && shotOf(other) === shotOf(capture),
    );
    if (sameShot !== -1) {
      problems.push(`captures[${at}] is ${capture.route} at ${capture.viewport}, ${shotOf(capture)}, which captures[${sameShot}] already is`);
    }
  });
  return problems;
}

/** The capture failure a value names, or null when it names none the Kit knows. */
export function captureFailureOf(value: unknown): CaptureFailure | null {
  return isOneOf(CAPTURE_FAILURES, value) ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return (options as readonly unknown[]).includes(value);
}

/**
 * The screenshots a Reviewer gets, at most REVIEWER_IMAGE_CAP so they fit in
 * its context, the ones that matter most first: After before Before, mobile
 * before desktop, then routes in reason order (the Ticket's, the
 * Implementer's, the defaults), each reason's routes in the order they were
 * captured. The Operator's Evidence page has them all. None is ever of a
 * Prototype's variant: the Reviewer gets nothing from a Prototype.
 */
export function reviewerImages(captures: readonly (Capture | VariantCapture)[]): readonly Capture[] {
  const sides = sideCaptures(captures);
  const routes = sides.map(({ route }) => route);
  const rank = ({ side, viewport, reason, route }: Capture): number[] => [
    side === "after" ? 0 : 1,
    UI_VIEWPORTS.findIndex(({ name }) => name === viewport),
    ROUTE_REASONS.indexOf(reason),
    routes.indexOf(route),
  ];
  return sides
    .toSorted((a, b) => {
      const [ranked, other] = [rank(a), rank(b)];
      return ranked.reduce((order, value, at) => order || value - (other[at] ?? 0), 0);
    })
    .slice(0, REVIEWER_IMAGE_CAP);
}

/** Where in its working directory a UI PR's Reviewer finds the screenshots it's given. */
export const REVIEWER_IMAGES_DIR = "fabrik-ui-evidence";

const UI_PR = "This pull request changes the Product repo's UI";

/** What a UI PR's Reviewer is given of its UI evidence, for its prompt's block. */
export interface ReviewerEvidence {
  /** The capture result the Review job downloaded, or null when it read none. */
  readonly result: CaptureResult | null;
  /** The captures whose screenshots are in REVIEWER_IMAGES_DIR. */
  readonly given: readonly Capture[];
  /** The PR's head as the Review job read it, or null when its input names none. */
  readonly head: string | null;
  /**
   * Why the PR's capture failed, as its marker records it, or null when it
   * records none: what the Reviewer hears when there's no capture result to read.
   */
  readonly recorded: CaptureFailure | null;
}

/**
 * The UI evidence block of a UI PR's review prompt: the screenshots it was
 * given, each by route, viewport and side, and what to judge in them; or,
 * when capture failed, left no result, or took screenshots none of which were
 * copied for the Review, why, and to review the code as usual. Any push to the PR starts a Review with the last Implement run's
 * evidence, so when the PR's head isn't the commit captured, the block says
 * the screenshots are of an earlier one.
 */
export function reviewerEvidenceBlock({ result, given, head, recorded }: ReviewerEvidence): string[] {
  if (result === null || given.length === 0) {
    // With no capture result to read, the marker's reason is the one the PR body gives.
    const failure = result === null ? recorded : result.outcome === "failed" ? result.reason : null;
    const why =
      failure !== null
        ? `capture failed because ${FAILURE_WORDS[failure]}`
        : result === null
          ? UNREAD
          : `the ${screenshots(result.captures.length)} capture took of this branch at \`${result.headSha.slice(0, 7)}\` weren't copied for this Review`;
    return ["## UI evidence", `${UI_PR}, but ${why}. There are no screenshots, so review the code as usual.`];
  }
  const captured = `\`${result.headSha.slice(0, 7)}\``;
  const at = `this branch at ${captured}`;
  const opening =
    result.outcome === "captured"
      ? `${UI_PR}, so the Kit captured screenshots of ${at} once the Implementer's run had ended.`
      : `${UI_PR}, but ${reviewerFailureWords(result.reason)}. Review the code as usual, and judge the ${screenshots(given.length)} it took first, of ${at}, as below.`;
  const [they, show] = given.length === 1 ? ["It was", "it shows"] : ["They were", "they show"];
  const stale =
    head === null || head === result.headSha
      ? []
      : [`${they} captured at ${captured}, before the PR's current head \`${head.slice(0, 7)}\`, so later commits may change what ${show}.`];
  const where = given.length === 1 ? "It's" : `These ${given.length} are`;
  const of = given.length < result.captures.length ? ` They're the ${given.length} that matter most of the ${result.captures.length} it took.` : "";
  return [
    "## UI evidence",
    [
      opening,
      ...stale,
      "After is this branch, served in the Implement run's Sandbox; Before, where there is one, is the production site.",
      ...(given.some(({ identity }) => identity !== undefined) ? [NO_SIGNED_IN_BEFORE] : []),
      ...(given.some(({ resolved }) => resolved !== undefined) ? [NO_RESOLVED_BEFORE] : []),
      ...missingSides(result.missed ?? []),
      "Each shows one screen of the page from its top, not the whole page, so content below its bottom edge is out of view rather than cut off.",
      `${where} in \`${REVIEWER_IMAGES_DIR}/\` in your working directory: open each with your Read tool to see it.${of}`,
    ].join(" "),
    given.map(reviewerImageLine).join("\n"),
    "Judge them as part of the PR:",
    [
      "- Do they show what the Ticket asked for?",
      "- Is there plain breakage: a blank or error page, content spilling over at mobile width, or overlapping or cut-off content?",
      "- Against Before, where there is one, has any part of the page the Ticket didn't touch regressed?",
    ].join("\n"),
    "Taste is the Operator's: don't fail the PR over a design choice the Ticket didn't settle. A visual failure is an `execution-flaw` like any other: name the route and the screenshot in the finding, so the Implementer knows what to fix.",
  ];
}

/** What the Reviewer's block says of a signed-in screenshot's Before, when it's given one. */
const NO_SIGNED_IN_BEFORE = "A screenshot signed in as a Capture identity, a fake user of the Sandbox's own server, has no Before, since Before is never signed in.";

/** What the Reviewer's block says of a resolved screenshot's Before, when it's given one (ADR-0024). */
const NO_RESOLVED_BEFORE =
  "A route with a dynamic segment, resolved to a record on the Sandbox's own server, has no Before, since the production site Before is taken from doesn't hold that record.";

/** Where each side's page is, and what its missing leaves the Reviewer without, for a route or for several. */
const MISSING_WORDS: Readonly<Record<CaptureSide, { readonly site: string; readonly without: (several: boolean) => string }>> = {
  before: { site: "the production site", without: (several) => `so there's no Before to compare ${several ? "their" : "its"} After against` },
  after: { site: "this branch's page", without: (several) => `so there's no screenshot of ${several ? "them" : "it"}` },
};

/**
 * For each side capture missed shots of, and each way it missed them, the
 * routes it's missing for and why, in the Reviewer's block: none when it missed none.
 */
function missingSides(missed: readonly MissedShot[]): string[] {
  return CAPTURE_SIDES.flatMap((side) => {
    const { site, without } = MISSING_WORDS[side];
    const ofSide = missed.filter((shot) => shot.side === side);
    const missing = (shots: readonly MissedShot[], where: (several: boolean) => string, details: readonly string[]) => {
      if (shots.length === 0) return [];
      const routes = [...new Set(shots.map(({ route }) => route))];
      const several = routes.length > 1;
      return [`${SIDE_WORDS[side]} is missing for ${spelled(routes.map(code), "and")}, ${where(several)} (${spelled([...new Set(details)], "and")}), ${without(several)}.`];
    };
    const unreachable = ofSide.filter((shot) => shot.why === `${side}-unreachable`);
    const unresolved = ofSide.filter((shot) => shot.why === "unresolved-route");
    const errorPages = ofSide.filter((shot) => shot.why === "error-status");
    return [
      ...missing(unreachable, () => `where ${site} wouldn't load`, unreachable.map((shot) => code("error" in shot ? shot.error : ""))),
      ...missing(
        unresolved,
        (several) => `${several ? "routes" : "a route"} with a dynamic segment that wasn't resolved to a page`,
        unresolved.map((shot) => (shot.why === "unresolved-route" ? unresolvedWords(shot.error) : "")),
      ),
      ...missing(errorPages, () => `where ${site} answered an error page`, errorPages.map((shot) => code("status" in shot ? String(shot.status) : ""))),
    ];
  });
}

/** Which of UnresolvedError's kinds an error is: an exit code's is by its prefix. */
function unresolvedKind(error: UnresolvedError): "no-resolve-route" | "exit" | "exit-signal" | "timed-out" | "bad-output" | "still-dynamic" {
  return error.startsWith("exit-") && error !== "exit-signal" ? "exit" : (error as Exclude<UnresolvedError, `exit-${number}`>);
}

/** Why a dynamic route wasn't resolved, in the words the evidence section and the Reviewer's block share. */
const UNRESOLVED_WORDS: Readonly<Record<ReturnType<typeof unresolvedKind>, (error: UnresolvedError) => string>> = {
  "no-resolve-route": () => "Kit config sets no `ui.resolve_route`",
  exit: (error) => `\`ui.resolve_route\` exited ${error.slice("exit-".length)}`,
  "exit-signal": () => "`ui.resolve_route` was stopped by a signal",
  "timed-out": () => `\`ui.resolve_route\` ran past its ${RESOLVE_ROUTE_MINUTES} minutes`,
  "bad-output": () => "`ui.resolve_route` printed no path",
  "still-dynamic": () => "`ui.resolve_route` printed a path that still has a dynamic segment",
};

function unresolvedWords(error: UnresolvedError): string {
  return UNRESOLVED_WORDS[unresolvedKind(error)](error);
}

/** How long capture gives each run of `ui.resolve_route`, in minutes: capture's own, which a reader words it by. */
export const RESOLVE_ROUTE_MINUTES = 2;

/**
 * A route as the evidence names it, each part in its reader's markup: its
 * pattern, and beside it the path it was resolved to, when it was (ADR-0024).
 */
export function routeWords(route: string, resolved: string | undefined, markup: (text: string) => string): string {
  return resolved === undefined ? markup(route) : `${markup(route)} resolved to ${markup(resolved)}`;
}

/** Why the Reviewer has no screenshots when there's no capture result to read, and nothing says why capture failed. */
const UNREAD = "capture left no result this Review could read: the Implement run kept none, or they have expired";

/** Why the Reviewer has no full set of screenshots: capture failed, or left none its Review could read. */
function reviewerFailureWords(reason: CaptureFailure): string {
  return reason === "no-result" ? UNREAD : `capture failed because ${FAILURE_WORDS[reason]}`;
}

/** One screenshot the Reviewer is given: its file, then its route (agent text, so as code on one line), viewport and side. */
function reviewerImageLine({ image, route, resolved, viewport, side, status, identity }: Capture): string {
  const size = UI_VIEWPORTS.find(({ name }) => name === viewport);
  const width = size === undefined ? "" : ` (${size.width}×${size.height})`;
  const error = isServerError(status) ? `. It ${serverErrorWords(String(status), "it shows")}` : "";
  return `- \`${REVIEWER_IMAGES_DIR}/${image}\`: ${routeWords(route, resolved, code)} at ${viewport} width${width}, ${SIDE_WORDS[side]}${signedInWords(identity, code)}${error}`;
}

/**
 * How the evidence section, the Evidence pages and the Reviewer's block name
 * the Capture identity a page was viewed as, each in its own markup: nothing
 * for a page viewed signed out.
 */
export function signedInWords(identity: CaptureIdentity | undefined, markup: (name: string) => string): string {
  return identity === undefined ? "" : `, signed in as ${markup(identity)}`;
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

/** Where a UI pull request's evidence is kept, and how its capture ended, as its marker records it. */
export interface EvidenceMarker {
  /** The Actions run whose Implement job captured it. */
  readonly run: number;
  /** The id of that run's artifact holding the screenshots and the capture result, or null when it kept none. */
  readonly artifact: number | null;
  /**
   * Why its capture failed, or null when it captured: what the Reviewer hears
   * when there's no capture result to read. Absent from a marker written before
   * markers recorded it.
   */
  readonly failure?: CaptureFailure | null;
  /**
   * The routes the section lists under "Captured routes", in its order: the
   * Ticket's, then the Implementer's, then the defaults, a route missed
   * outright among them; empty when capture had none. Absent from a marker
   * written before markers recorded them, or whose routes don't read.
   */
  readonly routes?: readonly string[];
  /**
   * What came of the preview deployment: `none` when Kit config declares no
   * `preview.url`; `pending` until the preview step has polled it, which then
   * records `linked` or `never-answered` with the address it polled. `linked`
   * says the branch's address answered within the poll, not that this head
   * is what answers. Absent from a marker written before markers recorded
   * it, or whose preview doesn't read.
   */
  readonly preview?: MarkerPreview;
  /**
   * Each route with a dynamic segment `ui.resolve_route` resolved (ADR-0024),
   * and the path it was captured at, in `routes`' order. Absent when none
   * was, and from a marker written before routes were resolved.
   */
  readonly resolved?: readonly MarkerResolvedRoute[];
  /**
   * Every shot capture meant to take and missed, going on to the rest (#667),
   * in the capture result's order, by route, viewport and side alone: why it
   * missed, the address tried and the browser's error stay in the artifact.
   * Empty when it missed none. Absent from a marker written before markers
   * recorded them, or whose missed shots don't read, and from one the push
   * job wrote with no capture result to read: what was missed is then unknown.
   */
  readonly missed?: readonly MarkerMissedShot[];
}

/** What came of a pull request's preview deployment, as its evidence marker records it. */
export type MarkerPreview =
  | { readonly is: "none" | "pending" }
  | { readonly is: "linked" | "never-answered"; readonly url: string };

/** A route resolved to a path, as its evidence marker records it. */
export interface MarkerResolvedRoute {
  readonly route: string;
  readonly path: string;
}

/** A shot capture missed, as its evidence marker records it: which route, at which viewport, of which side. */
export interface MarkerMissedShot {
  readonly route: string;
  readonly viewport: Viewport["name"];
  readonly side: CaptureSide;
}

/** A UI pull request's evidence, as the push job puts it together for the PR body. */
export interface UiEvidence extends Pick<EvidenceMarker, "run" | "artifact"> {
  /** What capture recorded. */
  readonly result: CaptureResult;
  /** The Evidence page's web address, or null when the run kept none. */
  readonly evidencePage: string | null;
  readonly preview: PreviewLink;
}

/** The hidden line the evidence section opens with, so it can be found and replaced whole. */
const SECTION_START = "<!-- fabrik:ui-evidence-start -->";

/**
 * The evidence section of a UI pull request's body, between a hidden start
 * line and the marker (evidenceMarkerIn): why capture failed, when it did;
 * the Evidence page link; the preview link, or why there is none; and each
 * captured route with why it was chosen, flagged when it answered a server
 * error, or naming what of it wasn't captured and why. A failed capture
 * keeps the screenshots it took first, so the section shows those too. Its
 * routes may be agent text, so each shows as code on one line and mentions nobody. It never shows a capture of a
 * Prototype's variant: a Ticket's UI evidence gets nothing from a Prototype.
 */
export function evidenceSection(evidence: UiEvidence): string {
  const { result, evidencePage, preview } = evidence;
  const captures = sideCaptures(result.captures);
  const missed = result.missed ?? [];
  // Each route once, in reason order as routes are chosen, though a route missed outright has no capture to come first by.
  const routes = onceEach([...captures, ...missed].map(({ route, reason }) => ({ route, reason }))).toSorted(
    (a, b) => ROUTE_REASONS.indexOf(a.reason) - ROUTE_REASONS.indexOf(b.reason),
  );
  return [
    SECTION_START,
    "## UI evidence",
    ...(result.outcome === "failed" ? ["", failureLine(result.reason, captures)] : []),
    ...(captures.length === 0 ? [] : ["", evidencePageLine(evidencePage, result.headSha, captures)]),
    "",
    previewLine(preview),
    ...(routes.length === 0 ? [] : ["", "Captured routes:", "", ...routes.map((chosen) => routeLine(chosen, captures, missed))]),
    evidenceMarker(evidence, routes.map(({ route }) => route)),
  ].join("\n");
}

/**
 * Why capture failed, in plain words, the one place each reason is worded:
 * `job` is the job that captured, whose log shows an error the Kit didn't
 * expect, the Implement job for a PR's evidence, the prototype job for a
 * prototype round (#155).
 */
export function failureWords(job: string): Readonly<Record<CaptureFailure, string>> {
  return {
    "build-failed": "`sandbox.build` failed, so there was no build to serve",
    "server-did-not-start": "the server wouldn't start: nothing answered at `ui.url` once `ui.serve` ran",
    timeout: "it ran out of time",
    "no-routes": "there was no route to capture: neither the Ticket nor the Implementer named one, and Kit config sets no `ui.default_routes`",
    "no-variants": "there was no variant to capture: the prototype turn's output named none",
    "sign-in-failed":
      "signing in failed: a `ui.sign_in` command failed, ran out of time or left no session it could read, or a signed-in page landed on `ui.sign_in_path`, which its log names",
    unreachable: "no page it went to would load, refused or not found",
    error: `it hit an error the Kit didn't expect, which ${job}'s log shows`,
    "no-result": `it left no result the push job could read: ${job}'s log shows why`,
  };
}

/** Why a PR's capture failed, in the Implement job. */
const FAILURE_WORDS = failureWords("the Implement job");

/**
 * Why a pull request's capture failed, as one sentence a reader shows as it
 * is (#667): the words the evidence section's failure line says it in, all
 * the Kit's own, so it holds nothing an agent wrote.
 */
export function captureFailureSentence(reason: CaptureFailure): string {
  return `Capture failed: ${FAILURE_WORDS[reason]}.`;
}

/** A failed capture's reason, and the screenshots it took first: a failed capture keeps them. */
function failureLine(reason: CaptureFailure, captures: readonly Capture[]): string {
  const took = captures.length === 0 ? "There are no screenshots." : `It took ${screenshots(captures.length)} first.`;
  return `**Capture failed:** ${FAILURE_WORDS[reason]}. ${took}`;
}

/** `1 screenshot`, or `n screenshots`. */
export function screenshots(count: number): string {
  return `${count} screenshot${count === 1 ? "" : "s"}`;
}

/**
 * A route capture went to, why it was chosen, what of it wasn't captured and
 * why, beside what was, and every screenshot of it that shows a server's
 * error page rather than the design.
 */
function routeLine({ route, reason }: ChosenRoute, captures: readonly Capture[], missed: readonly MissedShot[]): string {
  // Kit config's rules view a route as one identity, so its first capture names it for all.
  const identity = captures.find((capture) => capture.route === route)?.identity;
  const resolved = resolvedPathOf(route, [...captures, ...missed]);
  // Its route may be the Implementer's, and its path the Product's command's: text that never mentions anyone.
  const named = `- ${routeWords(route, resolved, (text) => code(withoutMentions(text)))}, ${ROUTE_REASON_WORDS[reason]}${signedInWords(identity, code)}`;
  const line = named + missedWords(captures.filter((capture) => capture.route === route), missed.filter((shot) => shot.route === route));
  const errors = captures.filter((capture) => capture.route === route && isServerError(capture.status));
  if (errors.length === 0) return line;
  const answered = errors.map(({ status, side, viewport }) => `${status} for ${SIDE_WORDS[side]} at ${viewport}`);
  const shows = errors.length === 1 ? "that screenshot shows" : "those screenshots show";
  return `${line}. **Server error:** it ${serverErrorWords(spelled(answered, "and"), shows)}.`;
}

/**
 * What of a route was captured and what wasn't, each side by its viewports,
 * with why it wasn't: nothing when none of it was missed.
 */
function missedWords(captures: readonly Capture[], missed: readonly MissedShot[]): string {
  if (missed.length === 0) return "";
  const took = CAPTURE_SIDES.toReversed().flatMap((side) => {
    const viewports = captures.filter((capture) => capture.side === side).map(({ viewport }) => viewport);
    return viewports.length === 0 ? [] : [`${SIDE_WORDS[side]} at ${spelled(viewports, "and")}`];
  });
  // Each side and why once, where it was first missed, with every viewport it was missed at.
  const words = missed.map((shot) => `${SIDE_WORDS[shot.side]}: ${missedWhyWords(shot)}`);
  const lost = words
    .filter((said, at) => words.indexOf(said) === at)
    .map((said) => `${said}, at ${spelled(missed.filter((_, at) => words[at] === said).map(({ viewport }) => viewport), "and")}`);
  return `. Captured: ${took.length === 0 ? "nothing" : took.join("; ")}. **Not captured:** ${lost.join("; ")}.`;
}

/** The path a route was resolved to, from these shots: a route is resolved once, so the first that names a path names it for all. */
function resolvedPathOf(route: string, shots: readonly (Capture | MissedShot)[]): string | undefined {
  return shots.find((shot) => shot.route === route && shot.resolved !== undefined)?.resolved;
}

/** Why a shot was missed, as the evidence section's route line says it. */
function missedWhyWords(shot: MissedShot): string {
  switch (shot.why) {
    case "unresolved-route":
      return `unresolved route, ${unresolvedWords(shot.error)}`;
    case "error-status":
      return `answered ${shot.status}`;
    default:
      return `unreachable, ${code(shot.error)}`;
  }
}

/** Whether a page answered with a server error, so its screenshot is of an error page. */
export function isServerError(status: number): boolean {
  return status >= 500 && status <= 599;
}

/**
 * What a screenshot of a page that answered a server error shows, in the
 * words the evidence section, the Evidence page and the Reviewer's block share:
 * the page `answered` its status, so what `shows` it is of an error page.
 */
export function serverErrorWords(answered: string, shows: string): string {
  return `answered ${answered}, so ${shows} an error page, not the design`;
}

/** How the evidence names each side. */
export const SIDE_WORDS: Readonly<Record<CaptureSide, string>> = { before: "Before", after: "After" };

function evidencePageLine(url: string | null, headSha: string, captures: readonly Capture[]): string {
  if (url === null) return `The Implement run kept no Evidence page of its ${screenshots(captures.length)}.`;
  const besideProduction = captures.some(({ side }) => side === "before") ? " beside the production site" : "";
  const viewports = UI_VIEWPORTS.map(({ name }) => name).filter((name) => captures.some(({ viewport }) => viewport === name));
  return `${link("Open the Evidence page", url)} of ${screenshots(captures.length)}: this branch at \`${headSha.slice(0, 7)}\`${besideProduction}, at ${spelled(viewports, "and")} ${viewports.length === 1 ? "width" : "widths"}.`;
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

/**
 * The marker line closing the evidence section, which records how its
 * capture ended, the routes the section lists, what came of the preview and
 * the shots capture missed. A route may be agent text, so the JSON can
 * neither end the comment early nor mention anyone.
 */
function evidenceMarker({ run, artifact, result, preview }: UiEvidence, routes: readonly string[]): string {
  const failure = result.outcome === "failed" ? result.reason : null;
  // With no capture result to read, the push job doesn't know what capture missed, so it records nothing rather than none.
  const missed = failure === "no-result" ? {} : { missed: (result.missed ?? []).map(({ route, viewport, side }) => ({ route, viewport, side })) };
  const shots = [...sideCaptures(result.captures), ...(result.missed ?? [])];
  const resolved = routes.flatMap((route) => {
    const path = resolvedPathOf(route, shots);
    return path === undefined ? [] : [{ route, path }];
  });
  return markerLine({ run, artifact, failure, routes, preview: markerPreview(preview), ...missed, ...(resolved.length === 0 ? {} : { resolved }) });
}

/** An evidence marker line holding this value, on one line. */
function markerLine(value: unknown): string {
  return `<!-- fabrik:ui-evidence ${markerJson(value)} -->`;
}

/** What the marker records of a preview link. */
function markerPreview(preview: PreviewLink): MarkerPreview {
  return preview.kind === "linked" || preview.kind === "never-answered" ? { is: preview.kind, url: preview.url } : { is: preview.kind };
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

/**
 * The routes a pull request's UI evidence captured, as its evidence marker
 * names them, in its order: the routes its section lists under "Captured
 * routes", one whose every shot was missed among them, as `routes` holds
 * them. None with no marker and with one whose capture kept no screenshots,
 * a pull request with no UI evidence; and none with a marker that names no
 * routes, as one written before markers recorded them.
 */
export function capturedRoutesOf(marker: EvidenceMarker | null): readonly string[] {
  return marker === null || marker.artifact === null ? [] : (marker.routes ?? []);
}

/** A name a pull request's shots marker holds: the Implementer's, with the path the artifact's entry gave once it has been read. */
export interface NamedShot {
  readonly name: string;
  readonly path?: string;
}

/** How many names the run that gave a pull request its names dropped: past the first four, and for breaking the name rule. */
export interface DroppedNames {
  readonly pastFour: number;
  readonly broken: number;
}

/** The failures of a whole collection of Evidence shots: the Product's wiring, the Operator's to fix, which never send back. */
export const SHOTS_FAILURES = ["no-artifact", "bad-manifest"] as const;

export type ShotsFailure = (typeof SHOTS_FAILURES)[number];

/**
 * What a pull request shows of its change by Evidence shots (#819): the
 * names, in the Implementer's order, or its sentence that nothing a person
 * sees changes, and what its run dropped of the names it gave.
 */
export interface ShotsNames {
  /** The names: none when it has the sentence, or neither. */
  readonly named: readonly NamedShot[];
  readonly nothingVisible?: string;
  /** Absent when the run that gave the names dropped none. */
  readonly dropped?: DroppedNames;
}

/**
 * The marker of a pull request whose UI evidence comes from Evidence shots:
 * the second shape of the evidence marker, told apart by its `source`. A
 * marker without one is a route marker (EvidenceMarker). It carries the
 * pull request's names between runs, and is read only from a body the
 * Fabrik App wrote (src/github/snapshot.ts).
 */
export interface ShotsMarker extends ShotsNames {
  readonly source: "shots";
  /** The head the named check ran at, whose shots the section shows; null while it waits. */
  readonly head: string | null;
  /** The Review run that holds the Evidence page; null while it waits. */
  readonly run: number | null;
  readonly artifact: number | null;
  readonly failure: ShotsFailure | null;
  /** Always empty, for a reader from a release before Evidence shots, which reads it as capturing no route. */
  readonly routes: readonly [];
  /** That the pull request has neither names nor the sentence: an Evidence miss (GLOSSARY.md). */
  readonly miss?: "nothing-named";
  /** Each named shot the check's run didn't produce, and each size a produced one lacks. */
  readonly missed: readonly ShotMiss[];
  readonly preview?: MarkerPreview;
  /** The Actions run whose Implement push job wrote the names, whose preview step links the preview (withPreviewLink). */
  readonly implementRun?: number;
}

/**
 * The names rule (#819): what a pull request shows of its change once an
 * Implementer run has given `given`, its marker holding `held` before it.
 * The latest run that says anything wins. Names it gives, held to the name
 * rule and once each, replace the pull request's, the first four counting;
 * its sentence, given without a name that counts, clears them and is kept;
 * and a run that gives neither keeps what the pull request had, without the
 * paths an earlier head's artifact gave. Names it gave that were dropped are
 * counted either way.
 */
export function shotsNamesOf(
  given: { readonly shots?: readonly string[]; readonly nothingVisible?: string },
  held: ShotsMarker | null,
): ShotsNames {
  if (given.shots !== undefined) {
    const kept = given.shots.filter(isShotName);
    const valid = kept.filter((name, at) => kept.indexOf(name) === at);
    const counted = valid.slice(0, NAMED_SHOT_CAP);
    const pastFour = valid.length - counted.length;
    const broken = given.shots.length - kept.length;
    const dropped = pastFour + broken === 0 ? {} : { dropped: { pastFour, broken } };
    if (counted.length > 0) return { named: counted.map((name) => ({ name })), ...dropped };
    // Every name it gave was dropped, so it named nothing that counts.
    const { dropped: _, ...rest } = shotsNamesOf({ ...(given.nothingVisible === undefined ? {} : { nothingVisible: given.nothingVisible }) }, held);
    return { ...rest, ...dropped };
  }
  if (given.nothingVisible !== undefined) return { named: [], nothingVisible: given.nothingVisible };
  if (held === null) return { named: [] };
  return {
    named: held.named.map(({ name }) => ({ name })),
    ...(held.nothingVisible === undefined ? {} : { nothingVisible: held.nothingVisible }),
    ...(held.dropped === undefined ? {} : { dropped: held.dropped }),
  };
}

/** Whether a pull request with these names shows nothing of its change: no name and no sentence, an Evidence miss's `nothing-named`. */
export function namesNothing({ named, nothingVisible }: ShotsNames): boolean {
  return named.length === 0 && nothingVisible === undefined;
}

/**
 * The shots marker an Implement run's push job writes: the pull request's
 * names, waiting for the named check, with no head, Review run or artifact
 * yet, and `miss` when it names nothing.
 */
export function waitingShotsMarker(names: ShotsNames, implementRun: number | null, preview: PreviewLink): ShotsMarker {
  return {
    source: "shots",
    head: null,
    run: null,
    artifact: null,
    failure: null,
    routes: [],
    named: names.named,
    ...(names.nothingVisible === undefined ? {} : { nothingVisible: names.nothingVisible }),
    ...(names.dropped === undefined ? {} : { dropped: names.dropped }),
    ...(namesNothing(names) ? { miss: "nothing-named" as const } : {}),
    missed: [],
    preview: markerPreview(preview),
    ...(implementRun === null ? {} : { implementRun }),
  };
}

/**
 * What came of a pull request's Evidence miss: the Kit sent it back with its
 * own Execution flaw, or it goes on to Review with the miss shown, because no
 * Retry is left or because no Implementer run pushed the head it is at, as
 * when a body-only Touch-up pushed nothing or the Operator pushed it.
 */
export type MissOutcome = "sent-back" | "no-retry-left" | "not-pushed";

/** What the shots section needs: the named check's name, the marker it ends with, and what came of the marker's `miss`. */
export interface ShotsSectionOf {
  readonly check: string;
  readonly marker: ShotsMarker;
  /** What came of the marker's `miss`; read only when it has one. */
  readonly missOutcome: MissOutcome;
}

/**
 * The evidence section of a pull request whose UI evidence comes from
 * Evidence shots, between the start line and its marker: an Evidence miss,
 * when it has one, and what came of it; that it waits for the named check;
 * the names, or the Implementer's sentence in its own words; the names its
 * run dropped; and the preview link. The sentence is agent text, so it shows
 * quoted on one line, mentions nobody and hides nothing.
 */
export function shotsSection({ check, marker, missOutcome }: ShotsSectionOf): string {
  const { named, nothingVisible, dropped, miss } = marker;
  return [
    SECTION_START,
    "## UI evidence",
    ...(miss === "nothing-named" ? ["", nothingNamedLine(missOutcome)] : []),
    "",
    `Waiting for the ${code(check)} check: the Evidence shots it takes at this head show here once it has finished and the Review has read them.`,
    ...(named.length === 0 ? [] : ["", "Named shots:", "", ...named.map(({ name }) => `- ${code(name)}`)]),
    ...(nothingVisible === undefined ? [] : ["", "The Implementer says nothing a person sees changes:", "", `> ${quotedSentence(nothingVisible)}`]),
    ...droppedLines(dropped).flatMap((line) => ["", line]),
    "",
    previewLine(previewLinkOf(marker.preview)),
    markerLine(marker),
  ].join("\n");
}

/** The section's line for a pull request that names nothing, sent back or going on to Review, and why. */
function nothingNamedLine(outcome: MissOutcome): string {
  const lead = "**Evidence miss:** the Implementer named no Evidence shot and didn't say that nothing visible changes";
  switch (outcome) {
    case "sent-back":
      return `${lead}, so the Kit sent it back with an Execution flaw, which uses a Retry.`;
    case "no-retry-left":
      return `${lead}. No Retry is left, so it goes on to Review showing nothing of the change.`;
    case "not-pushed":
      return `${lead}. No Implementer run pushed this head, so it isn't sent back: it goes on to Review showing nothing of the change.`;
  }
}

/** The lines saying what the run dropped of the names it gave: none when it dropped none. */
function droppedLines(dropped: DroppedNames | undefined): string[] {
  if (dropped === undefined) return [];
  const names = (count: number) => `${count} ${count === 1 ? "name" : "names"}`;
  const were = (count: number) => (count === 1 ? "was" : "were");
  return [
    ...(dropped.pastFour === 0 ? [] : [`${names(dropped.pastFour)} past the first four ${were(dropped.pastFour)} dropped: at most four count.`]),
    ...(dropped.broken === 0 ? [] : [`${names(dropped.broken)} ${were(dropped.broken)} dropped for breaking the name rule: ${SHOT_NAME_RULE}.`]),
  ];
}

/** Agent text shown on one line, mentioning nobody, with each `<` escaped so no HTML or comment in it hides anything. */
function quotedSentence(text: string): string {
  return withoutMentions(text.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim()).replaceAll("<", "&lt;");
}

/** A marker's preview as the section's preview line says it: none when the marker records none. */
function previewLinkOf(preview: MarkerPreview | undefined): PreviewLink {
  if (preview === undefined) return { kind: "none" };
  return preview.is === "linked" || preview.is === "never-answered" ? { kind: preview.is, url: preview.url } : { kind: preview.is };
}

/**
 * The shots marker in this body (ShotsMarker), or null when it has none. Read
 * only from a body the Fabrik App wrote (src/github/snapshot.ts). The last
 * counts, and a field that doesn't read is left out or read as none.
 */
export function shotsMarkerIn(body: string): ShotsMarker | null {
  const markers = body.split("\n").flatMap((line) => {
    const marker = shotsMarkerOf(EVIDENCE_MARKER.exec(line.trim())?.[1]);
    return marker === null ? [] : [marker];
  });
  return markers.at(-1) ?? null;
}

function shotsMarkerOf(json: string | undefined): ShotsMarker | null {
  if (json === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isObject(value) || value.source !== "shots") return null;
  const { head, run, artifact, failure, named, nothingVisible, dropped, miss, missed, preview, implementRun } = value;
  return {
    source: "shots",
    head: typeof head === "string" && FULL_SHA.test(head) ? head : null,
    run: isId(run) ? run : null,
    artifact: isId(artifact) ? artifact : null,
    failure: isOneOf(SHOTS_FAILURES, failure) ? failure : null,
    routes: [],
    // A name that breaks the rule, as an edit of the body might leave it, is dropped: names reach the Reviewer's prompt.
    named: Array.isArray(named) ? named.flatMap((shot) => (isObject(shot) && isShotName(shot.name) ? [namedShotOf(shot.name, shot.path)] : [])) : [],
    ...(typeof nothingVisible === "string" && nothingVisible.trim() !== "" ? { nothingVisible } : {}),
    ...(isObject(dropped) && isCount(dropped.pastFour) && isCount(dropped.broken) ? { dropped: { pastFour: dropped.pastFour, broken: dropped.broken } } : {}),
    ...(miss === "nothing-named" ? { miss } : {}),
    missed: Array.isArray(missed) ? missed.flatMap((each) => shotMissOf(each)) : [],
    ...(markerPreviewOf(preview) ?? {}),
    ...(isId(implementRun) ? { implementRun } : {}),
  };
}

function namedShotOf(name: string, path: unknown): NamedShot {
  return isRoute(path) ? { name, path } : { name };
}

/** A shots marker's missed shot, when it reads, as a list of none or one. */
function shotMissOf(value: unknown): ShotMiss[] {
  if (!isObject(value) || !isShotName(value.name)) return [];
  const { name, why, viewport } = value;
  if (why === "size-missing") return isOneOf(VIEWPORT_NAMES, viewport) ? [{ name, viewport, why }] : [];
  return why === "not-produced" || why === "ambiguous-name" || why === "refused" ? [{ name, why }] : [];
}

/** A count: a whole number, zero or more. */
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * The body with what came of its preview deployment, once the push job has
 * polled it (src/kit/previewLink.ts): the evidence section run `run` wrote
 * links the preview, or says it never answered, where it said the preview is
 * linked once it answers, and its marker records the same, with the address
 * polled. The rest of the body stays as it was, whatever the
 * Operator changed. Null when there is nothing to change: the body's marker,
 * the last, isn't that run's, as when a later run has replaced the section,
 * or its section no longer waits on the preview.
 */
export function withPreviewLink(body: string, run: number, preview: PreviewLink): string | null {
  const lines = body.split("\n");
  // A shots section's marker names the Implement run that wrote it apart from the Review run whose Evidence page it links.
  const markers = lines.map((line) => {
    const json = EVIDENCE_MARKER.exec(line.trim())?.[1];
    const marker = markerOf(json) ?? shotsMarkerOf(json);
    return marker === null ? null : "source" in marker ? (marker.implementRun ?? null) : marker.run;
  });
  const markerAt = markers.findLastIndex((marker) => marker !== null);
  if (markerAt === -1 || markers[markerAt] !== run) return null;
  const startAt = lines.findLastIndex((line, at) => at < markerAt && SECTION_START_LINE.test(line.trim()));
  const waiting = previewLine({ kind: "pending" });
  const at = lines.findIndex((line, i) => startAt !== -1 && i > startAt && i < markerAt && line.trim() === waiting);
  if (at === -1) return null;
  // A body the Operator edited on GitHub may end its lines in \r\n.
  const ending = (line: string) => (line.endsWith("\r") ? "\r" : "");
  lines[at] = `${previewLine(preview)}${ending(lines[at]!)}`;
  // The marker records it in the same edit, keeping all else it holds as it was.
  const marker = lines[markerAt]!;
  const held = JSON.parse(EVIDENCE_MARKER.exec(marker.trim())![1]!) as Record<string, unknown>;
  lines[markerAt] = `${markerLine({ ...held, preview: markerPreview(preview) })}${ending(marker)}`;
  return lines.join("\n");
}

function markerOf(json: string | undefined): EvidenceMarker | null {
  if (json === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  // A marker with a source is another shape of it (a shots marker), never a route marker.
  if (!isObject(value) || value.source !== undefined) return null;
  const { run, artifact, failure, routes, preview, missed, resolved } = value;
  if (!isId(run) || !(artifact === null || isId(artifact))) return null;
  // A field it doesn't record, or that doesn't read, leaves where the evidence is kept, and the other fields, as they were.
  return {
    run,
    artifact,
    ...(failure === null || isOneOf(CAPTURE_FAILURES, failure) ? { failure } : {}),
    ...(Array.isArray(routes) && routes.every((route) => typeof route === "string") ? { routes } : {}),
    ...(markerPreviewOf(preview) ?? {}),
    ...(Array.isArray(missed) && missed.every(isMarkerMissedShot) ? { missed: missed.map(({ route, viewport, side }) => ({ route, viewport, side })) } : {}),
    ...(Array.isArray(resolved) && resolved.every(isMarkerResolvedRoute) ? { resolved: resolved.map(({ route, path }) => ({ route, path })) } : {}),
  };
}

/** Whether a marker's resolved route reads: its route and path, each as text. */
function isMarkerResolvedRoute(value: unknown): value is MarkerResolvedRoute {
  return isObject(value) && typeof value.route === "string" && typeof value.path === "string";
}

/** Whether a marker's missed shot reads: a route as text, a viewport the Kit captures at and a side. */
function isMarkerMissedShot(value: unknown): value is MarkerMissedShot {
  return isObject(value) && typeof value.route === "string" && isOneOf(VIEWPORT_NAMES, value.viewport) && isOneOf(CAPTURE_SIDES, value.side);
}

/** A marker's preview, when it reads: one of its four outcomes, with the address it polled exactly when it was polled. */
function markerPreviewOf(value: unknown): { preview: MarkerPreview } | null {
  if (!isObject(value)) return null;
  const { is, url } = value;
  if ((is === "none" || is === "pending") && url === undefined) return { preview: { is } };
  if ((is === "linked" || is === "never-answered") && typeof url === "string") return { preview: { is, url } };
  return null;
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
/**
 * A route's page on the site served at `base`, as capture takes it: the
 * route after the base, without the base's trailing slash.
 */
export function pageAt(base: string, route: string): string {
  return `${base.replace(/\/+$/, "")}${route}`;
}

/**
 * A Prototype's variant (#155) on its route's page: the page with `variant`
 * set to the variant's letter in its query, keeping whatever else the query
 * holds, as capture takes it and a prototype round links its preview.
 */
export function variantPage(page: string, letter: string): string {
  const url = new URL(page);
  url.searchParams.set("variant", letter);
  return url.href;
}

/** The URL text with each `(` and `)` percent-encoded, which a URL leaves as they are, but which could end a Markdown link. */
export function withParensEscaped(url: string): string {
  return url.replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function code(text: string): string {
  const oneLine = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "\uFFFD");
  const longest = Math.max(0, ...[...oneLine.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = "`".repeat(longest + 1);
  // CommonMark drops one space each side, so a backtick at either end stays in the span.
  const pad = oneLine.startsWith("`") || oneLine.endsWith("`") ? " " : "";
  return `${fence}${pad}${oneLine}${pad}${fence}`;
}
