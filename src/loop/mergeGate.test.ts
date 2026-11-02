import { describe, expect, it } from "vitest";
import {
  anIssue,
  aPullRequest,
  HEAD_SHA,
  kitConfig,
  notificationsOf,
  snapshotOfPullRequest,
} from "../__fixtures__/snapshots.ts";
import { requestChangesRunIn } from "./mergeGate.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan, PullRequestSnapshot, Snapshot, VerdictRecord } from "./types.ts";
import { verdictsIn } from "./verdict.ts";

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

function changesRequested(overrides: Partial<Extract<LoopEvent, { kind: "pull-request-changes-requested" }>> = {}): LoopEvent {
  return {
    kind: "pull-request-changes-requested",
    pullRequest: 50,
    review: 900,
    reviewer: "operator",
    reviewerIsBot: false,
    ...overrides,
  };
}

/** An agent PR at the Merge gate: it passed Review, left draft and waits on the Operator. */
const atMergeGate = aPullRequest({ draft: false });

describe("Request changes at the Merge gate", () => {
  it("puts the PR back in draft and starts one Implementer run on the Step-up model, with the Operator's review as input", () => {
    const config = kitConfig();
    const plan = planFor(changesRequested(), snapshotOfPullRequest(atMergeGate), config);

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "convert-to-draft", pullRequest: 50 },
        {
          kind: "start-agent-run",
          role: "implement",
          issue: 7,
          pullRequest: 50,
          requestChanges: { review: 900 },
          model: config.roles.stepUp.model,
          effort: config.roles.stepUp.effort,
          timeoutMinutes: config.roles.implement.timeoutMinutes,
        },
      ],
    });
  });

  it("notifies nobody as it starts: the fresh review request after the next pass is the event's one notification", () => {
    expect(notificationsOf(planFor(changesRequested(), snapshotOfPullRequest(atMergeGate), kitConfig()))).toEqual([]);
  });

  it.each([
    ["someone other than the Operator requested the changes", changesRequested({ reviewer: "someone" }), atMergeGate],
    ["a bot requested the changes", changesRequested({ reviewer: "operator", reviewerIsBot: true }), atMergeGate],
    ["the PR isn't an agent PR", changesRequested(), aPullRequest({ draft: false, isAgent: false })],
    ["the PR is closed", changesRequested(), aPullRequest({ draft: false, open: false })],
    ["the PR is still a draft in the Loop, not at the Merge gate", changesRequested(), aPullRequest({ draft: true })],
  ])("does nothing when %s", (_, event, pullRequest) => {
    expect(planFor(event, snapshotOfPullRequest(pullRequest), kitConfig()).kind).toBe("nothing");
  });
});

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

/** A Request-changes run's push job: it built on the PR's head, which went back to draft as it started. */
function requestChangesPushed(
  changes: Extract<LoopEvent, { kind: "implement-run-finished" }>["changes"] = {
    net: [{ path: "src/cart.ts" }],
    commits: [{ path: "src/cart.ts" }],
  },
): LoopEvent {
  return {
    kind: "implement-run-finished",
    issue: 7,
    output: JSON.stringify({ title: "Rename the total", summary: "Renamed the total as the Operator asked." }),
    branch: "fabrik/ticket-7",
    base: "fabrik/ticket-7",
    changes,
    fixes: { pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN, requestChanges: true },
  };
}

function earlier(verdict: VerdictRecord["verdict"], overrides: Partial<VerdictRecord> = {}): VerdictRecord {
  return { verdict, source: "reviewer", requestChanges: false, headSha: "0".repeat(40), ...overrides };
}

function pushSnapshot(
  pullRequest: PullRequestSnapshot = aPullRequest({ verdicts: [earlier("pass", { headSha: HEAD_SHA })] }),
): Snapshot {
  return {
    ...snapshotOfPullRequest(pullRequest),
    issue: anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] }),
  };
}

function commentsOf(plan: Plan): string[] {
  return actionsOf(plan).flatMap((action) => (action.kind === "comment" ? [action.body] : []));
}

describe("A Request-changes run's branch", () => {
  it("is pushed onto the PR with a silent note that marks the push as a Request-changes run's", () => {
    const plan = planFor(requestChangesPushed(), pushSnapshot(), kitConfig());

    expect(actionsOf(plan)[0]).toEqual({ kind: "push-branch", branch: "fabrik/ticket-7" });
    expect(notificationsOf(plan)).toEqual([]);
    expect(commentsOf(plan)[0]).toContain("Renamed the total as the Operator asked.");
    // The PR's comments now say its latest push came from a Request-changes run.
    expect(requestChangesRunIn(commentsOf(plan))).toBe(true);
  });

  it("stops counting as the latest push once a Verdict lands after it", () => {
    const pushed = commentsOf(planFor(requestChangesPushed(), pushSnapshot(), kitConfig()));
    const head = "b".repeat(40);
    const verdict = commentsOf(
      planFor(
        { kind: "review-run-finished", pullRequest: 50, headSha: head, output: "verdict: pass", runUrl: RUN },
        snapshotOfPullRequest(aPullRequest({ headSha: head, requestChangesRun: requestChangesRunIn(pushed) })),
        kitConfig(),
      ),
    );

    expect(verdictsIn(verdict)).toEqual([{ verdict: "pass", source: "reviewer", requestChanges: true, headSha: head }]);
    expect(requestChangesRunIn([...pushed, ...verdict])).toBe(false);
  });

  it("that changes nothing is an Execution flaw marked as from a Request-changes run, so it uses no retry", () => {
    const plan = planFor(requestChangesPushed({ net: [], commits: [] }), pushSnapshot(), kitConfig());

    expect(verdictsIn(commentsOf(plan))).toEqual([
      { verdict: "execution-flaw", source: "empty-diff", requestChanges: true, headSha: HEAD_SHA },
    ]);
    expect(actionsOf(plan)).toContainEqual({ kind: "add-labels", issue: 50, labels: ["agent:retry"] });
    expect(commentsOf(plan)[0]).toContain("Retry 1 of 2 starts now:");
  });
});

describe("Retries after a Request-changes run", () => {
  const flawOn = (pullRequest: PullRequestSnapshot) =>
    planFor(
      { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output: "verdict: execution-flaw\n\nStill wrong.", runUrl: RUN },
      snapshotOfPullRequest(pullRequest),
      kitConfig(),
    );

  it("still count correctly: the Request-changes run's flaw isn't counted, so the next flaw starts retry 2, not back to design", () => {
    // Retry 1 fixed a flaw and passed; the Operator requested changes; that run's push had a flaw; its retry flawed again.
    const plan = flawOn(
      aPullRequest({
        verdicts: [earlier("execution-flaw"), earlier("pass"), earlier("execution-flaw", { requestChanges: true })],
      }),
    );

    expect(commentsOf(plan)[0]).toContain("Retry 2 of 2 starts now, stepped up");
    expect(actionsOf(plan)).not.toContainEqual({ kind: "close-pull-request", pullRequest: 50 });
  });

  it("still run out: two counted flaws before this one send the Ticket back to design", () => {
    const plan = flawOn(
      aPullRequest({
        verdicts: [earlier("execution-flaw"), earlier("execution-flaw", { requestChanges: true }), earlier("execution-flaw")],
      }),
    );

    expect(actionsOf(plan)).toContainEqual({ kind: "close-pull-request", pullRequest: 50 });
  });
});
