// When a check's issue closes as completed, the fix for the check is on main,
// so the Kit brings up to date each agent PR that check holds at the Merge
// gate (#784): the one exception to ADR-0011's "a PR only behind main is left
// alone", by ADR-0011's own path.
import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, HEAD_SHA, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { flakyCheckIssueMarker } from "./markers.ts";
import { planFor } from "./rules.ts";
import type { Action, ConflictCandidate, LoopEvent, Plan, PullRequestSnapshot, Snapshot, VerdictRecord } from "./types.ts";

const MAIN = "9".repeat(40);
const PASS_AT = "2026-11-18T08:00:00Z";

/** The Reviewer's pass on the PR's head, naming an Unrelated failure of `e2e`. */
const PASSED: VerdictRecord = { verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA, unrelated: ["e2e"] };

/** Agent PR #50 for Ticket #7 at the Merge gate, its pass held by an Unrelated failure of `e2e`. */
function heldAtGate(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return aPullRequest({ draft: false, verdicts: [PASSED], verdictPostedAt: PASS_AT, ...overrides });
}

/** The check's issue, #12, which the Fabrik App filed for `e2e`, now closed. */
const CHECK_ISSUE = anIssue({ number: 12, open: false, byApp: true, body: `${flakyCheckIssueMarker("e2e")}\nThe required check \`e2e\` …`, labels: ["fabrik:flaky-check"] });

function closedAs(stateReason: "completed" | "not-planned" | "duplicate" | null): LoopEvent {
  return { kind: "issue-closed", issue: 12, stateReason };
}

const COMPLETED = closedAs("completed");

/** The check's issue closing, with every open agent PR as the conflict check reads them. */
function closing(candidates: readonly ConflictCandidate[], overrides: Partial<Snapshot> = {}): Snapshot {
  return snapshotOf(CHECK_ISSUE, { conflicts: { main: MAIN, now: "2026-11-18T10:00:00Z", implementJobUnderWay: null, pullRequests: candidates }, ...overrides });
}

/** PR #50, only behind main. */
const BEHIND: ConflictCandidate = { pullRequest: heldAtGate(), mergeable: true, holdsMain: false };

function rebasesIn(plan: Plan): Extract<Action, { kind: "rebase-onto-main" }>[] {
  return plan.kind === "act"
    ? plan.actions.filter((action): action is Extract<Action, { kind: "rebase-onto-main" }> => action.kind === "rebase-onto-main")
    : [];
}

function commentOn(actions: readonly Action[], issue: number): string {
  const comment = actions.find((action) => action.kind === "comment" && action.issue === issue);
  if (comment?.kind !== "comment") throw new Error(`No comment on #${issue}`);
  return comment.body;
}

describe("a check's issue closing as completed", () => {
  it("rebases an agent PR its check holds at the Merge gate, though it is only behind main, back in draft first so the push starts a Review", () => {
    const [rebase] = rebasesIn(planFor(COMPLETED, closing([BEHIND]), kitConfig()));

    expect(rebase).toMatchObject({ pullRequest: 50, branch: "fabrik/ticket-7", onto: MAIN });
    expect(rebase?.clean).toEqual([{ kind: "convert-to-draft", pullRequest: 50 }]);
  });
});
