import { describe, expect, it } from "vitest";
import { captureStepFiles, prototypeCaptureFiles } from "../evidence/capture.ts";
import type { Capture, VariantCapture } from "../evidence/uiEvidence.ts";
import {
  aMergedLastDay,
  CAPTURE_RESULT_FILE,
  type CaptureResult,
  type CaptureResultRead,
  DEFAULT_KIT_CONFIG,
  homeFactsOf,
  parseCaptureResult,
  productionPageUrl,
  rowsOf,
} from "./index.ts";

const HEAD = "a".repeat(40);

/** A value as a reader gets it back after writing it as JSON and reading it again. */
function roundTripped(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

describe("A capture result read through the read library (#670)", () => {
  it("gives a pull request's captures as the capture's writer wrote them, every shot with its route, viewport, side, status, image and Capture identity, and the head commit", () => {
    const written: CaptureResult<Capture> = {
      outcome: "captured",
      headSha: HEAD,
      captures: [
        { route: "/book", reason: "ticket", viewport: "mobile", side: "before", status: 200, image: "before-mobile-book.png", identity: "owner" },
        { route: "/book", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-book.png", identity: "owner" },
        { route: "/cart", reason: "default", viewport: "desktop", side: "after", status: 503, image: "after-desktop-cart.png" },
      ],
    };
    const text = captureStepFiles(written, new Map(), 7).result;

    const read = parseCaptureResult(text);

    expect(read).toEqual({
      ok: true,
      result: {
        outcome: "captured",
        headSha: HEAD,
        captures: [
          { route: "/book", reason: "ticket", viewport: "mobile", side: "before", status: 200, image: "before-mobile-book.png", identity: "owner" },
          { route: "/book", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-book.png", identity: "owner" },
          { route: "/cart", reason: "default", viewport: "desktop", side: "after", status: 503, image: "after-desktop-cart.png" },
        ],
      },
    });
    expect(roundTripped(read)).toStrictEqual(read);
  });

  it("gives a Prototype's captures with each variant's letter, its image, and its video where one was recorded", () => {
    const written: CaptureResult<VariantCapture> = {
      outcome: "captured",
      headSha: HEAD,
      captures: [
        { route: "/book", variant: "A", viewport: "mobile", status: 200, image: "variant-a-mobile.png", video: "variant-a-mobile.webm" },
        { route: "/book", variant: "B", viewport: "mobile", status: 200, image: "variant-b-mobile.png" },
      ],
    };
    const text = prototypeCaptureFiles(written, new Map(), [], { issue: 21, route: "/book" }).result;

    const read = parseCaptureResult(text);

    expect(read).toEqual({
      ok: true,
      result: {
        outcome: "captured",
        headSha: HEAD,
        captures: [
          { route: "/book", variant: "A", viewport: "mobile", status: 200, image: "variant-a-mobile.png", video: "variant-a-mobile.webm" },
          { route: "/book", variant: "B", viewport: "mobile", status: 200, image: "variant-b-mobile.png" },
        ],
      },
    });
    expect(roundTripped(read)).toStrictEqual(read);
  });

  it("reads a capture result an earlier release wrote, with no Capture identity and no missed shots", () => {
    // As v1.0.1's capture step wrote it, before sign-ins (ADR-0012) and before it went on past a missed shot.
    const text = JSON.stringify(
      {
        outcome: "failed",
        reason: "timeout",
        headSha: HEAD,
        captures: [{ route: "/", reason: "default", viewport: "desktop", side: "after", status: 200, image: "after-desktop-root.png" }],
      },
      null,
      2,
    );

    expect(parseCaptureResult(text)).toEqual({
      ok: true,
      result: {
        outcome: "failed",
        reason: "timeout",
        headSha: HEAD,
        captures: [{ route: "/", reason: "default", viewport: "desktop", side: "after", status: 200, image: "after-desktop-root.png" }],
      },
    });
  });

  it.each([
    ["an HTML page", "<html>Not Found</html>"],
    ["nothing", ""],
    ["JSON that is not an object", "null"],
    ["an object of another kind", '{ "run": 4410, "artifact": 901 }'],
    ["a capture that is not an object", JSON.stringify({ outcome: "captured", headSha: HEAD, captures: [null, 7] })],
  ])("returns %s unreadable, saying why, and throws nothing", (_what, text) => {
    let read: CaptureResultRead | undefined;

    expect(() => {
      read = parseCaptureResult(text);
    }).not.toThrow();
    expect(read).toEqual({ ok: false, errors: expect.arrayContaining([expect.any(String)]) });
    expect(roundTripped(read)).toStrictEqual(read);
  });

  it("names the file a reader looks for in a captures artifact, the one name capture writes it under and the Reviewer reads", async () => {
    const capture = await import("../evidence/capture.ts");

    expect(CAPTURE_RESULT_FILE).toBe("capture-result.json");
    // One constant, beside its reader: the capture step and the Reviewer import it from there too.
    expect(Object.keys(capture)).not.toContain("CAPTURE_RESULT_FILE");
  });
});

describe("A page's production address built through the read library (#670)", () => {
  const NOW = "2026-11-08T20:00:00Z";
  const ROUTES = ["/book", "/cart?step=2"];

  /** The facts of pull request 50, merged half an hour ago with these routes captured, in a repo whose Kit config has this `production` block. */
  function mergedWith(production: { url: string; environment: string | null }) {
    const kit = homeFactsOf().kit;
    return homeFactsOf({
      kit: { ...kit, config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, production } } },
      mergedLastDay: [aMergedLastDay("2026-11-08T19:30:00Z")],
      evidenceMarkers: [{ pullRequest: 50, marker: { run: 4400, artifact: 900, failure: null, routes: ROUTES } }],
    });
  }

  it.each([
    [{ url: "https://shop.example", environment: "production" }, ["https://shop.example/book", "https://shop.example/cart?step=2"]],
    [{ url: "https://example.dev/shop/", environment: null }, ["https://example.dev/shop/book", "https://example.dev/shop/cart?step=2"]],
  ])("gives for %o each route's address, the one the merged row's pages carry", (production, addresses) => {
    const [row] = rowsOf(mergedWith(production), null, null, null, NOW);

    expect(ROUTES.map((route) => productionPageUrl(production, route))).toEqual(addresses);
    expect(row?.production?.pages).toEqual(ROUTES.map((route, at) => ({ route, url: addresses[at] })));
  });
});
