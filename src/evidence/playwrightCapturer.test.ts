// The real Capturer, driven against a tiny local fixture (ADR-0012): a
// Product whose /today is gated on a session cookie, redirecting to /sign-in
// without one, and fake sign-in commands that write a storage state by hand,
// as a Product without Playwright would. It proves a sign-in's state loads
// and the gated page is captured, that a bad session or a failed sign-in is
// sign-in-failed, and that no session ever lands in the evidence folder. It
// needs Playwright's Chromium: CI installs it, and elsewhere it's skipped
// until `npx playwright-core install chromium` has run.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import { chromium, errors } from "playwright-core";
import { describe, expect, it } from "vitest";
import { tempDir } from "../__fixtures__/skillsArchive.ts";
import type { UiConfig } from "../kit/config.ts";
import { buildAndServeEnv, type CaptureInput, captureEvidence, capturePrototype, EVIDENCE_DIR, type Finished } from "./capture.ts";
import { browserErrorOf, PlaywrightCapturer, STORAGE_STATE_ENV } from "./playwrightCapturer.ts";

const HEAD = "d".repeat(40);

/** A port nothing answers on yet. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

/** The fixture's server: /today only with the session cookie `good`, else a redirect to /sign-in; /pricing and /sign-in for anyone. */
const SERVER = `
import { createServer } from "node:http";
const page = (title) => "<!doctype html><title>" + title + "</title><h1>" + title + "</h1>";
createServer((request, response) => {
  const path = new URL(request.url, "http://x").pathname;
  const signedIn = (request.headers.cookie ?? "").split(/;\\s*/).includes("session=good");
  if (path === "/today" && !signedIn) {
    response.writeHead(302, { location: "/sign-in?next=%2Ftoday" });
    return response.end();
  }
  const title = { "/today": "Today", "/pricing": "Pricing", "/sign-in": "Sign in" }[path];
  response.writeHead(title === undefined ? 404 : 200, { "content-type": "text/html" });
  response.end(page(title ?? "Not found"));
}).listen(Number(process.env.PORT), "localhost");
`;

/**
 * The fixture's sign-in: writes a storage state holding the session cookie
 * it's given to FABRIK_STORAGE_STATE, by hand, and the env it ran with beside
 * it in the Product directory, for the test to read.
 */
const SIGN_IN = `
import { writeFileSync } from "node:fs";
writeFileSync("sign-in-env.json", JSON.stringify(process.env));
const [session] = process.argv.slice(2);
const cookie = { name: "session", value: session, domain: "localhost", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" };
writeFileSync(process.env.FABRIK_STORAGE_STATE, JSON.stringify({ cookies: [cookie], origins: [] }));
`;

/** The real capturer, but for installing the browser, which the runner has, and diffing, which the fixture has no history for. */
class FixtureCapturer extends PlaywrightCapturer {
  override async installBrowser(): Promise<Finished> {
    return "ok";
  }

  override async changedPaths(): Promise<readonly string[]> {
    return ["src/pages/today.astro"];
  }
}

/** A Product serving the fixture on a port of its own, signing an owner in with `signIn`, and a runner whose env holds a test secret. */
async function aProduct(signIn: string, beforeUrl: string | null = null) {
  const product = await tempDir("signed-in-product");
  const out = await tempDir("fabrik-out");
  await writeFile(join(product, "server.mjs"), SERVER);
  await writeFile(join(product, "sign-in.mjs"), SIGN_IN);
  const port = await freePort();
  const ui: UiConfig = {
    paths: ["src/pages/**"],
    serve: "node server.mjs",
    url: `http://localhost:${port}`,
    beforeUrl,
    defaultRoutes: [],
    signIn: { owner: signIn },
    signInPath: "/sign-in",
    signedInRoutes: [
      { route: "/pricing", as: null },
      { route: "/**", as: "owner" },
    ],
  };
  // The 1Password step's outputs, as the agent step's env holds them; capture's never does, and must not pass them on if it did.
  const runnerEnv = { ...process.env, PORT: String(port), FABRIK_SECRETS: JSON.stringify({ STRIPE_KEY: "sk_test_fixture_secret" }) };
  const evidenceDir = join(out, EVIDENCE_DIR);
  const capturer = new FixtureCapturer(product, evidenceDir, "0".repeat(40), buildAndServeEnv(runnerEnv, { PORT: String(port) }));
  const input: CaptureInput = { ui, build: null, headSha: HEAD, ticketBody: "Show the day on `/today`, and link it from `/pricing`.", implementerRoutes: [] };
  return { product, out, evidenceDir, ui, capturer, input };
}

/** Every file under a folder, as paths relative to it. */
async function filesUnder(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

const hasChromium = existsSync(chromium.executablePath());

describe("The browser error a page load failed with", () => {
  it("is Chromium's code from Playwright's message, such as a refused connection or a name that didn't resolve", () => {
    expect(browserErrorOf(new Error("page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:9/pricing\nCall log:\n  - navigating"))).toBe("ERR_CONNECTION_REFUSED");
    expect(browserErrorOf(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://nowhere.invalid/"))).toBe("ERR_NAME_NOT_RESOLVED");
  });

  it("is none for a timeout or any other error, which capture doesn't go on past", () => {
    expect(browserErrorOf(new errors.TimeoutError("page.goto: Timeout 60000ms exceeded. net::ERR_ABORTED"))).toBeNull();
    expect(browserErrorOf(new Error("page.goto: Target page, context or browser has been closed"))).toBeNull();
    expect(browserErrorOf("net::ERR_CONNECTION_REFUSED")).toBeNull();
  });
});

describe.skipIf(!hasChromium && process.env.CI === undefined)("The Playwright capturer, signing in to a local fixture", { timeout: 120_000 }, () => {
  it("loads the sign-in's storage state and captures the gated page as its identity, and the public page signed out", async () => {
    const { evidenceDir, capturer, input } = await aProduct("node sign-in.mjs good");

    const outcome = await captureEvidence(input, capturer);

    expect(outcome).toEqual({
      kind: "recorded",
      result: {
        outcome: "captured",
        headSha: HEAD,
        captures: [
          { route: "/today", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-1-today.png", identity: "owner" },
          { route: "/today", reason: "ticket", viewport: "desktop", side: "after", status: 200, image: "after-desktop-1-today.png", identity: "owner" },
          { route: "/pricing", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-2-pricing.png" },
          { route: "/pricing", reason: "ticket", viewport: "desktop", side: "after", status: 200, image: "after-desktop-2-pricing.png" },
        ],
      },
    });
    // Only the screenshots: no session is ever written where the evidence is uploaded from.
    expect((await filesUnder(evidenceDir)).toSorted()).toEqual([
      "after-desktop-1-today.png",
      "after-desktop-2-pricing.png",
      "after-mobile-1-today.png",
      "after-mobile-2-pricing.png",
    ]);
  });

  it("runs the sign-in with FABRIK_STORAGE_STATE outside the evidence folder, the env ui.serve gets, and nothing of the test secrets", async () => {
    const { product, out, capturer, input } = await aProduct("node sign-in.mjs good");

    await captureEvidence(input, capturer);
    const env = JSON.parse(await readFile(join(product, "sign-in-env.json"), "utf8")) as Record<string, string>;

    const state = env[STORAGE_STATE_ENV] ?? "";
    expect(state).not.toBe("");
    expect(relative(out, state).startsWith("..")).toBe(true);
    expect(env["PORT"]).toBe(input.ui?.url.split(":").at(-1));
    expect(env["FABRIK_SECRETS"]).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("sk_test_fixture_secret");
    // The session ends with capture.
    expect(existsSync(state)).toBe(false);
  });

  it("records sign-in-failed, keeping no image of the sign-in page, when the session doesn't take and the gated page lands on ui.sign_in_path", async () => {
    const { evidenceDir, capturer, input } = await aProduct("node sign-in.mjs expired");

    expect(await captureEvidence(input, capturer)).toEqual({
      kind: "recorded",
      result: { outcome: "failed", reason: "sign-in-failed", headSha: HEAD, captures: [] },
    });
    expect(await filesUnder(evidenceDir)).toEqual([]);
  });

  it.each([
    ["exits non-zero", "exit 3"],
    ["writes no state", "true"],
    ["writes a state that doesn't read", `printf 'not json' > "$${STORAGE_STATE_ENV}"`],
    ["writes JSON that isn't a storage state", `printf '{"cookies":[]}' > "$${STORAGE_STATE_ENV}"`],
  ])("records sign-in-failed with no screenshots when the sign-in %s", async (_, command) => {
    const { evidenceDir, capturer, input } = await aProduct(command);

    expect(await captureEvidence(input, capturer)).toEqual({
      kind: "recorded",
      result: { outcome: "failed", reason: "sign-in-failed", headSha: HEAD, captures: [] },
    });
    expect(await filesUnder(evidenceDir)).toEqual([]);
  });

  it("goes on past a Before that refuses the browser, keeping every After, and names the route, URL and error it missed", async () => {
    const closed = await freePort();
    const { evidenceDir, capturer, input } = await aProduct("node sign-in.mjs good", `http://localhost:${closed}`);

    const outcome = await captureEvidence(input, capturer);

    expect(outcome).toMatchObject({ kind: "recorded", result: { outcome: "captured" } });
    const result = outcome.kind === "recorded" ? outcome.result : null;
    expect(result?.captures.map(({ image }) => image)).toEqual([
      "after-mobile-1-today.png",
      "after-desktop-1-today.png",
      "after-mobile-2-pricing.png",
      "after-desktop-2-pricing.png",
    ]);
    // /today is viewed signed in, so has no Before; /pricing's Before was refused at both viewports.
    expect(result?.missed).toEqual(
      (["mobile", "desktop"] as const).map((viewport) => ({
        route: "/pricing",
        reason: "ticket",
        viewport,
        side: "before",
        url: `http://localhost:${closed}/pricing`,
        why: "before-unreachable",
        error: "ERR_CONNECTION_REFUSED",
      })),
    );
    expect((await filesUnder(evidenceDir)).every((file) => file.startsWith("after-"))).toBe(true);
  });

  it("signs a prototype turn's take in by the same rules, loading the state into the take's own context", async () => {
    const { evidenceDir, ui, capturer } = await aProduct("node sign-in.mjs good");
    await mkdir(evidenceDir, { recursive: true });

    const outcome = await capturePrototype({ ui, build: null, headSha: HEAD, route: "/today", variants: ["A"] }, capturer);

    expect(outcome.kind === "recorded" && outcome.result.outcome).toBe("captured");
    expect(outcome.kind === "recorded" && outcome.result.captures.map(({ status, identity }) => ({ status, identity }))).toEqual([
      { status: 200, identity: "owner" },
      { status: 200, identity: "owner" },
    ]);
    expect((await filesUnder(evidenceDir)).every((file) => /^variant-a-(mobile|desktop)\.(png|webm)$/.test(file))).toBe(true);
  });
});
