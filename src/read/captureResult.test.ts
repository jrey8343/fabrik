import { describe, expect, it } from "vitest";
import { captureStepFiles, prototypeCaptureFiles } from "../evidence/capture.ts";
import type { Capture, VariantCapture } from "../evidence/uiEvidence.ts";
import { type CaptureResult, parseCaptureResult } from "./index.ts";

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
});
