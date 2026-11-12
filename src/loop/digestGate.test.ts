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
});
