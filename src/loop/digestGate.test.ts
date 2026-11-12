import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, HEAD_SHA, kitConfig, notificationsOf, snapshotOf, snapshotOfPullRequest, verdictsPostedIn } from "../__fixtures__/snapshots.ts";
import { digestCommentOf, noDigestLine } from "./digestContract.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan, PullRequestSnapshot } from "./types.ts";

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

const REPLY = {
  whatItDoes: "A shopper can now save their basket.",
  howItGotHere: "One Review passed it at the first head.",
  walkthrough: "1. The basket page's Save button.",
  decided: "- Prices hold for a day.",
};

type Written = Extract<LoopEvent, { kind: "digest-run-finished" }>;

/** The Digest writer finished on #50 at the head its pass was given on, with a reply that keeps its shape. */
function written(overrides: Partial<Written> = {}): Written {
  return {
    kind: "digest-run-finished",
    pullRequest: 50,
    headSha: HEAD_SHA,
    output: JSON.stringify(REPLY),
    given: { repoUrl: REPO, pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN },
    runUrl: RUN,
    ...overrides,
  };
}

type Failed = Extract<LoopEvent, { kind: "agent-run-failed" }>;

/** The Digest writer's job on #50 failed, for Ticket #7. */
function failed(overrides: Partial<Failed> = {}): Failed {
  return {
    kind: "agent-run-failed",
    role: "digest",
    issue: 7,
    runUrl: RUN,
    jobResult: "failure",
    secretsStep: "success",
    report: null,
    digest: { pullRequest: 50, headSha: HEAD_SHA },
    ...overrides,
  };
}

/** The plan for a Digest that the writer finished, on this pull request. */
function landedOn(pullRequest: PullRequestSnapshot, event: Written = written()): Plan {
  return planFor(event, snapshotOfPullRequest(pullRequest, { operator: "jrey" }), kitConfig());
}

/** The plan for a failed Digest run, whose snapshot holds its Ticket and its pull request. */
function failedOn(pullRequest: PullRequestSnapshot, event: Failed = failed()): Plan {
  return planFor(event, snapshotOf(anIssue({ number: 7, openPullRequests: [50] }), { pullRequest, operator: "jrey" }), kitConfig());
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

/** The label off, out of draft, the Operator's review requested: the gate opening, in its order. */
const THE_GATE_OPENS: Action[] = [
  { kind: "remove-label", issue: 50, label: "agent:digest" },
  { kind: "mark-ready-for-review", pullRequest: 50 },
  { kind: "request-review", pullRequest: 50, reviewer: "jrey" },
];

describe("The Digest: the Merge gate opens when the attempt ends", () => {
  it("a Digest that lands on a passed draft is posted, then the label comes off, the PR leaves draft and the Operator's review is requested", () => {
    const rendered = digestCommentOf(REPLY, { repoUrl: REPO, pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN });
    const plan = landedOn(aPassedDraft());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "comment", issue: 50, body: rendered.ok ? rendered.body : "" }, ...THE_GATE_OPENS] });
    // The Digest mentions nobody: the review request is the one notification.
    expect(notificationsOf(plan, "jrey")).toEqual(["review request on #50"]);
  });

  it.each([
    ["a run that fails", () => failedOn(aPassedDraft()), noDigestLine({ head: HEAD_SHA, how: "failed", runUrl: RUN })],
    [
      "a run that runs past its time limit",
      () => failedOn(aPassedDraft(), failed({ jobResult: "cancelled" })),
      noDigestLine({ head: HEAD_SHA, how: "timed-out", runUrl: RUN }),
    ],
    [
      "a reply that breaks its shape in the agent job",
      () => failedOn(aPassedDraft(), failed({ report: { failure: "missing-output", detail: "whatItDoes must be non-empty text" } })),
      noDigestLine({ head: HEAD_SHA, how: "refused", reason: "it broke the reply's shape in the agent job", runUrl: RUN }),
    ],
    [
      "a reply that breaks its shape in the push job",
      () => landedOn(aPassedDraft(), written({ output: JSON.stringify({ ...REPLY, walkthrough: "" }) })),
      noDigestLine({ head: HEAD_SHA, how: "refused", reason: "walkthrough must be non-empty text", runUrl: RUN }),
    ],
  ])("%s posts the no-Digest line and then opens the gate the same way: the Loop waits for the attempt, never for its success", (_what, planOf, line) => {
    const plan = planOf();

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "comment", issue: 50, body: line }, ...THE_GATE_OPENS] });
    expect(notificationsOf(plan, "jrey")).toEqual(["review request on #50"]);
  });
});
