import { describe, expect, it } from "vitest";
import type { UiConfig } from "../kit/config.ts";
import { buildAndServeEnv, type CaptureInput, isOnSignInPath, isStorageState, type CaptureOutcome, type Capturer, captureEvidence, captureStepFiles, captureStepOutputs, captureStepSummary, implementerRoutesIn, implementJobTimeoutMinutes, servedAt } from "./capture.ts";
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
    recordVariant: async (take) => {
      calls.push(`record ${take.url} at ${take.viewport.name}`);
      return { status: 200, video: true };
    },
    signIn: async (identity, command) => {
      calls.push(`sign-in ${identity}: ${command}`);
      return "signed-in";
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

  it("goes on past a Before page that won't load, keeping every After, and names the side, URL and error of each it missed", async () => {
    const { capturer, calls, logs } = runner({
      screenshot: async (shot) => {
        calls.push(`screenshot ${shot.url} at ${shot.viewport.name}`);
        return shot.side === "before" ? { unreachable: "ERR_CONNECTION_REFUSED" } : 200;
      },
    });

    expect(await captureEvidence(input({ implementerRoutes: ["/"] }), capturer)).toEqual({
      kind: "recorded",
      result: {
        outcome: "captured",
        headSha: HEAD,
        captures: [
          { route: "/book", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-1-book.png" },
          { route: "/book", reason: "ticket", viewport: "desktop", side: "after", status: 200, image: "after-desktop-1-book.png" },
          { route: "/", reason: "implementer", viewport: "mobile", side: "after", status: 200, image: "after-mobile-2-root.png" },
          { route: "/", reason: "implementer", viewport: "desktop", side: "after", status: 200, image: "after-desktop-2-root.png" },
        ],
        missed: [
          { route: "/book", reason: "ticket", viewport: "mobile", side: "before", url: "https://www.penrithphysio.com.au/book", why: "before-unreachable", error: "ERR_CONNECTION_REFUSED" },
          { route: "/book", reason: "ticket", viewport: "desktop", side: "before", url: "https://www.penrithphysio.com.au/book", why: "before-unreachable", error: "ERR_CONNECTION_REFUSED" },
          { route: "/", reason: "implementer", viewport: "mobile", side: "before", url: "https://www.penrithphysio.com.au/", why: "before-unreachable", error: "ERR_CONNECTION_REFUSED" },
          { route: "/", reason: "implementer", viewport: "desktop", side: "before", url: "https://www.penrithphysio.com.au/", why: "before-unreachable", error: "ERR_CONNECTION_REFUSED" },
        ],
      },
    });
    // Every Before was tried, not just the first.
    expect(calls.filter((call) => call.startsWith("screenshot https://www.penrithphysio.com.au"))).toHaveLength(4);
    expect(logs.join("\n")).toContain("(before-unreachable) https://www.penrithphysio.com.au/book at mobile: ERR_CONNECTION_REFUSED");
  });

  it("goes on past an After page that won't load to the later routes' screenshots", async () => {
    const { capturer } = runner({
      screenshot: async (shot) => (shot.side === "after" && shot.route === "/book" ? { unreachable: "ERR_TOO_MANY_REDIRECTS" } : 200),
    });

    const outcome = await captureEvidence(input({ implementerRoutes: ["/"] }), capturer);

    expect(outcome).toMatchObject({ result: { outcome: "captured" } });
    const result = outcome.kind === "recorded" ? outcome.result : null;
    expect(result?.captures.map(({ route, side, viewport }) => `${side} ${route} ${viewport}`)).toEqual([
      "after / mobile",
      "after / desktop",
      "before /book mobile",
      "before /book desktop",
      "before / mobile",
      "before / desktop",
    ]);
    expect(result?.missed?.map(({ why, url, viewport }) => `${why} ${url} ${viewport}`)).toEqual([
      "after-unreachable http://127.0.0.1:4321/book mobile",
      "after-unreachable http://127.0.0.1:4321/book desktop",
    ]);
  });

  it("records unreachable when no page it went to would load, so it took no screenshot", async () => {
    const { capturer } = runner({ screenshot: async () => ({ unreachable: "ERR_NAME_NOT_RESOLVED" }) });

    const outcome = await captureEvidence(input(), capturer);

    expect(outcome).toMatchObject({ result: { outcome: "failed", reason: "unreachable", captures: [] } });
    expect(outcome.kind === "recorded" && outcome.result.missed?.length).toBe(4);
  });

  it("records error, keeping the screenshots it took first, when loading a page throws what the Kit didn't expect, and logs why", async () => {
    const { capturer, calls, logs } = runner({
      screenshot: async (shot) => {
        if (shot.side === "before") throw new Error("Target page, context or browser has been closed");
        return 200;
      },
    });

    expect(await captureEvidence(input(), capturer)).toEqual(
      failed("error", [
        { route: "/book", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-1-book.png" },
        { route: "/book", reason: "ticket", viewport: "desktop", side: "after", status: 200, image: "after-desktop-1-book.png" },
      ]),
    );
    expect(logs.join("\n")).toContain("Target page, context or browser has been closed");
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

  it("keeps the capture it took when stopping the server fails", async () => {
    const { capturer } = runner({
      stop: async () => {
        throw new Error("kill ESRCH");
      },
    });

    expect(await captureEvidence(input(), capturer)).toMatchObject({ kind: "recorded", result: { outcome: "captured" } });
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
const captured: CaptureResult<Capture> = { outcome: "captured", headSha: HEAD, captures: [book, bookWide] };

describe("Capturing UI evidence behind a sign-in", () => {
  /** A ui block like the Pilot's, signing in an owner and an operator against its own server. */
  const signedIn: UiConfig = {
    ...ui,
    url: "http://localhost:4321",
    signIn: { owner: "pnpm sign-in owner", operator: "pnpm sign-in operator" },
    signInPath: "/sign-in",
    signedInRoutes: [
      { route: "/pricing", as: null },
      { route: "/console/**", as: "operator" },
      { route: "/**", as: "owner" },
    ],
  };

  /** A Ticket naming these routes, each in backticks. */
  function naming(...routes: string[]): CaptureInput {
    return input({ ui: signedIn, ticketBody: `Touches ${routes.map((route) => `\`${route}\``).join(" and ")}.` });
  }

  /** A runner noting each screenshot with the Capture identity it's signed in as, or public. */
  function noting(overrides: Partial<Capturer> = {}) {
    const ran = runner(overrides);
    const screenshot = overrides.screenshot ?? (async () => 200);
    ran.capturer.screenshot = async (shot, timeoutMs) => {
      ran.calls.push(`screenshot ${shot.url} at ${shot.viewport.name} as ${shot.signedIn?.identity ?? "public"}${shot.signedIn ? ` (sign-in at ${shot.signedIn.signInPath})` : ""}`);
      return screenshot(shot, timeoutMs);
    };
    return ran;
  }

  it("captures exactly as before with no sign-in fields: no sign-in runs, and no capture names an identity", async () => {
    const { capturer, calls } = runner();

    const outcome = await captureEvidence(input(), capturer);

    expect(calls.some((call) => call.startsWith("sign-in"))).toBe(false);
    expect(outcome.kind === "recorded" && outcome.result.captures.every((capture) => !("identity" in capture))).toBe(true);
  });

  it("signs in each identity the chosen routes need once, after the server answers and before any shot, then shoots each signed-in route as it", async () => {
    const { capturer, calls } = noting();

    const outcome = await captureEvidence(naming("/today", "/clinics", "/console/users"), capturer);

    expect(calls).toEqual([
      `changed-paths ${HEAD}`,
      "install-browser",
      "build npm run build",
      "free-port http://localhost:4321",
      "serve node ./dist/server/entry.mjs at http://localhost:4321",
      "sign-in owner: pnpm sign-in owner",
      "sign-in operator: pnpm sign-in operator",
      "screenshot http://localhost:4321/today at mobile as owner (sign-in at /sign-in)",
      "screenshot http://localhost:4321/today at desktop as owner (sign-in at /sign-in)",
      "screenshot http://localhost:4321/clinics at mobile as owner (sign-in at /sign-in)",
      "screenshot http://localhost:4321/clinics at desktop as owner (sign-in at /sign-in)",
      "screenshot http://localhost:4321/console/users at mobile as operator (sign-in at /sign-in)",
      "screenshot http://localhost:4321/console/users at desktop as operator (sign-in at /sign-in)",
      "stop",
    ]);
    expect(outcome).toEqual({
      kind: "recorded",
      result: {
        outcome: "captured",
        headSha: HEAD,
        captures: [
          { route: "/today", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-1-today.png", identity: "owner" },
          { route: "/today", reason: "ticket", viewport: "desktop", side: "after", status: 200, image: "after-desktop-1-today.png", identity: "owner" },
          { route: "/clinics", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-2-clinics.png", identity: "owner" },
          { route: "/clinics", reason: "ticket", viewport: "desktop", side: "after", status: 200, image: "after-desktop-2-clinics.png", identity: "owner" },
          { route: "/console/users", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-3-console-users.png", identity: "operator" },
          { route: "/console/users", reason: "ticket", viewport: "desktop", side: "after", status: 200, image: "after-desktop-3-console-users.png", identity: "operator" },
        ],
      },
    });
  });

  it("runs no sign-in for a capture of public routes alone, and takes their Before as usual", async () => {
    const { capturer, calls } = noting();

    const outcome = await captureEvidence(naming("/pricing"), capturer);

    expect(calls.filter((call) => call.startsWith("sign-in"))).toEqual([]);
    expect(calls.filter((call) => call.startsWith("screenshot"))).toEqual([
      "screenshot http://localhost:4321/pricing at mobile as public",
      "screenshot http://localhost:4321/pricing at desktop as public",
      "screenshot https://www.penrithphysio.com.au/pricing at mobile as public",
      "screenshot https://www.penrithphysio.com.au/pricing at desktop as public",
    ]);
    expect(outcome.kind === "recorded" && outcome.result.outcome).toBe("captured");
  });

  it("takes Before for public routes only, and Before is never signed in", async () => {
    const { capturer, calls } = noting();

    await captureEvidence(naming("/today", "/pricing"), capturer);

    expect(calls.filter((call) => call.startsWith("screenshot https://www.penrithphysio.com.au"))).toEqual([
      "screenshot https://www.penrithphysio.com.au/pricing at mobile as public",
      "screenshot https://www.penrithphysio.com.au/pricing at desktop as public",
    ]);
  });

  it("never runs an operator sign-in, failed or not, for a capture whose routes are all the owner's", async () => {
    const signedInAs: string[] = [];
    const { capturer } = noting({
      signIn: async (identity) => {
        signedInAs.push(identity);
        return identity === "operator" ? "failed" : "signed-in";
      },
    });

    const outcome = await captureEvidence(naming("/today"), capturer);

    expect(signedInAs).toEqual(["owner"]);
    expect(outcome.kind === "recorded" && outcome.result.outcome).toBe("captured");
  });

  it.each(["failed", "timed-out", "no-state", "bad-state"] as const)(
    "records sign-in-failed with no screenshots when a sign-in ends %s, and says why in the log",
    async (ended) => {
      const { capturer, calls, logs } = noting({ signIn: async () => ended });

      expect(await captureEvidence(naming("/today"), capturer)).toEqual(failed("sign-in-failed"));
      expect(calls.some((call) => call.startsWith("screenshot"))).toBe(false);
      expect(calls.at(-1)).toBe("stop");
      expect(logs.join("\n")).toContain("signing in as owner");
    },
  );

  it("gives each sign-in three minutes, within capture's budget", async () => {
    const given: number[] = [];
    const { capturer } = noting({
      signIn: async (_identity, _command, timeoutMs) => {
        given.push(timeoutMs);
        return "signed-in";
      },
    });

    await captureEvidence(naming("/today"), capturer);

    expect(given).toEqual([180_000]);
  });

  it("records timeout, not sign-in-failed, when capture's own time runs out while it signs in", async () => {
    let clock = 0;
    const { capturer } = noting({
      now: () => clock,
      serve: async () => {
        clock = 17 * 60_000;
        return "answered";
      },
      signIn: async (_identity, _command, timeoutMs) => {
        clock += timeoutMs;
        return "timed-out";
      },
    });

    expect(await captureEvidence(naming("/today"), capturer)).toEqual(failed("timeout"));
  });

  it("records sign-in-failed when a signed-in shot lands on ui.sign_in_path, keeping the shots before it and none of its own", async () => {
    const { capturer, calls } = noting({ screenshot: async (shot) => (shot.route === "/clinics" ? "on-sign-in" : 200) });

    expect(await captureEvidence(naming("/today", "/clinics", "/console"), capturer)).toEqual(
      failed("sign-in-failed", [
        { route: "/today", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-1-today.png", identity: "owner" },
        { route: "/today", reason: "ticket", viewport: "desktop", side: "after", status: 200, image: "after-desktop-1-today.png", identity: "owner" },
      ]),
    );
    expect(calls.filter((call) => call.startsWith("screenshot")).at(-1)).toBe("screenshot http://localhost:4321/clinics at mobile as owner (sign-in at /sign-in)");
  });

  it("never asks a public shot whether it landed on ui.sign_in_path, so a public route showing the sign-in page fails nothing", async () => {
    // The shell checks the landing only of a shot that names its sign-in path.
    const { capturer } = noting({ screenshot: async (shot) => (shot.signedIn === undefined ? 200 : "on-sign-in") });
    const publicSignIn: UiConfig = { ...signedIn, signedInRoutes: [{ route: "/sign-in", as: null }, ...(signedIn.signedInRoutes ?? [])] };

    const outcome = await captureEvidence(input({ ui: publicSignIn, ticketBody: "Restyle `/sign-in` and `/pricing`." }), capturer);

    expect(outcome.kind === "recorded" && outcome.result.outcome).toBe("captured");
    expect(outcome.kind === "recorded" && outcome.result.captures).toHaveLength(8);
  });
});

describe("What a sign-in leaves, as the Playwright shell checks it", () => {
  it.each([
    [{ cookies: [], origins: [] }, true],
    [{ cookies: [{ name: "session", value: "s", domain: "localhost", path: "/" }], origins: [{ origin: "http://localhost:4321", localStorage: [] }] }, true],
    [{ cookies: [] }, false],
    [{ origins: [] }, false],
    [{ cookies: {}, origins: [] }, false],
    [[], false],
    [null, false],
    ["{}", false],
  ])("reads %j as a storage state: %s", (value, ok) => {
    expect(isStorageState(value)).toBe(ok);
  });

  it.each([
    ["http://localhost:4321/sign-in", "/sign-in", true],
    ["http://localhost:4321/sign-in?next=%2Ftoday", "/sign-in", true],
    ["http://localhost:4321/sign-in/", "/sign-in", true],
    ["http://localhost:4321/today", "/sign-in", false],
    ["http://localhost:4321/sign-in-help", "/sign-in", false],
    ["http://localhost:4321/", "/", true],
  ])("reads landing on %s as landing on ui.sign_in_path %s: %s", (url, path, landed) => {
    expect(isOnSignInPath(url, path)).toBe(landed);
  });
});

describe("What the capture step leaves", () => {
  it("passes the capture result out as one compact JSON line, which reads back as it was", () => {
    const { "ui-capture-result": line } = captureStepOutputs({ kind: "recorded", result: captured });

    expect(line).not.toContain("\n");
    expect(line).toBe(JSON.stringify(captured));
    expect(parseCaptureResult(line ?? "")).toEqual({ ok: true, result: captured });
  });

  it.each([
    ["Visual evidence is off", { kind: "off" }],
    ["there was nothing to capture", { kind: "skipped", why: "the Implementer made no commit" }],
  ] as const)("passes out an empty result when %s, so no evidence is uploaded", (_case, outcome) => {
    expect(captureStepOutputs(outcome)).toEqual({ "ui-capture-result": "" });
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
    const noRoutes: CaptureResult<Capture> = { outcome: "failed", reason: "no-routes", headSha: HEAD, captures: [] };

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

describe("What capture reads before it starts", () => {
  it("takes the Implementer's routes from its output, and none from output that names none or doesn't read", () => {
    const output = (routes: unknown) => JSON.stringify({ title: "Waitlist", summary: "Adds a waitlist.", routes });

    expect(implementerRoutesIn(output(["/book", "/book/waitlist"]))).toEqual(["/book", "/book/waitlist"]);
    expect(implementerRoutesIn(JSON.stringify({ title: "Waitlist", summary: "Adds a waitlist." }))).toEqual([]);
    expect(implementerRoutesIn(output(["book"]))).toEqual([]);
    expect(implementerRoutesIn("not JSON")).toEqual([]);
  });

  it.each([
    ["http://127.0.0.1:4321", { host: "127.0.0.1", port: 4321 }],
    ["http://localhost/clinic/", { host: "localhost", port: 80 }],
    ["https://localhost", { host: "localhost", port: 443 }],
    ["http://[::1]:8080", { host: "::1", port: 8080 }],
  ])("finds the port ui.url %s serves on, to free it of a leftover server", (url, served) => {
    expect(servedAt(url)).toEqual(served);
  });
});

