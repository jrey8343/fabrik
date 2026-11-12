import { describe, expect, it } from "vitest";
import { aPullRequest, HEAD_SHA, kitConfig, notificationsOf, snapshotOfPullRequest, verdictsPostedIn } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const REPO = "https://github.com/acme/shop";
const DIGEST_OFF = kitConfig({ digest: { enabled: false } });

/** The Reviewer's reply on #50 at its head. */
function reviewed(output: string): LoopEvent {
  return { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output, runUrl: RUN, repoUrl: REPO };
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

function commentsOf(plan: Plan): string[] {
  return actionsOf(plan).flatMap((action) => (action.kind === "comment" ? [action.body] : []));
}

describe("The Digest: a pass", () => {
  it("with the Digest on, a pass posts its Verdict, adds agent:digest, leaves the PR in draft and requests no review", () => {
    const plan = planFor(reviewed("verdict: pass\n\nLooks good."), snapshotOfPullRequest(aPullRequest(), { operator: "jrey" }), kitConfig());

    expect(verdictsPostedIn(commentsOf(plan))).toEqual([{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }]);
    expect(actionsOf(plan).filter((action) => action.kind !== "comment")).toEqual([{ kind: "add-labels", issue: 50, labels: ["agent:digest"] }]);
    expect(notificationsOf(plan, "jrey")).toEqual([]);
  });

  it("with the Digest off in Kit config, a pass opens the Merge gate itself and adds no label", () => {
    const plan = planFor(reviewed("verdict: pass\n\nLooks good."), snapshotOfPullRequest(aPullRequest(), { operator: "jrey" }), DIGEST_OFF);

    expect(actionsOf(plan).filter((action) => action.kind !== "comment")).toEqual([
      { kind: "mark-ready-for-review", pullRequest: 50 },
      { kind: "request-review", pullRequest: 50, reviewer: "jrey" },
    ]);
    expect(notificationsOf(plan, "jrey")).toEqual(["review request on #50"]);
  });

  /** Whether a plan adds `agent:digest` anywhere, or takes the PR out of draft, or requests a review. */
  const startsADigestOrOpensTheGate = (plan: Plan): boolean =>
    actionsOf(plan).some(
      (action) =>
        (action.kind === "add-labels" && action.labels.includes("agent:digest")) || action.kind === "mark-ready-for-review" || action.kind === "request-review",
    );

  it("a pass on a PR that conflicts with main adds no label: it is brought up to date first, and the pass on that head brings the Digest", () => {
    const conflicting = { main: "c".repeat(40), mergeable: false };
    const plan = planFor(reviewed("verdict: pass\n\nLooks good."), snapshotOfPullRequest(aPullRequest(), { mergeable: conflicting }), kitConfig());

    expect(actionsOf(plan).map(({ kind }) => kind)).toEqual(["comment", "rebase-onto-main"]);
    expect(startsADigestOrOpensTheGate(plan)).toBe(false);
  });

  it("a pass that gives way to a Request changes deferred during a Retry adds no label", () => {
    const deferred = aPullRequest({
      unbuiltChangesRequests: [{ review: 777, reviewer: "operator", reviewerIsBot: false, submittedAt: "2026-11-08T05:00:00.000Z" }],
      notedChangesRequests: [777],
      deferredChangesRequests: [777],
    });
    const plan = planFor(reviewed("verdict: pass\n\nLooks good."), snapshotOfPullRequest(deferred), kitConfig());

    expect(verdictsPostedIn(commentsOf(plan))).toMatchObject([{ verdict: "pass", requestChangesFirst: [777] }]);
    expect(startsADigestOrOpensTheGate(plan)).toBe(false);
  });

  it.each([
    ["an Execution flaw from the Reviewer", reviewed("verdict: execution-flaw\n\nThe empty-cart case throws.")],
    ["a Design flaw", reviewed("verdict: design-flaw\n\nThe Ticket asks for two contradictory things.")],
    ["an Execution flaw from red required checks", { kind: "required-checks-finished", pullRequest: 50, headSha: HEAD_SHA, failed: ["build"], runUrl: RUN } as const],
  ])("%s adds no label", (_what, event: LoopEvent) => {
    const plan = planFor(event, snapshotOfPullRequest(aPullRequest()), kitConfig());

    expect(verdictsPostedIn(commentsOf(plan))).toHaveLength(1);
    expect(startsADigestOrOpensTheGate(plan)).toBe(false);
  });
});
