import { describe, expect, it } from "vitest";
import {
  aPullRequest,
  HEAD_SHA,
  kitConfig,
  notificationsOf,
  snapshotOfPullRequest,
  verdictsPostedIn,
} from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

function redChecks(overrides: Partial<Extract<LoopEvent, { kind: "required-checks-finished" }>> = {}): LoopEvent {
  return { kind: "required-checks-finished", pullRequest: 50, headSha: HEAD_SHA, failed: ["build"], runUrl: RUN, ...overrides };
}

function reviewed(output: string, overrides: Partial<Extract<LoopEvent, { kind: "review-run-finished" }>> = {}): LoopEvent {
  return { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output, runUrl: RUN, ...overrides };
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

function commentsOf(plan: Plan): string[] {
  return actionsOf(plan).flatMap((action) => (action.kind === "comment" ? [action.body] : []));
}

describe("Review: starting one", () => {
  it("a push to an agent draft PR starts a Review on the Reviewer's model and timeout", () => {
    const config = kitConfig();
    const plan = planFor({ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(aPullRequest()), config);

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "start-agent-run",
          role: "review",
          issue: 50,
          model: config.roles.review.model,
          effort: config.roles.review.effort,
          timeoutMinutes: 30,
        },
      ],
    });
  });

  it("agent:review added to an agent draft PR starts a Review again", () => {
    const plan = planFor(
      { kind: "pull-request-labeled", pullRequest: 50, label: "agent:review" },
      snapshotOfPullRequest(aPullRequest({ labels: ["agent:review"] })),
      kitConfig(),
    );

    expect(actionsOf(plan)).toMatchObject([{ kind: "start-agent-run", role: "review", issue: 50 }]);
  });

  it("any other label on a PR does nothing", () => {
    const plan = planFor(
      { kind: "pull-request-labeled", pullRequest: 50, label: "enhancement" },
      snapshotOfPullRequest(aPullRequest()),
      kitConfig(),
    );

    expect(plan.kind).toBe("nothing");
  });

  it.each([
    ["a person's PR", aPullRequest({ isAgent: false })],
    ["a closed agent PR", aPullRequest({ open: false })],
    ["an agent PR out of draft", aPullRequest({ draft: false })],
    ["an agent PR whose branch names no Ticket", aPullRequest({ ticket: null })],
  ])("a push to %s starts no Review", (_, pullRequest) => {
    const plan = planFor({ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(pullRequest), kitConfig());

    expect(plan.kind).toBe("nothing");
  });
});

describe("Review: a stale Verdict", () => {
  it.each([
    ["the PR has moved to a newer commit", aPullRequest({ headSha: "b".repeat(40) })],
    ["the PR already has a Verdict on that commit", aPullRequest({
      verdicts: [{ verdict: "execution-flaw", source: "ci", requestChanges: false, headSha: HEAD_SHA }],
    })],
    ["the PR has left draft", aPullRequest({ draft: false })],
    ["the PR is closed", aPullRequest({ open: false })],
  ])("isn't posted when %s", (_, pullRequest) => {
    expect(planFor(reviewed("verdict: pass"), snapshotOfPullRequest(pullRequest), kitConfig()).kind).toBe("nothing");
    expect(planFor(redChecks(), snapshotOfPullRequest(pullRequest), kitConfig()).kind).toBe("nothing");
  });
});

describe("Review: the Verdict marker", () => {
  it("records a Verdict after a Request-changes run as one", () => {
    const plan = planFor(
      reviewed("verdict: execution-flaw\n\nStill broken."),
      snapshotOfPullRequest(aPullRequest({ requestChangesRun: true })),
      kitConfig(),
    );

    expect(verdictsPostedIn(commentsOf(plan))).toEqual([
      { verdict: "execution-flaw", source: "reviewer", requestChanges: true, headSha: HEAD_SHA },
    ]);
  });

  it("takes agent:review off the PR, so re-adding it starts a Review again", () => {
    const plan = planFor(
      reviewed("verdict: design-flaw\n\nWrong approach."),
      snapshotOfPullRequest(aPullRequest({ labels: ["agent:review"] })),
      kitConfig(),
    );

    expect(actionsOf(plan)[0]).toEqual({ kind: "remove-label", issue: 50, label: "agent:review" });
  });

});

describe("Review: red CI", () => {
  it("red required checks yield an Execution-flaw Verdict comment from CI, and no Reviewer run", () => {
    const plan = planFor(redChecks({ failed: ["build", "test"] }), snapshotOfPullRequest(aPullRequest()), kitConfig());

    const actions = actionsOf(plan);
    expect(actions.filter((action) => action.kind === "start-agent-run")).toEqual([]);
    expect(actions.map((action) => action.kind)).toEqual(["comment", "add-labels"]);
    const [body] = commentsOf(plan);
    expect(actions[0]).toMatchObject({ kind: "comment", issue: 50 });
    expect(verdictsPostedIn([body!])).toEqual([
      { verdict: "execution-flaw", source: "ci", requestChanges: false, headSha: HEAD_SHA },
    ]);
    expect(body).toContain("`build`");
    expect(body).toContain("`test`");
    expect(notificationsOf(plan)).toEqual([]);
    expect(body).toContain(`[The run](${RUN})`);
  });
});

describe("Review: the Reviewer's Verdict", () => {
  it.each([
    ["verdict: execution-flaw\n\nThe empty-cart case throws.", "execution-flaw", "The empty-cart case throws."],
    ["verdict: design-flaw\n\nThe Ticket asks for two contradictory things.", "design-flaw", "The Ticket asks for two contradictory things."],
    ["verdict: pass\n\nLooks good.", "pass", "Looks good."],
  ])("the Verdict line in %j is posted as a %s Verdict from the Reviewer", (output, verdict, findings) => {
    const plan = planFor(reviewed(output), snapshotOfPullRequest(aPullRequest()), kitConfig());

    const [body] = commentsOf(plan);
    expect(verdictsPostedIn([body!])).toEqual([{ verdict, source: "reviewer", requestChanges: false, headSha: HEAD_SHA }]);
    expect(body).toContain(findings);
    expect(body).toContain(`[The run](${RUN})`);
  });

  it("a pass takes the PR out of draft and requests the Operator's review, its only notification", () => {
    const plan = planFor(
      reviewed("verdict: pass\n\nLooks good, @someone."),
      snapshotOfPullRequest(aPullRequest(), { operator: "jrey" }),
      kitConfig(),
    );

    expect(actionsOf(plan).filter((action) => action.kind !== "comment")).toEqual([
      { kind: "mark-ready-for-review", pullRequest: 50 },
      { kind: "request-review", pullRequest: 50, reviewer: "jrey" },
    ]);
    expect(notificationsOf(plan, "jrey")).toEqual(["review request on #50"]);
    // The Reviewer's findings mention nobody.
    expect(commentsOf(plan)[0]).not.toMatch(/@someone/);
  });

  it("an Execution-flaw Verdict is posted and starts a retry: it doesn't leave draft or notify anyone", () => {
    const plan = planFor(reviewed("verdict: execution-flaw\n\nFix the build."), snapshotOfPullRequest(aPullRequest()), kitConfig());

    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["comment", "add-labels"]);
    expect(notificationsOf(plan)).toEqual([]);
  });

  it.each([
    ["an empty reply", ""],
    ["a reply of only whitespace", "  \n\n "],
    ["a reply with no Verdict line", "The PR looks fine to me."],
    ["a Verdict line that isn't first", "Here is my review.\nverdict: pass"],
    ["an unknown verdict", "verdict: approve\n\nShip it."],
    ["a capitalised Verdict line", "Verdict: pass"],
    ["a Verdict line with more after it", "verdict: pass, mostly\n\nOne nit."],
    ["two verdicts on the line", "verdict: pass verdict: design-flaw"],
  ])("%s is an Infrastructure failure, never a pass", (_, output) => {
    const plan = planFor(reviewed(output), snapshotOfPullRequest(aPullRequest()), kitConfig());

    expect(plan).toMatchObject({ kind: "fail", failure: "infrastructure" });
  });
});
