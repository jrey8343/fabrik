import { describe, expect, it } from "vitest";
import {
  anIssue,
  aPullRequest,
  HEAD_SHA,
  kitConfig,
  notificationsOf,
  snapshotOfPullRequest,
} from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan, VerdictRecord } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

function reviewed(output: string): LoopEvent {
  return { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output, runUrl: RUN };
}

function redChecks(): LoopEvent {
  return { kind: "required-checks-finished", pullRequest: 50, headSha: HEAD_SHA, failed: ["build"], runUrl: RUN };
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

/** An earlier Verdict on an older commit. */
function earlier(verdict: VerdictRecord["verdict"], overrides: Partial<VerdictRecord> = {}): VerdictRecord {
  return { verdict, source: "reviewer", requestChanges: false, headSha: "0".repeat(40), ...overrides };
}

const designFlaw = reviewed("verdict: design-flaw\n\nThe Ticket asks for a cart total the checkout never reads.");

describe("A Design flaw sends the Ticket back to design", () => {
  it("closes the PR, keeping its branch, and swaps ready-for-agent for needs-design on the Ticket", () => {
    const plan = planFor(designFlaw, snapshotOfPullRequest(aPullRequest()), kitConfig());

    const actions = actionsOf(plan);
    expect(actions).toContainEqual({ kind: "close-pull-request", pullRequest: 50 });
    expect(actions).toContainEqual({ kind: "remove-label", issue: 7, label: "ready-for-agent" });
    expect(actions).toContainEqual({ kind: "add-labels", issue: 7, labels: ["needs-design"] });
    // Nothing else happens: no action deletes the branch. needs-design goes on last,
    // so the Design session it starts sees everything else.
    expect(actions.map((action) => action.kind)).toEqual([
      "comment",
      "close-pull-request",
      "comment-linking",
      "remove-label",
      "add-labels",
    ]);
  });
});

/** Two Execution flaws already on the PR, so the next is its third. */
const usedUp = aPullRequest({ verdicts: [earlier("execution-flaw"), earlier("execution-flaw", { source: "ci" })] });

/** The second retry's push job, holding a branch that changed nothing on the PR it fixes. */
const emptySecondRetry: LoopEvent = {
  kind: "implement-run-finished",
  issue: 7,
  output: JSON.stringify({ title: "Handle the empty cart", summary: "Nothing to change." }),
  branch: "fabrik/ticket-7",
  base: "fabrik/ticket-7",
  changes: { net: [], commits: [] },
  fixes: { pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN },
};

describe("A third Execution flaw counts as a Design flaw", () => {
  it.each([
    ["from the Reviewer", reviewed("verdict: execution-flaw\n\nStill throws on the empty cart."), snapshotOfPullRequest(usedUp)],
    ["from red CI", redChecks(), snapshotOfPullRequest(usedUp)],
    [
      "from a retry that changed nothing",
      emptySecondRetry,
      {
        ...snapshotOfPullRequest(
          aPullRequest({ verdicts: [earlier("execution-flaw"), earlier("execution-flaw", { headSha: HEAD_SHA })] }),
        ),
        issue: anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] }),
      },
    ],
  ])("%s sends its Ticket to needs-design and closes the PR, starting no retry", (_, event, snapshot) => {
    const actions = actionsOf(planFor(event, snapshot, kitConfig()));

    expect(actions).toContainEqual({ kind: "close-pull-request", pullRequest: 50 });
    expect(actions).toContainEqual({ kind: "remove-label", issue: 7, label: "ready-for-agent" });
    expect(actions.at(-1)).toEqual({ kind: "add-labels", issue: 7, labels: ["needs-design"] });
    expect(actions).not.toContainEqual({ kind: "add-labels", issue: 50, labels: ["agent:retry"] });
  });

  it("a second Execution flaw still retries, and leaves the Ticket and its PR as they are", () => {
    const pullRequest = aPullRequest({ verdicts: [earlier("execution-flaw")] });
    const plan = planFor(reviewed("verdict: execution-flaw\n\nStill throws."), snapshotOfPullRequest(pullRequest), kitConfig());

    expect(actionsOf(plan).map((action) => action.kind)).not.toContain("close-pull-request");
    expect(actionsOf(plan)).not.toContainEqual({ kind: "add-labels", issue: 7, labels: ["needs-design"] });
  });

  it("Execution flaws from Request-changes runs don't count toward the third", () => {
    const pullRequest = aPullRequest({
      verdicts: [earlier("execution-flaw"), earlier("execution-flaw", { requestChanges: true })],
    });
    const plan = planFor(reviewed("verdict: execution-flaw\n\nStill throws."), snapshotOfPullRequest(pullRequest), kitConfig());

    expect(actionsOf(plan).map((action) => action.kind)).not.toContain("close-pull-request");
  });
});

describe("Going back to design notifies nobody", () => {
  it.each([
    ["a Design flaw", reviewed("verdict: design-flaw\n\nWrong approach, @someone."), aPullRequest()],
    ["a third Execution flaw", reviewed("verdict: execution-flaw\n\nStill throws, @someone."), usedUp],
  ])("%s mentions, assigns and requests nobody: the Design session's round 1 does", (_, event, pullRequest) => {
    const plan = planFor(event, snapshotOfPullRequest(pullRequest, { operator: "jrey" }), kitConfig());

    expect(notificationsOf(plan, "jrey")).toEqual([]);
    expect(notificationsOf(plan, "someone")).toEqual([]);
  });
});

describe("The Kit's note on the Ticket", () => {
  it("links the closed PR and its Verdict, which the same plan posts first", () => {
    const actions = actionsOf(planFor(designFlaw, snapshotOfPullRequest(aPullRequest()), kitConfig()));

    const verdict = actions.find((action) => action.kind === "comment");
    const note = actions.find((action) => action.kind === "comment-linking");
    expect(verdict).toMatchObject({ issue: 50, key: "verdict" });
    expect(note).toMatchObject({ issue: 7 });
    const text =
      note?.kind === "comment-linking"
        ? note.body.map((part) => (typeof part === "string" ? part : `<${part.posted}>`)).join("")
        : "";
    expect(text).toContain("#50");
    expect(text).toContain("[the Verdict](<verdict>)");
    expect(text).toContain("`fabrik/ticket-7`");
  });
});
