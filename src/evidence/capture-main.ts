// The Implement job's UI evidence capture step (#153), run once the
// Implementer's agent has ended: the Playwright shell around captureEvidence
// (src/evidence/capture.ts), which makes every decision. This file only does
// what it's told on the runner: reads Kit config from the default branch's
// commit, the one the push job reads to say whether the PR is UI, never from
// the branch's own files, which may be older; diffs the branch against that
// same commit, installs Chromium, runs
// `sandbox.build`, frees `ui.url`'s port, starts `ui.serve`, screenshots each
// shot headless, and writes the screenshots, the capture result and the
// gallery into the agent's output directory, passing the result out as the
// step output `ui-capture-result`. No model turns, no MCP, no video. Capture's own
// failures are in the capture result, never this step's exit code. Its tests
// run it in a repo without a ui block, where it must do nothing; the Pilot
// exercises the Playwright path.
//   node <kit>/src/evidence/capture-main.ts
//
// Run from the Product checkout, after prepare-agent's npm ci (the only Kit
// program that imports Playwright). Env:
//   FABRIK_OUT_DIR         the agent's output directory, holding agent-result.json
//   FABRIK_ISSUE_FILE      the Ticket, as prepare-agent read it; its body names routes
//   FABRIK_DEFAULT_BRANCH  the default branch, fetched as origin/<it>: Kit config is read, and
//                          the branch diffed against, at its commit
// Nothing here holds a secret, and the build and server get none (buildAndServeEnv).
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { type Browser, type BrowserContext, chromium, errors, type Page } from "playwright-core";
import { AGENT_RESULT_FILE, readAgentRunResult } from "../agent/result.ts";
import { readKitConfigWith } from "../kit/checkout.ts";
import type { Viewport } from "../kit/config.ts";
import { KIT_DIR } from "../kit/kitFiles.ts";
import { writeOutputs, writeSummary } from "../kit/stepFiles.ts";
import {
  buildAndServeEnv,
  CAPTURE_RESULT_FILE,
  captureEvidence,
  type Capturer,
  captureStepFiles,
  captureStepOutputs,
  captureStepSummary,
  EVIDENCE_DIR,
  type Finished,
  GALLERY_FILE,
  implementerRoutesIn,
  servedAt,
  type Shot,
  type VariantTake,
} from "./capture.ts";

const run = promisify(execFile);

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

/** The runner, as captureEvidence drives it. */
class PlaywrightCapturer implements Capturer {
  private readonly started = new Set<ChildProcess>();
  private browser: Browser | null = null;
  private readonly contexts = new Map<string, BrowserContext>();

  private readonly productDir: string;
  private readonly evidenceDir: string;
  private readonly base: string;
  private readonly env: Readonly<Record<string, string>>;

  /** `base` is the default branch's commit, which the branch is diffed against. */
  constructor(productDir: string, evidenceDir: string, base: string, env: Readonly<Record<string, string>>) {
    this.productDir = productDir;
    this.evidenceDir = evidenceDir;
    this.base = base;
    this.env = env;
  }

  async changedPaths(headSha: string): Promise<readonly string[]> {
    const args = ["diff", "--name-only", "--no-renames", "-z", `${this.base}...${headSha}`];
    const { stdout } = await run("git", args, { cwd: this.productDir, maxBuffer: 64 * 1024 * 1024 });
    return stdout.split("\0").filter((path) => path !== "");
  }

  installBrowser(timeoutMs: number): Promise<Finished> {
    return this.runToEnd(spawn("npx", ["playwright-core", "install", "--with-deps", "chromium"], { cwd: KIT_DIR, stdio: ["ignore", "inherit", "inherit"], detached: true }), timeoutMs);
  }

  build(command: string, timeoutMs: number): Promise<Finished> {
    return this.runToEnd(this.shell(command), timeoutMs);
  }

  async freePort(url: string): Promise<boolean> {
    const { host, port } = servedAt(url);
    if (!(await listening(host, port))) return true;
    console.log(`Something already answers on port ${port}, such as a server the agent left: stopping it.`);
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      // Whichever of fuser and lsof the runner has.
      await run("fuser", ["-k", `-${signal.slice(3)}`, "-n", "tcp", String(port)]).catch(() => undefined);
      const { stdout } = await run("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"]).catch(() => ({ stdout: "" }));
      for (const pid of stdout.split("\n").filter((line) => line !== "")) {
        try {
          process.kill(Number(pid), signal);
        } catch {
          // It has already exited.
        }
      }
      for (let tries = 0; tries < 10; tries++) {
        if (!(await listening(host, port))) return true;
        await sleep(500);
      }
    }
    return !(await listening(host, port));
  }

  async serve(command: string, url: string, timeoutMs: number): Promise<"answered" | "exited" | "timed-out"> {
    const server = this.shell(command);
    let exited = false;
    server.once("exit", () => {
      exited = true;
    });
    server.once("error", () => {
      exited = true;
    });
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (exited) return "exited";
      try {
        // Any answer at all: a page that errors is still a server that started.
        const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, end - Date.now()))) });
        await response.body?.cancel();
        return "answered";
      } catch {
        await sleep(1_000);
      }
    }
    return exited ? "exited" : "timed-out";
  }

  async screenshot(shot: Shot, timeoutMs: number): Promise<number | "timed-out"> {
    const end = Date.now() + timeoutMs;
    const page = await (await this.contextFor(shot.viewport)).newPage();
    try {
      const response = await page.goto(shot.url, { waitUntil: "load", timeout: timeoutMs });
      if (response === null) throw new Error(`${shot.url} gave no response`);
      // A moment for late requests to settle, never more than a few seconds.
      await page.waitForLoadState("networkidle", { timeout: Math.max(1, Math.min(5_000, end - Date.now())) }).catch(() => undefined);
      await mkdir(this.evidenceDir, { recursive: true });
      await page.screenshot({ path: join(this.evidenceDir, shot.image), type: "png", animations: "disabled", timeout: Math.max(1, end - Date.now()) });
      return response.status();
    } catch (error) {
      if (error instanceof errors.TimeoutError) return "timed-out";
      throw error;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async recordVariant(take: VariantTake, timeoutMs: number): Promise<{ readonly status: number; readonly video: boolean } | "timed-out"> {
    const end = Date.now() + timeoutMs;
    const videoDir = await mkdtemp(join(tmpdir(), "fabrik-video-"));
    // A context of its own, so its video holds this take alone; the video is written once its page closes.
    const context = await (await this.launched()).newContext({ ...contextOptions(take.viewport), recordVideo: { dir: videoDir } });
    try {
      const page = await context.newPage();
      let status: number;
      try {
        const response = await page.goto(take.url, { waitUntil: "load", timeout: Math.max(1, timeoutMs - SCROLL_MS - 10_000) });
        if (response === null) throw new Error(`${take.url} gave no response`);
        status = response.status();
        await page.waitForLoadState("networkidle", { timeout: Math.max(1, Math.min(5_000, end - Date.now())) }).catch(() => undefined);
        await mkdir(this.evidenceDir, { recursive: true });
        await page.screenshot({ path: join(this.evidenceDir, take.image), type: "png", animations: "disabled", timeout: Math.max(1, end - Date.now()) });
      } catch (error) {
        if (error instanceof errors.TimeoutError) return "timed-out";
        throw error;
      }
      // The take keeps its screenshot whatever becomes of its video.
      const scrolled = await scrollThrough(page, Math.min(end, Date.now() + SCROLL_MS)).then(
        () => true,
        (error: unknown) => {
          console.log(`The video of ${take.url} at ${take.viewport.name} wasn't kept: ${error instanceof Error ? error.message : String(error)}`);
          return false;
        },
      );
      const video = page.video();
      await page.close();
      if (!scrolled || video === null) return { status, video: false };
      const saved = await video.saveAs(join(this.evidenceDir, take.video)).then(
        () => true,
        (error: unknown) => {
          console.log(`The video of ${take.url} at ${take.viewport.name} couldn't be saved: ${error instanceof Error ? error.message : String(error)}`);
          return false;
        },
      );
      return { status, video: saved };
    } finally {
      await context.close().catch(() => undefined);
      await rm(videoDir, { recursive: true, force: true });
    }
  }

  async stop(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    for (const child of this.started) signalGroup(child, "SIGTERM");
    await sleep(this.started.size === 0 ? 0 : 2_000);
    for (const child of this.started) signalGroup(child, "SIGKILL");
    this.started.clear();
  }

  now(): number {
    return Date.now();
  }

  log(line: string): void {
    console.log(line);
  }

  /** A Product command, in its own process group so stop() ends all it starts, with the env build and serve get. */
  private shell(command: string): ChildProcess {
    return this.track(spawn("bash", ["-c", command], { cwd: this.productDir, env: this.env, stdio: ["ignore", "inherit", "inherit"], detached: true }));
  }

  private track(child: ChildProcess): ChildProcess {
    this.started.add(child);
    child.once("exit", () => this.started.delete(child));
    return child;
  }

  /** Waits for a process to end: ok on exit 0, failed otherwise, and timed-out, its group stopped, past timeoutMs. */
  private runToEnd(child: ChildProcess, timeoutMs: number): Promise<Finished> {
    this.track(child);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signalGroup(child, "SIGKILL");
        resolve("timed-out");
      }, Math.max(0, timeoutMs));
      child.once("error", (error) => {
        clearTimeout(timer);
        console.log(error.message);
        resolve("failed");
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? "ok" : "failed");
      });
    });
  }

  private async contextFor(viewport: Viewport): Promise<BrowserContext> {
    const known = this.contexts.get(viewport.name);
    if (known !== undefined) return known;
    const context = await (await this.launched()).newContext(contextOptions(viewport));
    this.contexts.set(viewport.name, context);
    return context;
  }

  private async launched(): Promise<Browser> {
    this.browser ??= await chromium.launch({ headless: true });
    return this.browser;
  }
}

/** A browser context at a Kit viewport, a phone's touch screen at mobile. */
function contextOptions(viewport: Viewport) {
  const mobile = viewport.name === "mobile";
  return { viewport: { width: viewport.width, height: viewport.height }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 };
}

/** How long a take's scripted scroll runs at most, so each variant's video stays short. */
const SCROLL_MS = 8_000;

/** Run in the page (the Kit compiles without the DOM's types): scrolls half a screen down, true when it was already at its foot. */
const SCROLL_HALF_A_SCREEN = `(() => {
  const before = window.scrollY;
  window.scrollBy({ top: window.innerHeight / 2, behavior: "smooth" });
  return before + window.innerHeight >= document.documentElement.scrollHeight;
})()`;

/**
 * The scripted part of a take's video: a moment on the page as it loaded,
 * then down it a half screen at a time to its foot, or until `until`, then a
 * moment there.
 */
async function scrollThrough(page: Page, until: number): Promise<void> {
  await page.waitForTimeout(Math.max(0, Math.min(1_000, until - Date.now())));
  while (Date.now() < until - 1_000) {
    if ((await page.evaluate(SCROLL_HALF_A_SCREEN)) === true) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(Math.max(0, Math.min(1_000, until - Date.now())));
}

/** The commit a ref names in the Product checkout, which fails when the checkout lacks it. */
async function commitOf(productDir: string, ref: string): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd: productDir });
  return stdout.trim();
}

/** A file's text at a commit the checkout has, or null when the commit has no such file. */
async function fileAt(productDir: string, commit: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["cat-file", "blob", `${commit}:${path}`], { cwd: productDir, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    // The commit itself is known to be there (commitOf), so it's the file that isn't.
    return null;
  }
}

/** Signals a process's whole group, which it leads (spawned detached); gone already is fine. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // It has already exited.
  }
}

/** Whether anything accepts a TCP connection on the port. */
function listening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1_000 });
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function main(): Promise<void> {
  const productDir = process.cwd();
  const outDir = required("FABRIK_OUT_DIR");
  const evidenceDir = join(outDir, EVIDENCE_DIR);
  // Whatever an agent left where capture writes isn't evidence.
  await rm(evidenceDir, { recursive: true, force: true });
  await rm(join(outDir, GALLERY_FILE), { force: true });

  const base = await commitOf(productDir, `origin/${required("FABRIK_DEFAULT_BRANCH")}`);
  const resolved = await readKitConfigWith((path) => fileAt(productDir, base, path));
  if (!resolved.ok) {
    // The Kit job checked Kit config as this run started, so the default branch's has changed since.
    for (const error of resolved.errors) console.log(`::warning title=UI evidence not captured::${error}`);
    await writeOutputs(captureStepOutputs({ kind: "skipped", why: "Kit config doesn't read" }));
    return;
  }
  const { config } = resolved;
  const result = readAgentRunResult(await readFile(join(outDir, AGENT_RESULT_FILE), "utf8"));
  const issue = JSON.parse(await readFile(required("FABRIK_ISSUE_FILE"), "utf8")) as { body?: unknown };
  const capturer = new PlaywrightCapturer(productDir, evidenceDir, base, buildAndServeEnv(process.env, config.sandbox.env));
  const outcome = await captureEvidence(
    {
      ui: config.ui,
      build: config.sandbox.build,
      headSha: result.branch?.head ?? null,
      ticketBody: typeof issue.body === "string" ? issue.body : "",
      implementerRoutes: implementerRoutesIn(result.output),
    },
    capturer,
  );
  if (outcome.kind === "recorded") {
    const images = new Map<string, Uint8Array>();
    for (const { image } of outcome.result.captures) {
      const png = await readFile(join(evidenceDir, image)).catch(() => null);
      if (png !== null) images.set(image, png);
    }
    const files = captureStepFiles(outcome.result, images, result.issue);
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, CAPTURE_RESULT_FILE), files.result);
    if (files.gallery !== null) await writeFile(join(outDir, GALLERY_FILE), files.gallery);
  }
  await writeOutputs(captureStepOutputs(outcome));
  const summary = captureStepSummary(outcome);
  if (summary !== null) await writeSummary(summary);
}

main().catch((error: unknown) => {
  // A fault in this shell, not in capture: the step goes on (continue-on-error), and the push job reads no result.
  console.log(`::warning title=UI evidence not captured::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
