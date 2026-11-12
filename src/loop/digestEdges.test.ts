// The edges of the wait a pass puts in front of the Merge gate (ADR-0022):
// a Digest run is never a Held run, a failure that stalls the whole repo
// still opens its Kit-owned issue, and a start that is lost opens the gate at
// the stuck-trigger sweep. Each through the Loop rules core.
import { describe, expect, it } from "vitest";
import { aPullRequest, HEAD_SHA, kitConfig, notificationsOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { noDigestLine } from "./digestContract.ts";
import { planFor } from "./rules.ts";
import type { Action, KitIssueSnapshot, LoopEvent, Plan, PullRequestSnapshot } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const REPO = "https://github.com/acme/shop";

/** Subscription rotation on, over two Subscriptions. */
const ROTATING = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });

/** An open weekly-limit issue for one Subscription, as the Kit opens it with rotation on. */
function usedUp(number: number, subscription: string): KitIssueSnapshot {
  return {
    number,
    labels: ["fabrik:weekly-limit"],
    body: [`The weekly usage limit of the \`${subscription}\` Subscription is reached.`, "", `<!-- fabrik:subscription ${subscription} -->`, "<!-- fabrik:resets-at 2026-11-16T04:00:00.000Z -->"].join("\n"),
    comments: [],
  };
}

/** Every listed Subscription used up: a run due now would be held. */
const NONE_FREE = [usedUp(40, "Claude token"), usedUp(41, "Claude token 2")];

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

function commentsOn(plan: Plan, issue: number): string[] {
  return actionsOf(plan).flatMap((action) => (action.kind === "comment" && action.issue === issue ? [action.body] : []));
}

/** The Reviewer's pass on #50 at its head. */
const PASSED: LoopEvent = { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output: "verdict: pass\n\nLooks good.", runUrl: RUN, repoUrl: REPO };

/** Whether a plan holds a run anywhere: a held run, a held marker on a carrier, or a Held line on the run's own thread. */
function holdsARun(plan: Plan): boolean {
  const held = (text: string): boolean => text.includes("fabrik:held") || text.includes("fabrik:on-hold") || text.includes(" is held ");
  return actionsOf(plan).some(
    (action) =>
      action.kind === "hold-agent-run" ||
      (action.kind === "comment" && held(action.body)) ||
      (action.kind === "comment-linking" && action.body.some((part) => typeof part === "string" && held(part))),
  );
}

describe("The Digest: never a Held run, on a pass", () => {
  const passedOn = (pullRequest: PullRequestSnapshot, kitIssues: readonly KitIssueSnapshot[], config = ROTATING): Plan =>
    planFor(PASSED, snapshotOfPullRequest(pullRequest, { operator: "jrey", kitIssues }), config);

  it("with rotation on and every Subscription used up, a pass posts the no-Digest line with no-subscription and opens the gate in the same step", () => {
    const plan = passedOn(aPullRequest(), NONE_FREE);

    // The Verdict, then the line, then the gate: no label was added, so none comes off.
    expect(actionsOf(plan).slice(1)).toEqual([
      { kind: "comment", issue: 50, body: noDigestLine({ head: HEAD_SHA, how: "no-subscription" }) },
      { kind: "mark-ready-for-review", pullRequest: 50 },
      { kind: "request-review", pullRequest: 50, reviewer: "jrey" },
    ]);
    expect(notificationsOf(plan, "jrey")).toEqual(["review request on #50"]);
  });

  it("adds no label then, holds nothing, and writes no Held line on the PR nor held marker on a carrier", () => {
    const plan = passedOn(aPullRequest(), NONE_FREE);

    expect(actionsOf(plan).some((action) => action.kind === "add-labels")).toBe(false);
    expect(holdsARun(plan)).toBe(false);
    // Nothing is said on either weekly-limit issue.
    expect(actionsOf(plan).every((action) => !("issue" in action) || action.issue === 50)).toBe(true);
  });

  it("with one Subscription still free, the pass adds agent:digest as ever", () => {
    const plan = passedOn(aPullRequest(), [usedUp(40, "Claude token")]);

    expect(actionsOf(plan).slice(1)).toEqual([{ kind: "add-labels", issue: 50, labels: ["agent:digest"] }]);
  });

  it("with rotation off and its one Subscription used up, the pass adds agent:digest all the same: the run starts, and fails as any run does", () => {
    const plan = passedOn(aPullRequest(), [{ number: 40, labels: ["fabrik:weekly-limit"], body: "The weekly usage limit is reached.", comments: [] }], kitConfig());

    expect(actionsOf(plan).slice(1)).toEqual([{ kind: "add-labels", issue: 50, labels: ["agent:digest"] }]);
  });
});

/** An agent PR with a pass on its current head and `agent:digest` on: a passed draft whose gate has yet to open, unless a test says otherwise. */
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

describe("The Digest: never a Held run, when agent:digest is added", () => {
  const labelledOn = (pullRequest: PullRequestSnapshot, kitIssues: readonly KitIssueSnapshot[], config = ROTATING): Plan =>
    planFor({ kind: "pull-request-labeled", pullRequest: 50, label: "agent:digest" }, snapshotOfPullRequest(pullRequest, { operator: "jrey", kitIssues }), config);

  it("with every Subscription used up, the label on a passed draft posts the no-Digest line with no-subscription, comes off, and the gate opens", () => {
    const plan = labelledOn(aPassedDraft(), NONE_FREE);

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "comment", issue: 50, body: noDigestLine({ head: HEAD_SHA, how: "no-subscription" }) }, ...THE_GATE_OPENS] });
    expect(holdsARun(plan)).toBe(false);
  });

  it("on a PR whose gate has opened, the line is posted and the label comes off, and nothing else moves", () => {
    const plan = labelledOn(aPassedDraft({ draft: false, leftDraftSinceVerdict: true }), NONE_FREE);

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "comment", issue: 50, body: noDigestLine({ head: HEAD_SHA, how: "no-subscription" }) },
        { kind: "remove-label", issue: 50, label: "agent:digest" },
      ],
    });
    expect(notificationsOf(plan, "jrey")).toEqual([]);
  });

  it("a label the rule declines is declined as ever, with no no-Digest line", () => {
    const plan = labelledOn(aPassedDraft({ verdicts: [] }), NONE_FREE);

    expect(commentsOn(plan, 50)).toEqual(["agent:digest came off and nothing started: #50 has no pass on its current head, aaaaaaa."]);
  });

  it("with one Subscription still free, the label starts the Digest writer on it", () => {
    const plan = labelledOn(aPassedDraft(), [usedUp(40, "Claude token")]);

    expect(actionsOf(plan)).toMatchObject([{ kind: "start-agent-run", role: "digest", issue: 50, subscription: "Claude token 2" }]);
  });

  it("with rotation off and its one Subscription used up, the run starts", () => {
    const plan = labelledOn(aPassedDraft(), [{ number: 40, labels: ["fabrik:weekly-limit"], body: "The weekly usage limit is reached.", comments: [] }], kitConfig());

    expect(actionsOf(plan)).toMatchObject([{ kind: "start-agent-run", role: "digest", issue: 50 }]);
  });
});
