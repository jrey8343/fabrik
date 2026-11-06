import { describe, expect, it } from "vitest";
import type { UiConfig } from "../kit/config.ts";
import { buildAndServeEnv, type CaptureInput, type CaptureOutcome, type Capturer, captureEvidence, captureStepFiles, captureStepOutputs, captureStepSummary, implementJobTimeoutMinutes } from "./capture.ts";
import { type Capture, type CaptureFailure, type CaptureResult, parseCaptureResult } from "./uiEvidence.ts";

const HEAD = "c".repeat(40);

/** The Pilot's ui block: an Astro site served from its build. */
const ui: UiConfig = {
  paths: ["src/**/*.astro", "src/components/**"],
  serve: "node ./dist/server/entry.mjs",
  url: "http://127.0.0.1:4321",
  beforeUrl: "https://www.penrithphysio.com.au",
  defaultRoutes: ["/"],
};

/** A first run on a UI Ticket naming `/book`, whose Implementer changed a page. */
function input(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    ui,
    build: "npm run build",
    headSha: HEAD,
    ticketBody: "Add a waitlist to full days on `/book`.",
    implementerRoutes: [],
    ...overrides,
  };
}

/**
 * A runner where, unless `overrides` says otherwise, the branch changes a
 * page, everything works and every page answers 200; each call is noted in
 * `calls`, and each line logged in `logs`.
 */
function runner(overrides: Partial<Capturer> = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const capturer: Capturer = {
    changedPaths: async (headSha) => {
      calls.push(`changed-paths ${headSha}`);
      return ["src/pages/book.astro"];
    },
    installBrowser: async () => {
      calls.push("install-browser");
      return "ok";
    },
    build: async (command) => {
      calls.push(`build ${command}`);
      return "ok";
    },
    freePort: async (url) => {
      calls.push(`free-port ${url}`);
      return true;
    },
    serve: async (command, url) => {
      calls.push(`serve ${command} at ${url}`);
      return "answered";
    },
    screenshot: async (shot) => {
      calls.push(`screenshot ${shot.url} at ${shot.viewport.name} as ${shot.image}`);
      return 200;
    },
    stop: async () => {
      calls.push("stop");
    },
    now: () => 0,
    log: (line) => {
      logs.push(line);
    },
    ...overrides,
  };
  return { capturer, calls, logs };
}

/** The capture result of a capture that failed for this reason. */
function failed(reason: CaptureFailure, captures: readonly Capture[] = []) {
  return { kind: "recorded", result: { outcome: "failed", reason, headSha: HEAD, captures } };
}

describe("Capturing UI evidence", () => {
  it("captures nothing without a ui block, so Visual evidence is off, and touches nothing on the runner", async () => {
    const { capturer, calls } = runner();

    expect(await captureEvidence(input({ ui: null }), capturer)).toEqual({ kind: "off" });
    expect(calls).toEqual([]);
  });

  it("captures nothing when the branch changes no ui.paths file against the default branch", async () => {
    const { capturer, calls } = runner({ changedPaths: async () => ["src/lib/booking.ts", "README.md"] });

    expect(await captureEvidence(input(), capturer)).toEqual({
      kind: "skipped",
      why: "the branch changes no file that ui.paths marks as UI",
    });
    // Nothing installed, built, served or screenshotted.
    expect(calls).toEqual([]);
  });

  it("captures nothing when the Implementer made no commit", async () => {
    const { capturer, calls } = runner();

    expect(await captureEvidence(input({ headSha: null }), capturer)).toEqual({ kind: "skipped", why: "the Implementer made no commit" });
    expect(calls).toEqual([]);
  });

  it("records no-routes when neither the Ticket nor the Implementer names a route and there's no default, before building anything", async () => {
    const { capturer, calls } = runner();
    const bare = input({ ticketBody: "Make the booking page friendlier.", ui: { ...ui, defaultRoutes: [] } });

    expect(await captureEvidence(bare, capturer)).toEqual(failed("no-routes"));
    expect(calls).toEqual([`changed-paths ${HEAD}`]);
  });

  it("builds and serves the branch, then screenshots each route at mobile then desktop, After from the branch and Before from production", async () => {
    const { capturer, calls } = runner();

    expect(await captureEvidence(input(), capturer)).toEqual({
      kind: "recorded",
      result: {
        outcome: "captured",
        headSha: HEAD,
        captures: [
          { route: "/book", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-1-book.png" },
          { route: "/book", reason: "ticket", viewport: "desktop", side: "after", status: 200, image: "after-desktop-1-book.png" },
          { route: "/book", reason: "ticket", viewport: "mobile", side: "before", status: 200, image: "before-mobile-1-book.png" },
          { route: "/book", reason: "ticket", viewport: "desktop", side: "before", status: 200, image: "before-desktop-1-book.png" },
        ],
      },
    });
    expect(calls).toEqual([
      `changed-paths ${HEAD}`,
      "install-browser",
      "build npm run build",
      "free-port http://127.0.0.1:4321",
      "serve node ./dist/server/entry.mjs at http://127.0.0.1:4321",
      "screenshot http://127.0.0.1:4321/book at mobile as after-mobile-1-book.png",
      "screenshot http://127.0.0.1:4321/book at desktop as after-desktop-1-book.png",
      "screenshot https://www.penrithphysio.com.au/book at mobile as before-mobile-1-book.png",
      "screenshot https://www.penrithphysio.com.au/book at desktop as before-desktop-1-book.png",
      "stop",
    ]);
  });

  it.each(["exited", "timed-out"] as const)(
    "records server-did-not-start when the server %s before it answered, and still stops everything it started",
    async (served) => {
      const { capturer, calls } = runner({ serve: async () => served });

      expect(await captureEvidence(input(), capturer)).toEqual(failed("server-did-not-start"));
      expect(calls.filter((call) => call.startsWith("screenshot"))).toEqual([]);
      expect(calls.at(-1)).toBe("stop");
    },
  );

  it("gives the server three minutes to answer and each page a minute to load", async () => {
    const given: string[] = [];
    const { capturer } = runner({
      serve: async (_command, _url, timeoutMs) => {
        given.push(`serve within ${timeoutMs}`);
        return "answered";
      },
      screenshot: async (shot, timeoutMs) => {
        given.push(`${shot.image} within ${timeoutMs}`);
        return 200;
      },
    });

    await captureEvidence(input({ ui: { ...ui, beforeUrl: null } }), capturer);

    expect(given).toEqual(["serve within 180000", "after-mobile-1-book.png within 60000", "after-desktop-1-book.png within 60000"]);
  });

  // Capture's step times out at 20 minutes; its own 18 leave time to write what it took.
  it("records timeout when the build runs past capture's own 18 minutes, and stops it", async () => {
    const given: number[] = [];
    const { capturer, calls } = runner({
      build: async (_command, timeoutMs) => {
        given.push(timeoutMs);
        return "timed-out";
      },
    });

    expect(await captureEvidence(input(), capturer)).toEqual(failed("timeout"));
    expect(given).toEqual([18 * 60_000]);
    expect(calls.at(-1)).toBe("stop");
  });

  it("records timeout, not server-did-not-start, when its own time runs out while the server starts", async () => {
    let clock = 0;
    const { capturer } = runner({
      now: () => clock,
      build: async () => {
        clock = 17 * 60_000;
        return "ok";
      },
      serve: async (_command, _url, timeoutMs) => {
        clock += timeoutMs;
        return "timed-out";
      },
    });

    expect(await captureEvidence(input(), capturer)).toEqual(failed("timeout"));
  });

  it("records timeout, keeping the screenshots it took, when its time runs out between pages", async () => {
    let clock = 0;
    const { capturer } = runner({
      now: () => clock,
      screenshot: async () => {
        clock += 7 * 60_000;
        return 200;
      },
    });

    expect(await captureEvidence(input(), capturer)).toEqual(
      failed("timeout", [
        { route: "/book", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-1-book.png" },
        { route: "/book", reason: "ticket", viewport: "desktop", side: "after", status: 200, image: "after-desktop-1-book.png" },
        { route: "/book", reason: "ticket", viewport: "mobile", side: "before", status: 200, image: "before-mobile-1-book.png" },
      ]),
    );
  });

  it("records timeout, keeping the screenshots it took, when a page doesn't load within its minute", async () => {
    const { capturer } = runner({ screenshot: async (shot) => (shot.side === "before" ? "timed-out" : 200) });

    expect(await captureEvidence(input(), capturer)).toEqual(
      failed("timeout", [
        { route: "/book", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-1-book.png" },
        { route: "/book", reason: "ticket", viewport: "desktop", side: "after", status: 200, image: "after-desktop-1-book.png" },
      ]),
    );
  });

  it("records build-failed when sandbox.build fails, and serves nothing", async () => {
    const { capturer, calls } = runner({ build: async () => "failed" });

    expect(await captureEvidence(input(), capturer)).toEqual(failed("build-failed"));
    expect(calls).toEqual([`changed-paths ${HEAD}`, "install-browser", "stop"]);
  });

  it("serves the checkout as it is when Kit config sets no sandbox.build", async () => {
    const { capturer, calls } = runner();

    expect(await captureEvidence(input({ build: null }), capturer)).toMatchObject({ result: { outcome: "captured" } });
    expect(calls.slice(0, 4)).toEqual([
      `changed-paths ${HEAD}`,
      "install-browser",
      "free-port http://127.0.0.1:4321",
      "serve node ./dist/server/entry.mjs at http://127.0.0.1:4321",
    ]);
  });

  it("records error, keeping the screenshots it took first, when a page fails to load, and logs why", async () => {
    const { capturer, calls, logs } = runner({
      screenshot: async (shot) => {
        if (shot.side === "before") throw new Error("net::ERR_NAME_NOT_RESOLVED at https://www.penrithphysio.com.au/book");
        return 200;
      },
    });

    expect(await captureEvidence(input(), capturer)).toEqual(
      failed("error", [
        { route: "/book", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-1-book.png" },
        { route: "/book", reason: "ticket", viewport: "desktop", side: "after", status: 200, image: "after-desktop-1-book.png" },
      ]),
    );
    expect(logs.join("\n")).toContain("net::ERR_NAME_NOT_RESOLVED at https://www.penrithphysio.com.au/book");
    expect(calls.at(-1)).toBe("stop");
  });

  it("records error when the browser won't install, and builds nothing", async () => {
    const { capturer, calls, logs } = runner({ installBrowser: async () => "failed" });

    expect(await captureEvidence(input(), capturer)).toEqual(failed("error"));
    expect(calls).toEqual([`changed-paths ${HEAD}`, "stop"]);
    expect(logs.join("\n")).toContain("browser");
  });

  it("records error when it can't tell what the branch changes", async () => {
    const { capturer, logs } = runner({
      changedPaths: async () => {
        throw new Error("fatal: bad revision 'origin/main...HEAD'");
      },
    });

    expect(await captureEvidence(input(), capturer)).toEqual(failed("error"));
    expect(logs.join("\n")).toContain("fatal: bad revision");
  });

  // A server the agent left on ui.url would be captured in the branch's place.
  it("records error rather than capture a stale server, when something still answers on ui.url's port once freed", async () => {
    const { capturer, calls, logs } = runner({ freePort: async () => false });

    expect(await captureEvidence(input(), capturer)).toEqual(failed("error"));
    expect(calls.some((call) => call.startsWith("serve") || call.startsWith("screenshot"))).toBe(false);
    expect(logs.join("\n")).toContain("http://127.0.0.1:4321");
  });

  it("names each screenshot a plain file by its side, viewport and route, unique even for routes that read alike, as the capture result reads it back", async () => {
    const { capturer } = runner();
    const long = `/${"treatments/".repeat(8)}dry-needling`;
    const body = `Touch \`/\`, \`/services/physio\`, \`/services-physio\`, \`/Book?step=2#top\` and \`${long}\`.`;

    const outcome = await captureEvidence(input({ ticketBody: body, ui: { ...ui, beforeUrl: null } }), capturer);

    const result = outcome.kind === "recorded" ? outcome.result : null;
    expect(result?.captures.filter(({ viewport }) => viewport === "mobile").map(({ image }) => image)).toEqual([
      "after-mobile-1-root.png",
      "after-mobile-2-services-physio.png",
      "after-mobile-3-services-physio.png",
      "after-mobile-4-book-step-2-top.png",
      "after-mobile-5-treatments-treatments-treatments-treatme.png",
    ]);
    expect(parseCaptureResult(JSON.stringify(result))).toEqual({ ok: true, result });
  });

  it("captures the Implementer's routes when the Ticket names none, under ui.url's path, and takes no Before without ui.before_url", async () => {
    const { capturer, calls } = runner();
    const served = input({
      ticketBody: "Let a patient join a waitlist.",
      implementerRoutes: ["/book/waitlist"],
      ui: { ...ui, url: "http://127.0.0.1:4321/clinic/", beforeUrl: null },
    });

    expect(await captureEvidence(served, capturer)).toEqual({
      kind: "recorded",
      result: {
        outcome: "captured",
        headSha: HEAD,
        captures: [
          { route: "/book/waitlist", reason: "implementer", viewport: "mobile", side: "after", status: 200, image: "after-mobile-1-book-waitlist.png" },
          { route: "/book/waitlist", reason: "implementer", viewport: "desktop", side: "after", status: 200, image: "after-desktop-1-book-waitlist.png" },
        ],
      },
    });
    expect(calls.filter((call) => call.startsWith("screenshot"))).toEqual([
      "screenshot http://127.0.0.1:4321/clinic/book/waitlist at mobile as after-mobile-1-book-waitlist.png",
      "screenshot http://127.0.0.1:4321/clinic/book/waitlist at desktop as after-desktop-1-book-waitlist.png",
    ]);
  });

  // The evidence section and the gallery flag it; it's still evidence, never a failure.
  it("records a page that answered a server error with its status, and still counts the capture as captured", async () => {
    const { capturer } = runner({ screenshot: async (shot) => (shot.side === "after" ? 500 : 200) });

    const outcome = await captureEvidence(input(), capturer);

    expect(outcome).toMatchObject({ result: { outcome: "captured" } });
    expect(outcome.kind === "recorded" && outcome.result.captures.map(({ side, status }) => `${side} ${status}`)).toEqual([
      "after 500",
      "after 500",
      "before 200",
      "before 200",
    ]);
  });
});

const book: Capture = { route: "/book", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-1-book.png" };
const bookWide: Capture = { ...book, viewport: "desktop", image: "after-desktop-1-book.png" };
const captured: CaptureResult = { outcome: "captured", headSha: HEAD, captures: [book, bookWide] };

describe("What the capture step leaves", () => {
  it("passes the capture result out as one compact JSON line, which reads back as it was", () => {
    const { "ui-evidence": line } = captureStepOutputs({ kind: "recorded", result: captured });

    expect(line).not.toContain("\n");
    expect(line).toBe(JSON.stringify(captured));
    expect(parseCaptureResult(line ?? "")).toEqual({ ok: true, result: captured });
  });

  it.each([
    ["Visual evidence is off", { kind: "off" }],
    ["there was nothing to capture", { kind: "skipped", why: "the Implementer made no commit" }],
  ] as const)("passes out an empty result when %s, so no evidence is uploaded", (_case, outcome) => {
    expect(captureStepOutputs(outcome)).toEqual({ "ui-evidence": "" });
  });

  it("writes the capture result, and a gallery holding every screenshot it took", () => {
    const images = new Map([
      [book.image, Uint8Array.of(1, 2, 3)],
      [bookWide.image, Uint8Array.of(4, 5, 6)],
    ]);

    const files = captureStepFiles(captured, images, 12);

    expect(JSON.parse(files.result)).toEqual(captured);
    expect(files.gallery).toContain("<title>UI evidence for #12 at ccccccc</title>");
    expect(files.gallery).toContain(`src="data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}"`);
    expect(files.gallery).toContain(`src="data:image/png;base64,${Buffer.from([4, 5, 6]).toString("base64")}"`);
  });

  it("writes no gallery for a capture that took no screenshot, only its result", () => {
    const noRoutes: CaptureResult = { outcome: "failed", reason: "no-routes", headSha: HEAD, captures: [] };

    expect(captureStepFiles(noRoutes, new Map(), 12)).toEqual({ result: `${JSON.stringify(noRoutes, null, 2)}\n`, gallery: null });
  });

  // Without a ui block, the Kit job's step summary has the quiet line instead (src/kit/kitJob.ts).
  it.each([
    ["Visual evidence is off", { kind: "off" }, null],
    [
      "nothing was captured",
      { kind: "skipped", why: "the branch changes no file that ui.paths marks as UI" },
      "### UI evidence\n\nNothing was captured: the branch changes no file that ui.paths marks as UI.\n",
    ],
    ["it captured", { kind: "recorded", result: captured }, "### UI evidence\n\nCaptured 2 screenshots of 1 route at `ccccccc`.\n"],
    [
      "capture failed",
      { kind: "recorded", result: { outcome: "failed", reason: "server-did-not-start", headSha: HEAD, captures: [] } },
      "### UI evidence\n\nCapture failed (`server-did-not-start`) after 0 screenshots; its log says where it stopped.\n",
    ],
  ] satisfies [string, CaptureOutcome, string | null][])("sums up in the step summary when %s", (_case, outcome, summary) => {
    expect(captureStepSummary(outcome)).toBe(summary);
  });
});

describe("The env sandbox.build and ui.serve run with", () => {
  it("is the runner's with Kit config's sandbox.env, but never the Claude token, the 1Password step's outputs or a GitHub token", () => {
    const runnerEnv = {
      PATH: "/usr/bin",
      HOME: "/home/runner",
      FABRIK_SECRETS: '{"CLAUDE_CODE_OAUTH_TOKEN":"sk-ant-oat01-secret"}',
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-secret",
      GH_TOKEN: "ghs_secret",
      GITHUB_TOKEN: "ghs_secret",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret",
      ACTIONS_RUNTIME_TOKEN: "secret",
      NODE_ENV: "development",
      UNSET: undefined,
    };

    expect(buildAndServeEnv(runnerEnv, { NODE_ENV: "production", PUBLIC_SITE: "https://example.com", GH_TOKEN: "ghp_operator" })).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      NODE_ENV: "production",
      PUBLIC_SITE: "https://example.com",
    });
  });
});

describe("The Implement job's timeout", () => {
  // The agent step stops at the role's own timeout, so a slow capture can never cancel the job before its result uploads.
  it("is the Implement role's timeout, plus capture's 20 minutes, plus 10 for the job's other steps", () => {
    expect(implementJobTimeoutMinutes(60)).toBe(90);
    expect(implementJobTimeoutMinutes(45)).toBe(75);
  });
});

