// The tags on a Reviewer's findings (#749): the Kit reads them off the
// Verdict, counts them into a Reviewer's Execution-flaw marker, and checks
// nothing in code. A `[missed earlier]` on a Full Review counts. An
// all-tagged Execution flaw calls for a Touch-up (#750, src/loop/touchUp.test.ts).
import { describe, expect, it } from "vitest";
import { aPullRequest, HEAD_SHA, kitConfig, snapshotOfPullRequest, verdictsPostedIn } from "../__fixtures__/snapshots.ts";
import type { ChangeFingerprint } from "./changeFingerprint.ts";
import { planFor } from "./rules.ts";
import type { LoopEvent, Plan, PullRequestSnapshot } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const EARLIER_HEAD = "1".repeat(40);
const CHANGE: ChangeFingerprint = { v: 1, all: "0123456789ab", product: "ba9876543210", files: { "src/cart.ts": "aaaaaaaaaaaa" } };

const FINDINGS = [
  "- [small: body] The PR body still says the cart is cached.",
  "- [small: comment] `cart.ts`'s header comment still names `loadCart`.",
  "- [missed earlier] The empty cart throws in `checkout.ts`.",
  "- `checkout.test.ts` covers only a full cart.",
].join("\n");

function reviewed(output: string): LoopEvent {
  return { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output, runUrl: RUN, repoUrl: "https://github.com/acme/shop" };
}

/** A pull request whose first Review this is: a Full Review. */
const firstReviewed = aPullRequest();

/** A pull request a Retry pushed to after the Reviewer judged an earlier head: a later Review (#747). */
const laterReviewed: PullRequestSnapshot = aPullRequest({
  verdicts: [{ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: EARLIER_HEAD, change: CHANGE }],
  pushedSinceVerdict: true,
});

function landed(output: string, pullRequest: PullRequestSnapshot): Plan {
  return planFor(reviewed(output), snapshotOfPullRequest(pullRequest), kitConfig());
}

function commentsOf(plan: Plan): string[] {
  return plan.kind === "act" ? plan.actions.flatMap((action) => (action.kind === "comment" ? [action.body] : [])) : [];
}

describe("A Reviewer's Execution flaw records its findings' tags (#749)", () => {
  it("on a later Review, its marker counts its findings by tag", () => {
    const plan = landed(`verdict: execution-flaw\n\n${FINDINGS}`, laterReviewed);

    expect(verdictsPostedIn(commentsOf(plan))).toEqual([
      {
        verdict: "execution-flaw",
        source: "reviewer",
        requestChanges: false,
        tags: { small: 2, missedEarlier: 1, counted: 1, smallBody: 1 },
        headSha: HEAD_SHA,
      },
    ]);
  });

  it("on a Full Review, a [missed earlier] finding counts, as no code is settled", () => {
    const plan = landed(`verdict: execution-flaw\n\n${FINDINGS}`, firstReviewed);

    expect(verdictsPostedIn(commentsOf(plan))).toMatchObject([{ tags: { small: 2, missedEarlier: 0, counted: 2, smallBody: 1 } }]);
  });

  it("findings with no items are counted as none of each", () => {
    const plan = landed("verdict: execution-flaw\n\nThe empty cart throws in `checkout.ts`.", laterReviewed);

    expect(verdictsPostedIn(commentsOf(plan))).toMatchObject([{ tags: { small: 0, missedEarlier: 0, counted: 0, smallBody: 0 } }]);
  });

  it.each([
    ["pass", `verdict: pass\n\n${FINDINGS}`],
    ["design-flaw", `verdict: design-flaw\n\n${FINDINGS}`],
  ])("a %s carries no tags, whatever its text says", (verdict, output) => {
    const plan = landed(output, laterReviewed);

    expect(verdictsPostedIn(commentsOf(plan))).toEqual([{ verdict, source: "reviewer", requestChanges: false, headSha: HEAD_SHA }]);
  });

  it("the posted Verdict shows the tags as the Reviewer wrote them", () => {
    const [body] = commentsOf(landed(`verdict: execution-flaw\n\n${FINDINGS}`, laterReviewed));

    expect(body).toContain(FINDINGS);
  });

  it("a flaw whose findings are all tagged calls for a Touch-up, not a Retry (#750)", () => {
    const allTagged = "- [small: body] The PR body still says the cart is cached.\n- [missed earlier] The empty cart throws in `checkout.ts`.";
    const plan = landed(`verdict: execution-flaw\n\n${allTagged}`, laterReviewed);

    expect(verdictsPostedIn(commentsOf(plan))).toMatchObject([{ tags: { small: 1, missedEarlier: 1, counted: 0, smallBody: 1 } }]);
    expect(commentsOf(plan)[0]).toMatch(/Touch-up 1 of 2/);
    expect(plan.kind === "act" ? plan.actions : []).toContainEqual({ kind: "add-labels", issue: 7, labels: ["agent:implement"] });
  });
});
