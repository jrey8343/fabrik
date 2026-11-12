// Capturing UI evidence (#153) in the Implement job, after the Implementer's
// agent has ended, and a prototype turn's variants (#155) in the prototype
// job, after its agent has ended: every decision the capture step makes,
// behind the Capturer, which does what capture does to the runner. The
// Playwright shell (src/evidence/playwrightCapturer.ts, which
// src/evidence/capture-main.ts runs) is the real Capturer, and tests fake it. Pure, no I/O.
import { type CaptureIdentity, captureIdentityOf, slug, UI_VIEWPORTS, type UiConfig, type Viewport } from "../kit/config.ts";
import type { PrototypeVariant } from "../loop/designOutput.ts";
import { parseImplementOutput } from "../loop/implementOutput.ts";
import { CAPTURE_TIMEOUT_MINUTES } from "./captureTimeout.ts";
import { evidencePage, type EvidencePageShot, prototypeEvidencePage, type VariantShot } from "./evidencePage.ts";
import {
  type Capture,
  type CaptureFailure,
  type CaptureResult,
  type CaptureSide,
  type ChosenRoute,
  isUi,
  type MissedShot,
  pageAt,
  routesFor,
  screenshots,
  type VariantCapture,
  variantPage,
} from "./uiEvidence.ts";

export { CAPTURE_TIMEOUT_MINUTES, implementJobTimeoutMinutes } from "./captureTimeout.ts";

/**
 * Where the capture step writes, in the agent's output directory: this
 * folder holds the screenshots and the capture result, kept zipped for the
 * Reviewer, and the Evidence page sits beside it, kept unzipped (loop.yml). Not
 * `fabrik-agent-*`, which the push job downloads.
 */
export const EVIDENCE_DIR = "ui-evidence";

/** The Evidence page's file, beside EVIDENCE_DIR; its unzipped artifact is named after it. */
export const EVIDENCE_PAGE_FILE = "fabrik-ui-evidence-page.html";

/**
 * A prototype turn's Evidence page's file, beside EVIDENCE_DIR in the prototype
 * job's output directory; its unzipped artifact is named after it.
 */
export const PROTOTYPE_EVIDENCE_PAGE_FILE = "fabrik-prototype-evidence-page.html";

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
  /** Who the page is viewed as, when it's viewed signed in; absent, it's viewed signed out. */
  readonly signedIn?: SignedInAs;
}

/**
 * A shot or take viewed signed in (ADR-0012): as which Capture identity,
 * whose storage state its browser loads, and the route that, landed on,
 * says the session didn't take.
 */
export interface SignedInAs {
  readonly identity: CaptureIdentity;
  /** `ui.sign_in_path`. */
  readonly signInPath: string;
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
  /** Who the page is viewed as, when it's viewed signed in; absent, it's viewed signed out. */
  readonly signedIn?: SignedInAs;
}

/**
 * How a Capture identity's sign-in ended: it left a storage state capture
 * can load, its command failed or ran past its time, or it left no file, or
 * one that doesn't read as a storage state (isStorageState).
 */
export type SignInEnd = "signed-in" | "failed" | "timed-out" | "no-state" | "bad-state";

/** What a signed-in shot or take reports when its page landed on `ui.sign_in_path`, its image thrown away. */
export const ON_SIGN_IN = "on-sign-in";

/** What a shot reports when its page wouldn't load, refused or not found: the browser's error code, such as ERR_CONNECTION_REFUSED. */
export interface PageUnreachable {
  readonly unreachable: string;
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
  /**
   * Runs a Capture identity's `ui.sign_in` command in the Product directory,
   * with the env `ui.serve` gets and `FABRIK_STORAGE_STATE`, a path outside
   * the evidence folder to write a storage state to, which every later shot
   * and take signed in as it loads.
   */
  signIn(identity: CaptureIdentity, command: string, timeoutMs: number): Promise<SignInEnd>;
  /**
   * Loads the shot's URL at its viewport, signed in when it says so, and
   * saves its screenshot: the HTTP status the page answered; for a
   * signed-in shot whose page landed on its sign-in path, ON_SIGN_IN, saving
   * none; or, when the page wouldn't load at all, PageUnreachable, saving none.
   */
  screenshot(shot: Shot, timeoutMs: number): Promise<number | "timed-out" | typeof ON_SIGN_IN | PageUnreachable>;
  /**
   * Loads the take's URL at its viewport, signed in when it says so, saves
   * its screenshot, then scrolls the page down while it records it: the HTTP
   * status the page answered, and whether its video was saved, which a take
   * can go without; or, landing on its sign-in path, ON_SIGN_IN, as a shot does.
   */
  recordVariant(take: VariantTake, timeoutMs: number): Promise<{ readonly status: number; readonly video: boolean } | "timed-out" | typeof ON_SIGN_IN>;
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

/** How long capture gives itself, inside its step's timeout, so it's always left time to write what it took. */
const CAPTURE_BUDGET_MS = (CAPTURE_TIMEOUT_MINUTES - 2) * 60_000;

/** How long `ui.url` gets to answer once `ui.serve` has started. */
const SERVER_START_MS = 3 * 60_000;

/** How long each Capture identity's sign-in command gets to run. */
const SIGN_IN_MS = 3 * 60_000;

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
  const missed: MissedShot[] = [];
  const stoppedFor = await caught(capturer, () => takeShots(input.build, ui, routes, capturer, captures, missed));
  // Every shot missed, with nothing stopping capture: no page it went to would load.
  const failure = stoppedFor ?? (captures.length === 0 ? "unreachable" : null);
  const named = missed.length === 0 ? {} : { missed };
  return recorded(failure === null ? { outcome: "captured", headSha, captures, ...named } : { outcome: "failed", reason: failure, headSha, captures, ...named });
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
 * within capture's budget, noting in `missed` each whose page wouldn't load
 * and going on to the rest: null once all are tried, else why capture stopped.
 */
async function takeShots(
  build: string | null,
  ui: UiConfig,
  routes: readonly ChosenRoute[],
  capturer: Capturer,
  captures: Capture[],
  missed: MissedShot[],
): Promise<CaptureFailure | null> {
  const left = budget(capturer);
  const shots = shotsFor(routes, ui);
  const serving = await serveBranch(build, ui, capturer, left, shots);
  if (serving !== null) return serving;
  for (const shot of shots) {
    if (left() <= 0) return stopped(capturer, "timeout", `before ${shot.url} at ${shot.viewport.name}`);
    const status = await capturer.screenshot(shot, Math.min(PAGE_LOAD_MS, left()));
    if (status === "timed-out") return stopped(capturer, "timeout", `loading ${shot.url} at ${shot.viewport.name}`);
    if (status === ON_SIGN_IN) return signedOut(capturer, shot);
    const { route, reason, viewport, side, image, url } = shot;
    if (typeof status === "object") {
      const why = `${side}-unreachable` as const;
      capturer.log(`Capture missed (${why}) ${url} at ${viewport.name}: ${status.unreachable}. It goes on to the rest.`);
      missed.push({ route, reason, viewport: viewport.name, side, url, why, error: status.unreachable });
      continue;
    }
    captures.push({ route, reason, viewport: viewport.name, side, status, image, ...identityOf(shot) });
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
  const takes = takesFor(route, variants, ui);
  const serving = await serveBranch(build, ui, capturer, left, takes);
  if (serving !== null) return serving;
  for (const take of takes) {
    if (left() <= 0) return stopped(capturer, "timeout", `before ${take.url} at ${take.viewport.name}`);
    const taken = await capturer.recordVariant(take, Math.min(VARIANT_TAKE_MS, left()));
    if (taken === "timed-out") return stopped(capturer, "timeout", `loading ${take.url} at ${take.viewport.name}`);
    if (taken === ON_SIGN_IN) return signedOut(capturer, take);
    const { variant, viewport, image, video } = take;
    captures.push({ route, variant, viewport: viewport.name, status: taken.status, image, ...(taken.video ? { video } : {}), ...identityOf(take) });
  }
  return null;
}

/** A capture's identity, as the capture result records it: none for a page viewed signed out. */
function identityOf({ signedIn }: Shot | VariantTake): { readonly identity?: CaptureIdentity } {
  return signedIn === undefined ? {} : { identity: signedIn.identity };
}

/** Logs that a signed-in page landed on the sign-in path, so its session didn't take, then gives sign-in-failed. */
function signedOut(capturer: Capturer, { url, viewport, signedIn }: Shot | VariantTake): CaptureFailure {
  return stopped(capturer, "sign-in-failed", `at ${url} at ${viewport.name}: signed in as ${signedIn?.identity}, it landed on ${signedIn?.signInPath}, so its image was thrown away`);
}

/**
 * Installs the browser, builds the branch and starts its server at `ui.url`,
 * then signs in each Capture identity these shots or takes are viewed as,
 * once each, in the order they're first needed, all within what's `left` of
 * capture's budget: null once all have signed in, else why capture stopped.
 */
async function serveBranch(
  build: string | null,
  ui: UiConfig,
  capturer: Capturer,
  left: () => number,
  shots: readonly (Shot | VariantTake)[],
): Promise<CaptureFailure | null> {
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
  const identities = [...new Set(shots.flatMap(({ signedIn }) => (signedIn === undefined ? [] : [signedIn.identity])))];
  for (const identity of identities) {
    const command = ui.signIn?.[identity];
    if (command === undefined) return stopped(capturer, "error", `signing in as ${identity}, which \`ui.sign_in\` names no command for`);
    const signInMs = Math.min(SIGN_IN_MS, left());
    const signed = await capturer.signIn(identity, command, signInMs);
    // As with the server: a sign-in cut short by capture's own budget is capture running out of time.
    if (signed === "timed-out" && signInMs < SIGN_IN_MS) return stopped(capturer, "timeout", `signing in as ${identity}`);
    if (signed !== "signed-in") return stopped(capturer, "sign-in-failed", `signing in as ${identity}: ${SIGN_IN_ENDS[signed]}`);
  }
  return null;
}

/** How a sign-in that failed ended, for the log. */
const SIGN_IN_ENDS: Readonly<Record<Exclude<SignInEnd, "signed-in">, string>> = {
  failed: "its `ui.sign_in` command failed",
  "timed-out": `its \`ui.sign_in\` command ran past its ${SIGN_IN_MS / 60_000} minutes`,
  "no-state": "its `ui.sign_in` command wrote nothing to FABRIK_STORAGE_STATE",
  "bad-state": "what its `ui.sign_in` command wrote to FABRIK_STORAGE_STATE isn't a storage state: a JSON object with cookies and origins lists",
};

/**
 * Whether a sign-in left a storage state capture can load: an object with
 * `cookies` and `origins` lists, as Playwright writes it, or a Product
 * writes it by hand.
 */
export function isStorageState(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { cookies, origins } = value as Record<string, unknown>;
  return Array.isArray(cookies) && Array.isArray(origins);
}

/** Whether a page that ended at `url` landed on the sign-in path, a trailing / or its query making no difference. */
export function isOnSignInPath(url: string, signInPath: string): boolean {
  const path = (at: string) => at.replace(/(?<=.)\/+$/, "");
  return path(new URL(url).pathname) === path(signInPath);
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
  const signedIn = signedInAs(route, ui);
  return variants.flatMap((variant) =>
    UI_VIEWPORTS.map((viewport) => {
      const name = `variant-${variant.toLowerCase()}-${viewport.name}`;
      return { route, variant, viewport, url: variantPage(page, variant), image: `${name}.png`, video: `${name}.webm`, ...signedIn };
    }),
  );
}

/** Who a route of the branch is viewed as, by Kit config's rules: nothing for a route viewed signed out. */
function signedInAs(route: string, ui: UiConfig): { readonly signedIn?: SignedInAs } {
  const identity = captureIdentityOf(route, ui);
  return identity === null || ui.signInPath === undefined ? {} : { signedIn: { identity, signInPath: ui.signInPath } };
}

/**
 * Every shot of these routes: After, from the branch served at `ui.url`,
 * each signed in as its Capture identity when it has one, then Before, from
 * `ui.before_url` when there is one, of the routes viewed signed out alone,
 * since no sign-in ever reaches a deployed site (ADR-0012); each route in
 * the order chosen, at mobile then desktop.
 */
function shotsFor(routes: readonly ChosenRoute[], ui: UiConfig): Shot[] {
  const sides: [CaptureSide, string][] = [["after", ui.url]];
  if (ui.beforeUrl !== null) sides.push(["before", ui.beforeUrl]);
  return sides.flatMap(([side, base]) =>
    routes.flatMap(({ route, reason }, at) => {
      const signedIn = signedInAs(route, ui);
      if (side === "before" && signedIn.signedIn !== undefined) return [];
      return UI_VIEWPORTS.map((viewport) => ({
        route,
        reason,
        viewport,
        side,
        url: pageAt(base, route),
        image: `${side}-${viewport.name}-${at + 1}-${routeSlug(route)}.png`,
        ...(side === "after" ? signedIn : {}),
      }));
    }),
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

/** What capture writes beside its screenshots: the capture result, and the Evidence page when it took any. */
export interface CaptureStepFiles {
  readonly result: string;
  /** The Evidence page, or null when capture took no screenshot. */
  readonly evidencePage: string | null;
}

/** The capture result's file text, and the Evidence page of every screenshot with its PNG's bytes in `images`, by file name. */
export function captureStepFiles(result: CaptureResult<Capture>, images: ReadonlyMap<string, Uint8Array>, ticket: number): CaptureStepFiles {
  const shots = result.captures.flatMap((capture): EvidencePageShot[] => {
    const png = images.get(capture.image);
    return png === undefined ? [] : [{ ...capture, png }];
  });
  return {
    result: `${JSON.stringify(result, null, 2)}\n`,
    evidencePage: shots.length === 0 ? null : evidencePage(shots, { ticket, headSha: result.headSha }),
  };
}

/**
 * The capture result's file text, and the Prototype's Evidence page of every variant
 * under its letter and summary, with each screenshot and video capture took,
 * their bytes in `files` by file name; no Evidence page when it took no screenshot.
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
    evidencePage: shots.length === 0 ? null : prototypeEvidencePage(shots, variants, { ...meta, headSha: result.headSha }),
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
 * The env `sandbox.build`, `ui.serve` and `ui.sign_in` run with: the runner's, with Kit
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

