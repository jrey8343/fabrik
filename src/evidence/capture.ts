// Capturing UI evidence (#153) in the Implement job, after the Implementer's
// agent has ended, and a prototype turn's variants (#155) in the prototype
// job, after its agent has ended: every decision the capture step makes,
// behind the Capturer, which does what capture does to the runner. The
// Playwright shell (src/evidence/capture-main.ts) is the real Capturer, and
// tests fake it. Pure, no I/O.
import { slug, UI_VIEWPORTS, type UiConfig, type Viewport } from "../kit/config.ts";
import type { PrototypeVariant } from "../loop/designOutput.ts";
import { parseImplementOutput } from "../loop/implementOutput.ts";
import { gallery, type GalleryShot, prototypeGallery, type VariantShot } from "./gallery.ts";
import {
  type Capture,
  type CaptureFailure,
  type CaptureResult,
  type CaptureSide,
  type ChosenRoute,
  isUi,
  pageAt,
  routesFor,
  screenshots,
  type VariantCapture,
  variantPage,
} from "./uiEvidence.ts";

/**
 * Where the capture step writes, in the agent's output directory: this
 * folder holds the screenshots and the capture result, kept zipped for the
 * Reviewer, and the gallery sits beside it, kept unzipped (loop.yml). Not
 * `fabrik-agent-*`, which the push job downloads.
 */
export const EVIDENCE_DIR = "ui-evidence";

/** The capture result's file, in EVIDENCE_DIR beside the screenshots. */
export const CAPTURE_RESULT_FILE = "capture-result.json";

/** The gallery's file, beside EVIDENCE_DIR; its unzipped artifact is named after it. */
export const GALLERY_FILE = "fabrik-ui-gallery.html";

/**
 * A prototype turn's gallery's file, beside EVIDENCE_DIR in the prototype
 * job's output directory; its unzipped artifact is named after it.
 */
export const PROTOTYPE_GALLERY_FILE = "fabrik-prototype-gallery.html";

/** What capture is given: Kit config's blocks, the branch the Implementer left, and what names routes. */
export interface CaptureInput {
  /** Kit config's ui block; null turns Visual evidence off. */
  readonly ui: UiConfig | null;
  /** Kit config's `sandbox.build`, which capture runs before serving; null builds nothing. */
  readonly build: string | null;
  /** The commit the Implementer left its branch at, or null when it made none. */
  readonly headSha: string | null;
  readonly ticketBody: string;
  /** The routes the Implementer's output named. */
  readonly implementerRoutes: readonly string[];
}

/** One screenshot capture means to take: of which route and why, at which viewport and URL, of which side, saved as which file. */
export interface Shot extends ChosenRoute {
  readonly viewport: Viewport;
  readonly side: CaptureSide;
  readonly url: string;
  /** A plain file name, unique to this shot. */
  readonly image: string;
}

/**
 * One take capture means to record of a Prototype's variant: its route with
 * `?variant=` and its letter, at one viewport, screenshotted then filmed
 * loading and scrolling, saved as which files.
 */
export interface VariantTake {
  readonly route: string;
  /** One of VARIANT_LETTERS. */
  readonly variant: string;
  readonly viewport: Viewport;
  readonly url: string;
  /** Plain file names, unique to this take. */
  readonly image: string;
  readonly video: string;
}

/** How a command capture runs to its end ended: it finished, it failed, or it ran past the time it was given. */
export type Finished = "ok" | "failed" | "timed-out";

/** What capture does to the runner: the Playwright shell for real, a fake in tests. */
export interface Capturer {
  /** Every path the branch at this commit changes against the default branch. */
  changedPaths(headSha: string): Promise<readonly string[]>;
  /** Installs the headless browser capture drives. */
  installBrowser(timeoutMs: number): Promise<Finished>;
  /** Runs `sandbox.build` to its end. */
  build(command: string, timeoutMs: number): Promise<Finished>;
  /** Stops whatever already answers on the URL's port, such as a server the agent left; true once nothing does. */
  freePort(url: string): Promise<boolean>;
  /** Starts `ui.serve` in the background and waits for the URL to answer, or the server to exit. */
  serve(command: string, url: string, timeoutMs: number): Promise<"answered" | "exited" | "timed-out">;
  /** Loads the shot's URL at its viewport and saves its screenshot: the HTTP status the page answered. */
  screenshot(shot: Shot, timeoutMs: number): Promise<number | "timed-out">;
  /**
   * Loads the take's URL at its viewport, saves its screenshot, then scrolls
   * the page down while it records it: the HTTP status the page answered,
   * and whether its video was saved, which a take can go without.
   */
  recordVariant(take: VariantTake, timeoutMs: number): Promise<{ readonly status: number; readonly video: boolean } | "timed-out">;
  /** Stops everything capture started. */
  stop(): Promise<void>;
  /** Milliseconds, from any fixed point. */
  now(): number;
  /** A line for the job's log. */
  log(line: string): void;
}

/**
 * What capture came to: off without a ui block, skipped when there's nothing
 * to capture, or the capture result it recorded, of a pull request's sides
 * or of a Prototype's variants.
 */
export type CaptureOutcome<C extends Capture | VariantCapture = Capture> =
  | { readonly kind: "off" }
  | { readonly kind: "skipped"; readonly why: string }
  | { readonly kind: "recorded"; readonly result: CaptureResult<C> };

/**
 * The capture step's own timeout-minutes in loop.yml: a Kit constant, so a
 * slow build or server can never hold the Implement job past its budget.
 */
export const CAPTURE_TIMEOUT_MINUTES = 20;

/** Room in the Implement job beyond its agent's and capture's timeouts, for its other steps. */
const JOB_STEPS_MINUTES = 10;

/**
 * The Implement job's timeout-minutes, which the Kit job passes out: the
 * agent step stops at the role's own timeout, so this is long enough for
 * capture after it too, and a slow capture never cancels the job before
 * its result uploads.
 */
export function implementJobTimeoutMinutes(implementTimeoutMinutes: number): number {
  return implementTimeoutMinutes + CAPTURE_TIMEOUT_MINUTES + JOB_STEPS_MINUTES;
}

/** How long capture gives itself, inside its step's timeout, so it's always left time to write what it took. */
const CAPTURE_BUDGET_MS = (CAPTURE_TIMEOUT_MINUTES - 2) * 60_000;

/** How long `ui.url` gets to answer once `ui.serve` has started. */
const SERVER_START_MS = 3 * 60_000;

/** How long each page gets to load. */
const PAGE_LOAD_MS = 60_000;

/** How long each take of a Prototype's variant gets: its page's minute to load, then its screenshot and its short scroll. */
const VARIANT_TAKE_MS = 90_000;

/** Captures the branch's UI evidence, catching every failure into the capture result it records. */
export async function captureEvidence(input: CaptureInput, capturer: Capturer): Promise<CaptureOutcome> {
  const { ui, headSha } = input;
  if (ui === null) return { kind: "off" };
  if (headSha === null) return { kind: "skipped", why: "the Implementer made no commit" };
  let changed: readonly string[];
  try {
    changed = await capturer.changedPaths(headSha);
  } catch (error) {
    capturer.log(`Capture couldn't tell what the branch changes: ${messageOf(error)}`);
    return recorded({ outcome: "failed", reason: "error", headSha, captures: [] });
  }
  if (!isUi(changed, ui)) return { kind: "skipped", why: "the branch changes no file that ui.paths marks as UI" };
  const routes = routesFor(input.ticketBody, input.implementerRoutes, ui.defaultRoutes);
  if (routes.length === 0) return recorded({ outcome: "failed", reason: "no-routes", headSha, captures: [] });
  const captures: Capture[] = [];
  const failure = await caught(capturer, () => takeShots(input.build, ui, routes, capturer, captures));
  return recorded(failure === null ? { outcome: "captured", headSha, captures } : { outcome: "failed", reason: failure, headSha, captures });
}

/** What a prototype turn's capture is given: Kit config's blocks, the branch the turn left, the approved route, and the variants it built. */
export interface PrototypeCaptureInput {
  /** Kit config's ui block; null leaves nothing to serve or capture. */
  readonly ui: UiConfig | null;
  /** Kit config's `sandbox.build`, which capture runs before serving; null builds nothing. */
  readonly build: string | null;
  /** The commit the turn left the issue's prototype branch at, or null when it made none. */
  readonly headSha: string | null;
  /** The one route the Operator approved the Prototype of. */
  readonly route: string;
  /** The letters of the variants the turn's output named, in order: none when it named none. */
  readonly variants: readonly string[];
}

/**
 * Captures a prototype turn's variants: every variant's route with
 * `?variant=` and its letter, screenshotted and filmed at each Kit viewport,
 * catching every failure into the capture result it records. A turn that
 * made no commit leaves nothing to capture.
 */
export async function capturePrototype(input: PrototypeCaptureInput, capturer: Capturer): Promise<CaptureOutcome<VariantCapture>> {
  const { ui, headSha } = input;
  if (ui === null) return { kind: "off" };
  if (headSha === null) return { kind: "skipped", why: "the prototype turn made no commit" };
  if (input.variants.length === 0) return { kind: "recorded", result: { outcome: "failed", reason: "no-variants", headSha, captures: [] } };
  const captures: VariantCapture[] = [];
  const failure = await caught(capturer, () => takeVariants(input.build, ui, input.route, input.variants, capturer, captures));
  return {
    kind: "recorded",
    result: failure === null ? { outcome: "captured", headSha, captures } : { outcome: "failed", reason: failure, headSha, captures },
  };
}

/** Runs a capture, catching any error it throws as `error`, then stops all it started: why it stopped, or null once it took everything. */
async function caught(capturer: Capturer, take: () => Promise<CaptureFailure | null>): Promise<CaptureFailure | null> {
  try {
    return await take();
  } catch (error) {
    capturer.log(`Capture failed: ${messageOf(error)}`);
    return "error";
  } finally {
    // Stopping is tidying up: it never costs what capture took.
    await capturer.stop().catch((error: unknown) => capturer.log(`Capture couldn't stop all it started: ${messageOf(error)}`));
  }
}

/** The time capture has left in its budget, from when it starts. */
function budget(capturer: Capturer): () => number {
  const end = capturer.now() + CAPTURE_BUDGET_MS;
  return () => end - capturer.now();
}

/**
 * Builds and serves the branch, then takes every shot into `captures`, all
 * within capture's budget: null once all are taken, else why capture stopped.
 */
async function takeShots(
  build: string | null,
  ui: UiConfig,
  routes: readonly ChosenRoute[],
  capturer: Capturer,
  captures: Capture[],
): Promise<CaptureFailure | null> {
  const left = budget(capturer);
  const serving = await serveBranch(build, ui, capturer, left);
  if (serving !== null) return serving;
  for (const shot of shotsFor(routes, ui)) {
    if (left() <= 0) return stopped(capturer, "timeout", `before ${shot.url} at ${shot.viewport.name}`);
    const status = await capturer.screenshot(shot, Math.min(PAGE_LOAD_MS, left()));
    if (status === "timed-out") return stopped(capturer, "timeout", `loading ${shot.url} at ${shot.viewport.name}`);
    const { route, reason, viewport, side, image } = shot;
    captures.push({ route, reason, viewport: viewport.name, side, status, image });
  }
  return null;
}

/**
 * Builds and serves the prototype branch, then records every take of its
 * variants into `captures`, all within capture's budget: null once all are
 * taken, else why capture stopped.
 */
async function takeVariants(
  build: string | null,
  ui: UiConfig,
  route: string,
  variants: readonly string[],
  capturer: Capturer,
  captures: VariantCapture[],
): Promise<CaptureFailure | null> {
  const left = budget(capturer);
  const serving = await serveBranch(build, ui, capturer, left);
  if (serving !== null) return serving;
  for (const take of takesFor(route, variants, ui)) {
    if (left() <= 0) return stopped(capturer, "timeout", `before ${take.url} at ${take.viewport.name}`);
    const taken = await capturer.recordVariant(take, Math.min(VARIANT_TAKE_MS, left()));
    if (taken === "timed-out") return stopped(capturer, "timeout", `loading ${take.url} at ${take.viewport.name}`);
    const { variant, viewport, image, video } = take;
    captures.push({ route, variant, viewport: viewport.name, status: taken.status, image, ...(taken.video ? { video } : {}) });
  }
  return null;
}

/**
 * Installs the browser, builds the branch and starts its server at `ui.url`,
 * within what's `left` of capture's budget: null once it answers, else why
 * capture stopped.
 */
async function serveBranch(build: string | null, ui: UiConfig, capturer: Capturer, left: () => number): Promise<CaptureFailure | null> {
  const installed = await capturer.installBrowser(left());
  if (installed !== "ok") return stopped(capturer, installed === "timed-out" ? "timeout" : "error", "installing the headless browser");
  const built = build === null ? "ok" : await capturer.build(build, left());
  if (built !== "ok") return stopped(capturer, built === "timed-out" ? "timeout" : "build-failed", "running `sandbox.build`");
  if (!(await capturer.freePort(ui.url))) {
    return stopped(capturer, "error", `freeing ${ui.url}, where something still answers, so it would be captured in the branch's place`);
  }
  const serverMs = Math.min(SERVER_START_MS, left());
  const served = await capturer.serve(ui.serve, ui.url, serverMs);
  // A server cut short by capture's own budget may yet have started: that's capture running out of time.
  if (served === "timed-out" && serverMs < SERVER_START_MS) return stopped(capturer, "timeout", `waiting for ${ui.url} to answer`);
  if (served !== "answered") return stopped(capturer, "server-did-not-start", `waiting for ${ui.url} to answer once \`ui.serve\` ran (it ${served})`);
  return null;
}

/** Logs where capture stopped and why, then gives the reason. */
function stopped(capturer: Capturer, reason: CaptureFailure, where: string): CaptureFailure {
  capturer.log(`Capture stopped (${reason}) ${where}.`);
  return reason;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recorded(result: CaptureResult<Capture>): CaptureOutcome {
  return { kind: "recorded", result };
}

/**
 * Every take of a Prototype's variants, served from the branch at `ui.url`:
 * each variant in letter order, at mobile then desktop.
 */
function takesFor(route: string, variants: readonly string[], ui: UiConfig): VariantTake[] {
  const page = pageAt(ui.url, route);
  return variants.flatMap((variant) =>
    UI_VIEWPORTS.map((viewport) => {
      const name = `variant-${variant.toLowerCase()}-${viewport.name}`;
      return { route, variant, viewport, url: variantPage(page, variant), image: `${name}.png`, video: `${name}.webm` };
    }),
  );
}

/**
 * Every shot of these routes: After, from the branch served at `ui.url`,
 * then Before, from `ui.before_url` when there is one; each route in the
 * order chosen, at mobile then desktop.
 */
function shotsFor(routes: readonly ChosenRoute[], ui: UiConfig): Shot[] {
  const sides: [CaptureSide, string][] = [["after", ui.url]];
  if (ui.beforeUrl !== null) sides.push(["before", ui.beforeUrl]);
  return sides.flatMap(([side, base]) =>
    routes.flatMap(({ route, reason }, at) =>
      UI_VIEWPORTS.map((viewport) => ({
        route,
        reason,
        viewport,
        side,
        url: pageAt(base, route),
        image: `${side}-${viewport.name}-${at + 1}-${routeSlug(route)}.png`,
      })),
    ),
  );
}

/** The most of a route a file name keeps; its place in the list keeps the name unique. */
const SLUG_LENGTH = 40;

/** A route as a file name's part: its letters and digits, lowercased, with a dash for each run of anything else, `root` for `/`. */
function routeSlug(route: string): string {
  return slug(route).slice(0, SLUG_LENGTH).replace(/-+$/, "") || "root";
}

/** The step output the push job reads the capture result from: one compact JSON line, empty when nothing was captured. */
export function captureStepOutputs(outcome: CaptureOutcome<Capture | VariantCapture>): Readonly<Record<"ui-capture-result", string>> {
  return { "ui-capture-result": outcome.kind === "recorded" ? JSON.stringify(outcome.result) : "" };
}

/** What capture writes beside its screenshots: the capture result, and the gallery when it took any. */
export interface CaptureStepFiles {
  readonly result: string;
  /** The gallery page, or null when capture took no screenshot. */
  readonly gallery: string | null;
}

/** The capture result's file text, and the gallery of every screenshot with its PNG's bytes in `images`, by file name. */
export function captureStepFiles(result: CaptureResult<Capture>, images: ReadonlyMap<string, Uint8Array>, ticket: number): CaptureStepFiles {
  const shots = result.captures.flatMap((capture): GalleryShot[] => {
    const png = images.get(capture.image);
    return png === undefined ? [] : [{ ...capture, png }];
  });
  return {
    result: `${JSON.stringify(result, null, 2)}\n`,
    gallery: shots.length === 0 ? null : gallery(shots, { ticket, headSha: result.headSha }),
  };
}

/**
 * The capture result's file text, and the prototype gallery of every variant
 * under its letter and summary, with each screenshot and video capture took,
 * their bytes in `files` by file name; no gallery when it took no screenshot.
 */
export function prototypeCaptureFiles(
  result: CaptureResult<VariantCapture>,
  files: ReadonlyMap<string, Uint8Array>,
  variants: readonly Pick<PrototypeVariant, "letter" | "summary">[],
  meta: { readonly issue: number; readonly route: string },
): CaptureStepFiles {
  const shots = result.captures.flatMap((capture): VariantShot[] => {
    const png = files.get(capture.image);
    if (png === undefined) return [];
    const webm = capture.video === undefined ? undefined : files.get(capture.video);
    return [{ ...capture, png, ...(webm === undefined ? {} : { webm }) }];
  });
  return {
    result: `${JSON.stringify(result, null, 2)}\n`,
    gallery: shots.length === 0 ? null : prototypeGallery(shots, variants, { ...meta, headSha: result.headSha }),
  };
}

/** A prototype turn's capture step's summary, or null without a ui block. */
export function prototypeCaptureSummary(outcome: CaptureOutcome<VariantCapture>): string | null {
  const heading = "### Prototype capture";
  switch (outcome.kind) {
    case "off":
      return null;
    case "skipped":
      return `${heading}\n\nNothing was captured: ${outcome.why}.\n`;
    case "recorded": {
      const { result } = outcome;
      const shots = screenshots(result.captures.length);
      if (result.outcome === "failed") return `${heading}\n\nCapture failed (\`${result.reason}\`) after ${shots}; its log says where it stopped.\n`;
      const variants = new Set(result.captures.map(({ variant }) => variant)).size;
      const videos = result.captures.filter(({ video }) => video !== undefined).length;
      return `${heading}\n\nCaptured ${variants} variant${variants === 1 ? "" : "s"} at \`${result.headSha.slice(0, 7)}\`: ${shots} and ${videos} video${videos === 1 ? "" : "s"}.\n`;
    }
  }
}

/** The capture step's summary, or null when Visual evidence is off, which the Kit job's summary says. */
export function captureStepSummary(outcome: CaptureOutcome): string | null {
  switch (outcome.kind) {
    case "off":
      return null;
    case "skipped":
      return summary(`Nothing was captured: ${outcome.why}.`);
    case "recorded": {
      const { result } = outcome;
      const shots = screenshots(result.captures.length);
      if (result.outcome === "failed") return summary(`Capture failed (\`${result.reason}\`) after ${shots}; its log says where it stopped.`);
      const routes = new Set(result.captures.map(({ route }) => route)).size;
      return summary(`Captured ${shots} of ${routes} route${routes === 1 ? "" : "s"} at \`${result.headSha.slice(0, 7)}\`.`);
    }
  }
}

function summary(line: string): string {
  return `### UI evidence\n\n${line}\n`;
}

/** What build and serve never get: the 1Password step's outputs, the Claude token, and any GitHub or Actions token. */
const WITHHELD = /^(?:FABRIK_SECRETS|CLAUDE_CODE_OAUTH_TOKEN|GH_TOKEN|GITHUB_TOKEN|ACTIONS_\w*TOKEN\w*)$/;

/**
 * The env `sandbox.build` and `ui.serve` run with: the runner's, with Kit
 * config's `sandbox.env` over it, less anything WITHHELD, which no Product
 * code capture runs may hold.
 */
export function buildAndServeEnv(
  runnerEnv: Readonly<Record<string, string | undefined>>,
  sandboxEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...runnerEnv, ...sandboxEnv }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !WITHHELD.test(entry[0]),
    ),
  );
}

/** The routes the Implementer's output names, as its agent result carries it: none when it names none, or doesn't read. */
export function implementerRoutesIn(output: string): readonly string[] {
  const read = parseImplementOutput(output);
  return read.ok ? (read.output.routes ?? []) : [];
}

/** The host and port a URL is served on, its scheme's default when it names none. */
export function servedAt(url: string): { readonly host: string; readonly port: number } {
  const { hostname, port, protocol } = new URL(url);
  return { host: hostname.replace(/^\[|\]$/g, ""), port: port === "" ? (protocol === "https:" ? 443 : 80) : Number(port) };
}

