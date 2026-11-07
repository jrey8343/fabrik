// The real Capturer (src/evidence/capture.ts): what capture does to the
// runner, driving Playwright's headless Chromium. capture-main.ts runs it in
// the Implement and prototype jobs, and its own test drives it against a tiny
// local fixture. It makes no decision of capture's: it runs Product commands,
// loads pages and saves what they show, as it's told.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { type Browser, type BrowserContext, chromium, errors, type Page } from "playwright-core";
import type { CaptureIdentity, Viewport } from "../kit/config.ts";
import { KIT_DIR } from "../kit/kitFiles.ts";
import {
  type Capturer,
  type Finished,
  isOnSignInPath,
  isStorageState,
  ON_SIGN_IN,
  servedAt,
  type Shot,
  type SignedIn,
  type SignedInAs,
  type VariantTake,
} from "./capture.ts";

const run = promisify(execFile);

/** The env a sign-in command writes its Playwright storage state's path in. */
export const STORAGE_STATE_ENV = "FABRIK_STORAGE_STATE";

/** The runner, as captureEvidence drives it. */
export class PlaywrightCapturer implements Capturer {
  private readonly started = new Set<ChildProcess>();
  private browser: Browser | null = null;
  private readonly contexts = new Map<string, BrowserContext>();
  /** Where sign-ins write their storage states: a temp folder of its own, never in the evidence folder, so no session is uploaded with the evidence. */
  private stateDir: string | null = null;
  /** Each Capture identity signed in, and its storage state's file. */
  private readonly states = new Map<CaptureIdentity, string>();

  private readonly productDir: string;
  private readonly evidenceDir: string;
  private readonly base: string;
  private readonly env: Readonly<Record<string, string>>;

  /** `base` is the default branch's commit, which the branch is diffed against; `env` is what build, serve and sign-in run with. */
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

  async signIn(identity: CaptureIdentity, command: string, timeoutMs: number): Promise<SignedIn> {
    this.stateDir ??= await mkdtemp(join(tmpdir(), "fabrik-sign-in-"));
    const state = join(this.stateDir, `${identity}.json`);
    await rm(state, { force: true });
    const ran = await this.runToEnd(this.shell(command, { [STORAGE_STATE_ENV]: state }), timeoutMs);
    if (ran !== "ok") return ran;
    const text = await readFile(state, "utf8").catch(() => null);
    if (text === null) return "no-state";
    try {
      if (!isStorageState(JSON.parse(text))) return "bad-state";
    } catch {
      return "bad-state";
    }
    this.states.set(identity, state);
    return "signed-in";
  }

  async screenshot(shot: Shot, timeoutMs: number): Promise<number | "timed-out" | typeof ON_SIGN_IN> {
    const end = Date.now() + timeoutMs;
    const page = await (await this.contextFor(shot.viewport, shot.signedIn)).newPage();
    try {
      const response = await page.goto(shot.url, { waitUntil: "load", timeout: timeoutMs });
      if (response === null) throw new Error(`${shot.url} gave no response`);
      // A signed-in page that ends on the sign-in page is a session that didn't take: no image of it is kept.
      if (landedOnSignIn(page, shot.signedIn)) return ON_SIGN_IN;
      // A moment for late requests to settle, never more than a few seconds.
      await page.waitForLoadState("networkidle", { timeout: Math.max(1, Math.min(5_000, end - Date.now())) }).catch(() => undefined);
      if (landedOnSignIn(page, shot.signedIn)) return ON_SIGN_IN;
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

  async recordVariant(take: VariantTake, timeoutMs: number): Promise<{ readonly status: number; readonly video: boolean } | "timed-out" | typeof ON_SIGN_IN> {
    const end = Date.now() + timeoutMs;
    const videoDir = await mkdtemp(join(tmpdir(), "fabrik-video-"));
    // A context of its own, so its video holds this take alone; the video is written once its page closes.
    const context = await (await this.launched()).newContext({ ...contextOptions(take.viewport), ...this.storageStateOf(take.signedIn), recordVideo: { dir: videoDir } });
    try {
      const page = await context.newPage();
      let status: number;
      try {
        const response = await page.goto(take.url, { waitUntil: "load", timeout: Math.max(1, timeoutMs - SCROLL_MS - 10_000) });
        if (response === null) throw new Error(`${take.url} gave no response`);
        if (landedOnSignIn(page, take.signedIn)) return ON_SIGN_IN;
        status = response.status();
        await page.waitForLoadState("networkidle", { timeout: Math.max(1, Math.min(5_000, end - Date.now())) }).catch(() => undefined);
        if (landedOnSignIn(page, take.signedIn)) return ON_SIGN_IN;
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
    // The sessions were the Sandbox's alone, and end with it.
    if (this.stateDir !== null) await rm(this.stateDir, { recursive: true, force: true });
    this.states.clear();
  }

  now(): number {
    return Date.now();
  }

  log(line: string): void {
    console.log(line);
  }

  /** A Product command, in its own process group so stop() ends all it starts, with the env build and serve get, and any `extra`. */
  private shell(command: string, extra: Readonly<Record<string, string>> = {}): ChildProcess {
    return this.track(spawn("bash", ["-c", command], { cwd: this.productDir, env: { ...this.env, ...extra }, stdio: ["ignore", "inherit", "inherit"], detached: true }));
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

  /** A browser context's storage state, for a page viewed signed in: the one its identity's sign-in wrote. */
  private storageStateOf(signedIn: SignedInAs | undefined): { readonly storageState?: string } {
    if (signedIn === undefined) return {};
    const state = this.states.get(signedIn.identity);
    if (state === undefined) throw new Error(`${signedIn.identity} hasn't signed in, so there's no session to view the page as`);
    return { storageState: state };
  }

  /** One context for each viewport and Capture identity, so no session is ever shared with a page viewed as another, or signed out. */
  private async contextFor(viewport: Viewport, signedIn: SignedInAs | undefined): Promise<BrowserContext> {
    const key = `${viewport.name}\0${signedIn?.identity ?? ""}`;
    const known = this.contexts.get(key);
    if (known !== undefined) return known;
    const context = await (await this.launched()).newContext({ ...contextOptions(viewport), ...this.storageStateOf(signedIn) });
    this.contexts.set(key, context);
    return context;
  }

  private async launched(): Promise<Browser> {
    this.browser ??= await chromium.launch({ headless: true });
    return this.browser;
  }
}

/** Whether a page viewed signed in has ended on its sign-in path; a page viewed signed out never is asked. */
function landedOnSignIn(page: Page, signedIn: SignedInAs | undefined): boolean {
  return signedIn !== undefined && isOnSignInPath(page.url(), signedIn.signInPath);
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
