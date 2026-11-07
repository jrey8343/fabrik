// Capturing a prototype turn's variants (#155), once its agent has ended:
// every decision the capture step makes, behind the Capturer, which a fake
// stands in for here. The Playwright shell is the Pilot's to exercise.
import { describe, expect, it } from "vitest";
import type { UiConfig } from "../kit/config.ts";
import {
  type Capturer,
  captureStepOutputs,
  type PrototypeCaptureInput,
  capturePrototype,
  prototypeCaptureFiles,
  prototypeCaptureSummary,
} from "./capture.ts";
import { type CaptureFailure, type CaptureResult, parseCaptureResult, type VariantCapture } from "./uiEvidence.ts";

const HEAD = "c".repeat(40);

/** The Pilot's ui block: an Astro site served from its build. */
const ui: UiConfig = {
  paths: ["src/**/*.astro"],
  serve: "node ./dist/server/entry.mjs",
  url: "http://127.0.0.1:4321/",
  beforeUrl: "https://www.penrithphysio.com.au",
  defaultRoutes: ["/"],
};

/** A prototype turn of 3 variants of `/book` that committed them. */
function input(overrides: Partial<PrototypeCaptureInput> = {}): PrototypeCaptureInput {
  return { ui, build: "npm run build", headSha: HEAD, route: "/book", variants: ["A", "B", "C"], ...overrides };
}

/** A runner where, unless `overrides` says otherwise, everything works, every page answers 200 and every video is saved; each call is noted. */
function runner(overrides: Partial<Capturer> = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const capturer: Capturer = {
    changedPaths: async (headSha) => {
      calls.push(`changed-paths ${headSha}`);
      return [];
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
      calls.push(`screenshot ${shot.url}`);
      return 200;
    },
    recordVariant: async (take) => {
      calls.push(`record ${take.url} at ${take.viewport.name} as ${take.image} and ${take.video}`);
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

const variantA: VariantCapture = { route: "/book", variant: "A", viewport: "mobile", status: 200, image: "variant-a-mobile.png", video: "variant-a-mobile.webm" };
const variantAWide: VariantCapture = { ...variantA, viewport: "desktop", image: "variant-a-desktop.png", video: "variant-a-desktop.webm" };

function failed(reason: CaptureFailure, captures: readonly VariantCapture[] = []) {
  return { kind: "recorded", result: { outcome: "failed", reason, headSha: HEAD, captures } };
}

describe("Capturing a prototype turn's variants", () => {
  it("captures nothing without a ui block, and touches nothing on the runner", async () => {
    const { capturer, calls } = runner();

    expect(await capturePrototype(input({ ui: null }), capturer)).toEqual({ kind: "off" });
    expect(calls).toEqual([]);
  });

  it("captures nothing when the prototype turn made no commit, so there is nothing new to look at", async () => {
    const { capturer, calls } = runner();

    expect(await capturePrototype(input({ headSha: null }), capturer)).toEqual({ kind: "skipped", why: "the prototype turn made no commit" });
    expect(calls).toEqual([]);
  });

  it("records no-variants when the turn's output named none, before building anything", async () => {
    const { capturer, calls } = runner();

    expect(await capturePrototype(input({ variants: [] }), capturer)).toEqual(failed("no-variants"));
    expect(calls).toEqual([]);
  });

  it("builds and serves the branch, then screenshots and films each variant at its route with ?variant= and its letter, at mobile then desktop", async () => {
    const { capturer, calls } = runner();

    expect(await capturePrototype(input({ variants: ["A", "B"] }), capturer)).toEqual({
      kind: "recorded",
      result: {
        outcome: "captured",
        headSha: HEAD,
        captures: [
          variantA,
          variantAWide,
          { route: "/book", variant: "B", viewport: "mobile", status: 200, image: "variant-b-mobile.png", video: "variant-b-mobile.webm" },
          { route: "/book", variant: "B", viewport: "desktop", status: 200, image: "variant-b-desktop.png", video: "variant-b-desktop.webm" },
        ],
      },
    });
    expect(calls).toEqual([
      "install-browser",
      "build npm run build",
      "free-port http://127.0.0.1:4321/",
      "serve node ./dist/server/entry.mjs at http://127.0.0.1:4321/",
      "record http://127.0.0.1:4321/book?variant=A at mobile as variant-a-mobile.png and variant-a-mobile.webm",
      "record http://127.0.0.1:4321/book?variant=A at desktop as variant-a-desktop.png and variant-a-desktop.webm",
      "record http://127.0.0.1:4321/book?variant=B at mobile as variant-b-mobile.png and variant-b-mobile.webm",
      "record http://127.0.0.1:4321/book?variant=B at desktop as variant-b-desktop.png and variant-b-desktop.webm",
      "stop",
    ]);
  });

  it("keeps a variant's screenshot without a video when its video wasn't saved, and still counts the capture as captured", async () => {
    const { capturer } = runner({ recordVariant: async () => ({ status: 200, video: false }) });

    const outcome = await capturePrototype(input({ variants: ["A", "B"] }), capturer);

    expect(outcome).toMatchObject({ kind: "recorded", result: { outcome: "captured" } });
    const captures = outcome.kind === "recorded" ? outcome.result.captures : [];
    expect(captures).toHaveLength(4);
    for (const capture of captures) expect(capture).not.toHaveProperty("video");
  });

  it("serves the checkout as it is when Kit config sets no sandbox.build", async () => {
    const { capturer, calls } = runner();

    await capturePrototype(input({ build: null }), capturer);

    expect(calls.filter((call) => call.startsWith("build"))).toEqual([]);
  });

  it("gives the server three minutes to answer and each variant's take a minute and a half", async () => {
    const given: string[] = [];
    const { capturer } = runner({
      serve: async (_command, _url, timeoutMs) => {
        given.push(`serve within ${timeoutMs}`);
        return "answered";
      },
      recordVariant: async (take, timeoutMs) => {
        given.push(`${take.variant} at ${take.viewport.name} within ${timeoutMs}`);
        return { status: 200, video: true };
      },
    });

    await capturePrototype(input({ variants: ["A", "B"] }), capturer);

    expect(given).toEqual(["serve within 180000", "A at mobile within 90000", "A at desktop within 90000", "B at mobile within 90000", "B at desktop within 90000"]);
  });

  it("records build-failed when sandbox.build fails, and serves nothing", async () => {
    const { capturer, calls } = runner({ build: async () => "failed" });

    expect(await capturePrototype(input(), capturer)).toEqual(failed("build-failed"));
    expect(calls.filter((call) => call.startsWith("serve") || call.startsWith("record"))).toEqual([]);
    expect(calls.at(-1)).toBe("stop");
  });

  it.each(["exited", "timed-out"] as const)("records server-did-not-start when the server %s before it answered", async (served) => {
    const { capturer, calls } = runner({ serve: async () => served });

    expect(await capturePrototype(input(), capturer)).toEqual(failed("server-did-not-start"));
    expect(calls.filter((call) => call.startsWith("record"))).toEqual([]);
    expect(calls.at(-1)).toBe("stop");
  });

  it("records timeout, keeping the takes it finished, when a variant's page doesn't load within its time", async () => {
    let takes = 0;
    const { capturer } = runner({ recordVariant: async () => (++takes > 2 ? "timed-out" : { status: 200, video: true }) });

    expect(await capturePrototype(input(), capturer)).toEqual(failed("timeout", [variantA, variantAWide]));
  });

  it("records timeout, keeping the takes it finished, when its own 18 minutes run out between takes", async () => {
    let clock = 0;
    const { capturer } = runner({
      now: () => clock,
      recordVariant: async () => {
        clock += 9 * 60_000;
        return { status: 200, video: true };
      },
    });

    expect(await capturePrototype(input(), capturer)).toEqual(failed("timeout", [variantA, variantAWide]));
  });

  it("records error, keeping the takes it finished first, when a take fails, and logs why", async () => {
    let takes = 0;
    const { capturer, logs } = runner({
      recordVariant: async () => {
        if (++takes > 2) throw new Error("page crashed");
        return { status: 200, video: true };
      },
    });

    expect(await capturePrototype(input(), capturer)).toEqual(failed("error", [variantA, variantAWide]));
    expect(logs).toContain("Capture failed: page crashed");
  });

  it("records a variant that answered a server error with its status, and still counts the capture as captured", async () => {
    const { capturer } = runner({ recordVariant: async (take) => ({ status: take.variant === "B" ? 500 : 200, video: true }) });

    const outcome = await capturePrototype(input({ variants: ["A", "B"] }), capturer);

    expect(outcome).toMatchObject({ kind: "recorded", result: { outcome: "captured" } });
    expect(outcome.kind === "recorded" ? outcome.result.captures.map(({ status }) => status) : []).toEqual([200, 200, 500, 500]);
  });

  it("records a result the shared capture contract reads back as variant captures", async () => {
    const { capturer } = runner();

    const outcome = await capturePrototype(input(), capturer);
    if (outcome.kind !== "recorded") throw new Error("nothing recorded");

    expect(parseCaptureResult(JSON.stringify(outcome.result))).toEqual({ ok: true, result: outcome.result });
  });
});

describe("What a prototype turn's capture step leaves", () => {
  const captured: CaptureResult<VariantCapture> = { outcome: "captured", headSha: HEAD, captures: [variantA, variantAWide] };
  const meta = { issue: 7, route: "/book" };
  const variants = [
    { letter: "A", summary: "A calendar of the month.", component: "src/components/prototype/BookVariantA.astro" },
    { letter: "B", summary: "A list of the next open times.", component: "src/components/prototype/BookVariantB.astro" },
  ];

  it("passes the capture result out as one compact JSON line, which reads back as it was", () => {
    const { "ui-capture-result": line } = captureStepOutputs({ kind: "recorded", result: captured });

    expect(line).not.toContain("\n");
    expect(parseCaptureResult(line ?? "")).toEqual({ ok: true, result: captured });
  });

  it("writes the capture result, and the prototype gallery of every variant under its summary, with each screenshot and video it took", () => {
    const files = new Map([
      [variantA.image, Uint8Array.of(1, 2, 3)],
      [variantA.video!, Uint8Array.of(4, 5, 6)],
      [variantAWide.image, Uint8Array.of(7, 8, 9)],
    ]);

    const written = prototypeCaptureFiles(captured, files, variants, meta);

    expect(JSON.parse(written.result)).toEqual(captured);
    expect(written.gallery).toContain("<title>Prototype of /book for #7 at ccccccc</title>");
    expect(written.gallery).toContain("<p>A list of the next open times.</p>");
    expect(written.gallery).toContain(`src="data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}"`);
    expect(written.gallery).toContain(`src="data:video/webm;base64,${Buffer.from([4, 5, 6]).toString("base64")}"`);
    expect(written.gallery).toContain(`src="data:image/png;base64,${Buffer.from([7, 8, 9]).toString("base64")}"`);
    // The desktop video was named but never written, so the gallery shows its screenshot alone.
    expect(written.gallery?.match(/<video /g)).toHaveLength(1);
  });

  it("writes no gallery for a capture that took no screenshot, only its result", () => {
    const none: CaptureResult<VariantCapture> = { outcome: "failed", reason: "server-did-not-start", headSha: HEAD, captures: [] };

    expect(prototypeCaptureFiles(none, new Map(), variants, meta)).toEqual({ result: `${JSON.stringify(none, null, 2)}\n`, gallery: null });
  });

  it.each([
    ["there was nothing to capture", { kind: "skipped", why: "the prototype turn made no commit" }, "### Prototype capture\n\nNothing was captured: the prototype turn made no commit.\n"],
    ["it captured", { kind: "recorded", result: captured }, "### Prototype capture\n\nCaptured 1 variant at `ccccccc`: 2 screenshots and 2 videos.\n"],
    [
      "capture failed",
      { kind: "recorded", result: { outcome: "failed", reason: "build-failed", headSha: HEAD, captures: [] } },
      "### Prototype capture\n\nCapture failed (`build-failed`) after 0 screenshots; its log says where it stopped.\n",
    ],
  ] as const)("sums up in the step summary when %s", (_case, outcome, summary) => {
    expect(prototypeCaptureSummary(outcome)).toBe(summary);
  });

  it("says nothing in the step summary without a ui block", () => {
    expect(prototypeCaptureSummary({ kind: "off" })).toBeNull();
  });
});

describe("Capturing a prototype turn's variants behind a sign-in", () => {
  /** The ui block signing in an owner, with /pricing public. */
  const signedIn: UiConfig = {
    ...ui,
    url: "http://localhost:4321",
    signIn: { owner: "pnpm sign-in owner", operator: "pnpm sign-in operator" },
    signInPath: "/sign-in",
    signedInRoutes: [
      { route: "/pricing", as: null },
      { route: "/**", as: "owner" },
    ],
  };

  it("signs in as the approved route's Capture identity, once, and records each take as it, by the same rules as a pull request's capture", async () => {
    const seen: string[] = [];
    const { capturer, calls } = runner({
      recordVariant: async (take) => {
        seen.push(`${take.url} at ${take.viewport.name} as ${take.signedIn?.identity ?? "public"}`);
        return { status: 200, video: true };
      },
    });

    const outcome = await capturePrototype(input({ ui: signedIn, route: "/today", variants: ["A"] }), capturer);

    expect(calls.filter((call) => call.startsWith("sign-in"))).toEqual(["sign-in owner: pnpm sign-in owner"]);
    expect(seen).toEqual(["http://localhost:4321/today?variant=A at mobile as owner", "http://localhost:4321/today?variant=A at desktop as owner"]);
    expect(outcome).toEqual({
      kind: "recorded",
      result: {
        outcome: "captured",
        headSha: HEAD,
        captures: [
          { route: "/today", variant: "A", viewport: "mobile", status: 200, image: "variant-a-mobile.png", video: "variant-a-mobile.webm", identity: "owner" },
          { route: "/today", variant: "A", viewport: "desktop", status: 200, image: "variant-a-desktop.png", video: "variant-a-desktop.webm", identity: "owner" },
        ],
      },
    });
  });

  it("matches the approved route's path alone, so its query changes nothing, and signs nothing in for a public route", async () => {
    const { capturer, calls } = runner();

    const outcome = await capturePrototype(input({ ui: signedIn, route: "/pricing?plan=pro", variants: ["A"] }), capturer);

    expect(calls.some((call) => call.startsWith("sign-in"))).toBe(false);
    expect(outcome.kind === "recorded" && outcome.result.captures.every((capture) => !("identity" in capture))).toBe(true);
  });

  it("records sign-in-failed with no takes when the sign-in fails", async () => {
    const { capturer, calls } = runner({ signIn: async () => "no-state" });

    expect(await capturePrototype(input({ ui: signedIn, route: "/today" }), capturer)).toEqual(failed("sign-in-failed"));
    expect(calls.some((call) => call.startsWith("record"))).toBe(false);
  });

  it("records sign-in-failed, keeping the takes before it, when a take lands on ui.sign_in_path", async () => {
    const { capturer } = runner({ recordVariant: async (take) => (take.variant === "B" ? "on-sign-in" : { status: 200, video: true }) });

    expect(await capturePrototype(input({ ui: signedIn, route: "/today", variants: ["A", "B"] }), capturer)).toEqual(
      failed("sign-in-failed", [
        { route: "/today", variant: "A", viewport: "mobile", status: 200, image: "variant-a-mobile.png", video: "variant-a-mobile.webm", identity: "owner" },
        { route: "/today", variant: "A", viewport: "desktop", status: 200, image: "variant-a-desktop.png", video: "variant-a-desktop.webm", identity: "owner" },
      ]),
    );
  });
});
