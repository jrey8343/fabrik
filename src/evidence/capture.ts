// Capturing UI evidence (#153) in the Implement job, after the Implementer's
// agent has ended: every decision the capture step makes, behind the
// Capturer, which does what capture does to the runner. The Playwright shell
// (src/evidence/capture-main.ts) is the real Capturer, and tests fake it. Pure, no I/O.
import { UI_VIEWPORTS, type UiConfig, type Viewport } from "../kit/config.ts";
import { gallery, type GalleryShot } from "./gallery.ts";
import { type Capture, type CaptureFailure, type CaptureResult, type CaptureSide, type ChosenRoute, isUi, routesFor } from "./uiEvidence.ts";

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

/** How a step capture waits on ended: it finished, it failed, or it ran past the time it was given. */
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
  /** Stops everything capture started. */
  stop(): Promise<void>;
  /** Milliseconds, from any fixed point. */
  now(): number;
  /** A line for the job's log. */
  log(line: string): void;
}

/** What capture came to: off without a ui block, skipped when there's nothing to capture, or the capture result it recorded. */
export type CaptureOutcome =
  | { readonly kind: "off" }
  | { readonly kind: "skipped"; readonly why: string }
  | { readonly kind: "recorded"; readonly result: CaptureResult };

/**
 * The capture step's own timeout-minutes in loop.yml: a Kit constant, so a
 * slow build or server can never hold the Implement job past its budget.
 */
export const CAPTURE_TIMEOUT_MINUTES = 20;

/** How long capture gives itself, inside its step's timeout, so it's always left time to write what it took. */
const CAPTURE_BUDGET_MS = (CAPTURE_TIMEOUT_MINUTES - 2) * 60_000;

/** How long `ui.url` gets to answer once `ui.serve` has started. */
const SERVER_START_MS = 3 * 60_000;

/** How long each page gets to load. */
const PAGE_LOAD_MS = 60_000;

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
  let failure: CaptureFailure | null;
  try {
    failure = await takeShots(input.build, ui, routes, capturer, captures);
  } catch (error) {
    capturer.log(`Capture failed: ${messageOf(error)}`);
    failure = "error";
  } finally {
    await capturer.stop();
  }
  return recorded(failure === null ? { outcome: "captured", headSha, captures } : { outcome: "failed", reason: failure, headSha, captures });
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
  const end = capturer.now() + CAPTURE_BUDGET_MS;
  const left = () => end - capturer.now();
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
  for (const shot of shotsFor(routes, ui)) {
    if (left() <= 0) return stopped(capturer, "timeout", `before ${shot.url} at ${shot.viewport.name}`);
    const status = await capturer.screenshot(shot, Math.min(PAGE_LOAD_MS, left()));
    if (status === "timed-out") return stopped(capturer, "timeout", `loading ${shot.url} at ${shot.viewport.name}`);
    const { route, reason, viewport, side, image } = shot;
    captures.push({ route, reason, viewport: viewport.name, side, status, image });
  }
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

function recorded(result: CaptureResult): CaptureOutcome {
  return { kind: "recorded", result };
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
        url: `${base.replace(/\/+$/, "")}${route}`,
        image: `${side}-${viewport.name}-${at + 1}-${slug(route)}.png`,
      })),
    ),
  );
}

/** The most of a route a file name keeps; its place in the list keeps the name unique. */
const SLUG_LENGTH = 40;

/** A route as a file name's part: its letters and digits, lowercased, with a dash for each run of anything else, `root` for `/`. */
function slug(route: string): string {
  const dashed = route.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "");
  return dashed.slice(0, SLUG_LENGTH).replace(/-+$/, "") || "root";
}

/** The step output the push job reads the capture result from: one compact JSON line, empty when nothing was captured. */
export function captureStepOutputs(outcome: CaptureOutcome): Readonly<Record<"ui-evidence", string>> {
  return { "ui-evidence": outcome.kind === "recorded" ? JSON.stringify(outcome.result) : "" };
}

/** What capture writes beside its screenshots: the capture result, and the gallery when it took any. */
export interface CaptureStepFiles {
  readonly result: string;
  /** The gallery page, or null when capture took no screenshot. */
  readonly gallery: string | null;
}

/** The capture result's file text, and the gallery of every screenshot with its PNG's bytes in `images`, by file name. */
export function captureStepFiles(result: CaptureResult, images: ReadonlyMap<string, Uint8Array>, ticket: number): CaptureStepFiles {
  const shots = result.captures.flatMap((capture): GalleryShot[] => {
    const png = images.get(capture.image);
    return png === undefined ? [] : [{ ...capture, png }];
  });
  return {
    result: `${JSON.stringify(result, null, 2)}\n`,
    gallery: shots.length === 0 ? null : gallery(shots, { ticket, headSha: result.headSha }),
  };
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
      const shots = `${result.captures.length} screenshot${result.captures.length === 1 ? "" : "s"}`;
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

