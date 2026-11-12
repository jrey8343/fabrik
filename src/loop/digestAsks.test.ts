import { describe, expect, it } from "vitest";
import { aRequestChanges } from "../__fixtures__/digests.ts";
import { type DigestThread, digestFactsOf } from "./digestFacts.ts";
import { RETRY_PUSH_MARKER, verdictMarker } from "./markers.ts";

const sha = (letter: string) => letter.repeat(40);
/** A time on the thread's day, by its minute, so a fixture reads in order. */
const at = (minute: number) => `2026-11-02T10:${String(minute).padStart(2, "0")}:00Z`;

const aPass = (minute: number, headSha: string) => ({
  at: at(minute),
  body: `${verdictMarker({ verdict: "pass", source: "reviewer", requestChanges: false, headSha })}\n## Verdict: Pass`,
});

function aThread(overrides: Partial<DigestThread> = {}): DigestThread {
  return { openedAt: at(0), kitComments: [], requestChanges: [], landedNothing: 0, ...overrides };
}

const LINE = (comment: number, path: string, line: number | null = 12) => ({ comment, url: `https://github.com/acme/shop/pull/50#discussion_r${comment}`, path, line });

describe("The asks Kit code lists from a pull request's thread", () => {
  // Two Request changes of the Operator's, the second with two line comments.
  const TWO = [
    aRequestChanges(8, at(20), { body: "Call it a basket." }),
    aRequestChanges(11, at(30), { body: "Two places still say cart.", lineComments: [LINE(12, "src/cart.ts"), LINE(13, "src/checkout.ts", null)] }),
  ];

  it("are every Request changes of the Operator's and every line comment in each, oldest first, a review before its line comments", () => {
    expect(digestFactsOf(aThread({ requestChanges: TWO })).asks).toEqual([
      { id: "review-8", what: "request-changes", url: "https://github.com/acme/shop/pull/50#pullrequestreview-8" },
      { id: "review-11", what: "request-changes", url: "https://github.com/acme/shop/pull/50#pullrequestreview-11" },
      { id: "inline-12", what: "line-comment", url: "https://github.com/acme/shop/pull/50#discussion_r12", path: "src/cart.ts", line: 12 },
      { id: "inline-13", what: "line-comment", url: "https://github.com/acme/shop/pull/50#discussion_r13", path: "src/checkout.ts", line: null },
    ]);
  });

  it("have ids made from GitHub's own ids, so they are the same when the list is built again at a later head", () => {
    const first = digestFactsOf(aThread({ kitComments: [aPass(40, sha("a"))], requestChanges: TWO }));
    const later = digestFactsOf(
      aThread({
        kitComments: [aPass(40, sha("a")), { at: at(50), body: `${RETRY_PUSH_MARKER}\nThe Implementer pushed a fix.` }, aPass(55, sha("b"))],
        requestChanges: TWO,
      }),
    );

    expect(first.asks.map(({ id }) => id)).toEqual(["review-8", "review-11", "inline-12", "inline-13"]);
    expect(later.asks.map(({ id }) => id)).toEqual(first.asks.map(({ id }) => id));
  });

  it("leave out a dismissed Request changes and one deferred during a Retry, each with its line comments, as the Reviewer is given neither", () => {
    const requestChanges = [
      aRequestChanges(8, at(20), { body: "Call it a basket." }),
      aRequestChanges(9, at(22), { body: "Drop the banner.", dismissed: true, lineComments: [LINE(14, "src/banner.ts")] }),
      aRequestChanges(10, at(24), { body: "Add a coupon field.", deferred: true, lineComments: [LINE(15, "src/coupon.ts")] }),
    ];

    expect(digestFactsOf(aThread({ requestChanges })).asks.map(({ id }) => id)).toEqual(["review-8"]);
  });

  it("list a review whose own text is empty by its line comments alone", () => {
    const requestChanges = [
      aRequestChanges(8, at(20), { body: "  \n", lineComments: [LINE(12, "src/cart.ts")] }),
      aRequestChanges(9, at(22), { body: "" }),
    ];

    expect(digestFactsOf(aThread({ requestChanges })).asks.map(({ id }) => id)).toEqual(["inline-12"]);
  });

  it("are none on a pull request the Operator never requested changes on", () => {
    expect(digestFactsOf(aThread()).asks).toEqual([]);
  });
});
