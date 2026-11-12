import { describe, expect, it } from "vitest";
import { aPullRequest, HEAD_SHA, kitConfig, notificationsOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan, PullRequestSnapshot } from "./types.ts";

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

/** #50 as a pass leaves it with the Digest on: a draft with the pass on its head and `agent:digest` on, not out of draft since. */
function aPassedDraft(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return aPullRequest({
    draft: true,
    leftDraftSinceVerdict: false,
    labels: ["agent:digest"],
    verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }],
    ...overrides,
  });
}

function changesRequested(overrides: Partial<Extract<LoopEvent, { kind: "pull-request-changes-requested" }>> = {}): LoopEvent {
  return { kind: "pull-request-changes-requested", pullRequest: 50, review: 900, reviewer: "operator", reviewerIsBot: false, ...overrides };
}

describe("The Operator's Request changes on a passed draft waiting on its Digest", () => {
  it("is acted on as one at the Merge gate: the started note, the PR kept in draft, the Request-changes run on the Step-up model, and agent:digest off", () => {
    const config = kitConfig();
    const plan = planFor(changesRequested(), snapshotOfPullRequest(aPassedDraft()), config);

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 50,
          body: [
            "<!-- fabrik:request-changes-run-started 900 -->",
            "The Kit is starting the Request-changes run for your Request changes on #50 ([review 900](https://github.com/acme/shop/pull/50#pullrequestreview-900)). It runs on the Step-up model and uses no retry. The PR stays in draft, with no Digest for this head, and Review runs again on the run's push.",
          ].join("\n"),
        },
        { kind: "remove-label", issue: 50, label: "agent:digest" },
        {
          kind: "start-agent-run",
          role: "implement",
          issue: 7,
          pullRequest: 50,
          requestChanges: { review: 900 },
          model: config.roles.stepUp.model,
          effort: config.roles.stepUp.effort,
          timeoutMinutes: config.roles.implement.timeoutMinutes,
          stepUp: true,
          stepUpReason: "request-changes",
          subscription: "Claude token",
        },
      ],
    });
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("is acted on in the moment after the Digest attempt ended too, before the gate opened: the label is already off", () => {
    const plan = planFor(changesRequested(), snapshotOfPullRequest(aPassedDraft({ labels: [] })), kitConfig());

    expect(actionsOf(plan).map(({ kind }) => kind)).toEqual(["comment", "remove-label", "start-agent-run"]);
  });

  it.each([
    ["a draft with no pass on its head, as after a push to it", aPassedDraft({ headSha: "b".repeat(40) })],
    ["a draft whose latest Verdict is an Execution flaw", aPassedDraft({ verdicts: [{ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }], pushedSinceVerdict: true })],
    ["a draft no Review has judged yet", aPassedDraft({ verdicts: [] })],
    ["a draft the Operator put back in draft themselves after the gate opened", aPassedDraft({ leftDraftSinceVerdict: true })],
    // A pass kept it in draft to be brought up to date with main.
    ["a passed draft with a conflict-only run in flight", aPassedDraft({ conflictRunInFlight: "c".repeat(40) })],
    // As after a pass that gave way to a Request changes deferred during a Retry.
    [
      "a passed draft with a Request-changes run in flight",
      aPassedDraft({
        unbuiltChangesRequests: [{ review: 777, reviewer: "operator", reviewerIsBot: false, submittedAt: "2026-11-08T05:00:00.000Z" }],
        notedChangesRequests: [777],
        requestChangesRunInFlight: 777,
        requestChangesRunReviews: [777],
        requestChangesRunSince: "2026-11-08T05:10:00.000Z",
      }),
    ],
  ])("does what it does today on %s: nothing, as on any draft still in the Loop", (_what, pullRequest) => {
    expect(planFor(changesRequested(), snapshotOfPullRequest(pullRequest), kitConfig())).toEqual({
      kind: "nothing",
      reason: "#50 is still a draft in the Loop, not at the Merge gate",
    });
  });

  it("from anyone but the Operator starts nothing, and says so in one line, as today", () => {
    const plan = planFor(changesRequested({ reviewer: "someone" }), snapshotOfPullRequest(aPassedDraft()), kitConfig());

    expect(actionsOf(plan)).toEqual([
      { kind: "comment", issue: 50, body: "Only the Operator's reviews start runs on an agent PR, so the Request changes from someone on #50 starts nothing." },
    ]);
  });
});
