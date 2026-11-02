import { describe, expect, it } from "vitest";
import {
  anIssue,
  aPullRequest,
  HEAD_SHA,
  kitConfig,
  notificationsOf,
  snapshotOf,
  snapshotOfPullRequest,
} from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan, Snapshot, VerdictRecord } from "./types.ts";
import { verdictsIn } from "./verdict.ts";

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

describe("An Execution flaw starts a retry", () => {
  it.each([
    ["the Reviewer's Execution flaw", reviewed("verdict: execution-flaw\n\nThe empty-cart case throws.")],
    ["red CI", redChecks()],
  ])("%s adds agent:retry to the PR, which starts the Implementer again", (_, event) => {
    const plan = planFor(event, snapshotOfPullRequest(aPullRequest()), kitConfig());

    expect(actionsOf(plan)).toContainEqual({ kind: "add-labels", issue: 50, labels: ["agent:retry"] });
  });

  it("a pass or a Design flaw starts no retry", () => {
    for (const output of ["verdict: pass", "verdict: design-flaw\n\nWrong approach."]) {
      const plan = planFor(reviewed(output), snapshotOfPullRequest(aPullRequest()), kitConfig());
      expect(actionsOf(plan)).not.toContainEqual({ kind: "add-labels", issue: 50, labels: ["agent:retry"] });
    }
  });
});

const retryLabeled: LoopEvent = { kind: "pull-request-labeled", pullRequest: 50, label: "agent:retry" };

/** A PR whose latest Verdict, on its head, is an Execution flaw, after these earlier Verdicts. */
function flawedPullRequest(before: readonly VerdictRecord[] = [], latest: Partial<VerdictRecord> = {}) {
  return aPullRequest({
    labels: ["agent:retry"],
    verdicts: [...before, earlier("execution-flaw", { headSha: HEAD_SHA, ...latest })],
  });
}

describe("Starting a retry", () => {
  it("the first Execution flaw starts the Implementer on its default model, on the PR, and takes agent:retry off", () => {
    const config = kitConfig();
    const plan = planFor(retryLabeled, snapshotOfPullRequest(flawedPullRequest()), config);

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 50, label: "agent:retry" },
        {
          kind: "start-agent-run",
          role: "implement",
          issue: 7,
          pullRequest: 50,
          model: "claude-sonnet-5-5",
          effort: config.roles.implement.effort,
          timeoutMinutes: 60,
        },
      ],
    });
  });

  it("the second Execution flaw starts a Step-up, on the Step-up model", () => {
    const config = kitConfig();
    const plan = planFor(retryLabeled, snapshotOfPullRequest(flawedPullRequest([earlier("execution-flaw")])), config);

    expect(actionsOf(plan)[1]).toMatchObject({
      kind: "start-agent-run",
      role: "implement",
      model: "claude-opus-5-5",
      effort: config.roles.stepUp.effort,
    });
  });

  it("a Step-up uses whatever model Kit config gives the Step-up", () => {
    const base = kitConfig();
    const config = kitConfig({
      roles: { ...base.roles, stepUp: { ...base.roles.stepUp, model: "claude-opus-6", effort: "high" } },
    });
    const pullRequest = flawedPullRequest([earlier("execution-flaw", { source: "ci" })]);
    const plan = planFor(retryLabeled, snapshotOfPullRequest(pullRequest), config);

    expect(actionsOf(plan)[1]).toMatchObject({ model: "claude-opus-6", effort: "high" });
  });

  it("the retry count ignores Verdicts from a Request-changes run", () => {
    const pullRequest = flawedPullRequest([
      earlier("execution-flaw", { requestChanges: true }),
      earlier("execution-flaw", { requestChanges: true }),
    ]);
    const plan = planFor(retryLabeled, snapshotOfPullRequest(pullRequest), kitConfig());

    expect(actionsOf(plan)[1]).toMatchObject({ kind: "start-agent-run", model: "claude-sonnet-5-5" });
  });

  it("an Execution flaw from a Request-changes run still gets a retry, counted from the flaws before it", () => {
    const pullRequest = flawedPullRequest([earlier("execution-flaw")], { requestChanges: true });
    const plan = planFor(retryLabeled, snapshotOfPullRequest(pullRequest), kitConfig());

    expect(actionsOf(plan)[1]).toMatchObject({ kind: "start-agent-run", model: "claude-opus-5-5" });
  });

  it("passes and Design flaws earlier on the PR don't count", () => {
    const pullRequest = flawedPullRequest([earlier("pass"), earlier("design-flaw")]);
    const plan = planFor(retryLabeled, snapshotOfPullRequest(pullRequest), kitConfig());

    expect(actionsOf(plan)[1]).toMatchObject({ kind: "start-agent-run", model: "claude-sonnet-5-5" });
  });

  it("re-adding agent:retry after an Infrastructure failure runs the same retry again, so the failure uses none up", () => {
    // The failed retry pushed nothing, so the PR's head and its Verdicts are as they were.
    const pullRequest = flawedPullRequest();
    const first = planFor(retryLabeled, snapshotOfPullRequest(pullRequest), kitConfig());
    const again = planFor(retryLabeled, snapshotOfPullRequest(pullRequest), kitConfig());

    expect(again).toEqual(first);
    expect(actionsOf(again)[1]).toMatchObject({ model: "claude-sonnet-5-5" });
  });

  it("a third Execution flaw starts no retry", () => {
    const pullRequest = flawedPullRequest([earlier("execution-flaw"), earlier("execution-flaw", { source: "ci" })]);
    const plan = planFor(retryLabeled, snapshotOfPullRequest(pullRequest), kitConfig());

    expect(startedRuns(plan)).toEqual([]);
  });

  it.each([
    ["has no Verdict", aPullRequest({ labels: ["agent:retry"] })],
    ["has a pass as its latest Verdict", aPullRequest({ verdicts: [earlier("pass", { headSha: HEAD_SHA })] })],
    ["has moved on from its Execution flaw", flawedPullRequest([], { headSha: "b".repeat(40) })],
    ["is a person's PR", aPullRequest({ isAgent: false, verdicts: flawedPullRequest().verdicts })],
    ["has left draft", aPullRequest({ draft: false, verdicts: flawedPullRequest().verdicts })],
    ["is closed", aPullRequest({ open: false, verdicts: flawedPullRequest().verdicts })],
  ])("agent:retry on a PR that %s starts no Implementer", (_, pullRequest) => {
    const plan = planFor(retryLabeled, snapshotOfPullRequest(pullRequest), kitConfig());

    expect(startedRuns(plan)).toEqual([]);
  });
});

function startedRuns(plan: Plan): Action[] {
  return plan.kind === "act" ? plan.actions.filter((action) => action.kind === "start-agent-run") : [];
}

describe("A Verdict when the retries are used up", () => {
  it("a third Execution flaw is posted but starts no retry (it goes back to design: backToDesign.test.ts)", () => {
    const pullRequest = aPullRequest({ verdicts: [earlier("execution-flaw"), earlier("execution-flaw", { source: "ci" })] });
    const plan = planFor(reviewed("verdict: execution-flaw\n\nStill throws."), snapshotOfPullRequest(pullRequest), kitConfig());

    expect(actionsOf(plan)[0]).toMatchObject({ kind: "comment", issue: 50 });
    expect(actionsOf(plan)).not.toContainEqual({ kind: "add-labels", issue: 50, labels: ["agent:retry"] });
  });
});

/** The retry's push job: the PR it fixed, at the head it built on, and what its new commits change. */
function retried(
  overrides: Partial<Extract<LoopEvent, { kind: "implement-run-finished" }>> = {},
): Extract<LoopEvent, { kind: "implement-run-finished" }> {
  return {
    kind: "implement-run-finished",
    issue: 7,
    output: JSON.stringify({ title: "Handle the empty cart", summary: "Guards the empty-cart case, @someone." }),
    branch: "fabrik/ticket-7",
    base: "fabrik/ticket-7",
    changes: { net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }] },
    fixes: { pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN },
    ...overrides,
  };
}

/** The retry push job's snapshot: the Ticket and the PR it fixes. */
function retrySnapshot(pullRequest = flawedPullRequest(), ticket = anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] })): Snapshot {
  return { ...snapshotOfPullRequest(pullRequest, { operator: "jrey" }), issue: ticket };
}

describe("A retry's branch", () => {
  it("is pushed onto the same branch, opens no new PR, and leaves a silent note with the Implementer's summary", () => {
    const plan = planFor(retried(), retrySnapshot(), kitConfig());

    const actions = actionsOf(plan);
    expect(actions[0]).toEqual({ kind: "push-branch", branch: "fabrik/ticket-7" });
    expect(actions.map((action) => action.kind)).toEqual(["push-branch", "comment"]);
    expect(actions[1]).toMatchObject({ kind: "comment", issue: 50 });
    expect(actions[1]).toHaveProperty("body", expect.stringContaining("Guards the empty-cart case"));
    expect(notificationsOf(plan, "jrey")).toEqual([]);
    expect(actions[1]).not.toHaveProperty("body", expect.stringContaining("@someone"));
  });

  it.each([
    ["the PR has moved on from the head the retry built on", flawedPullRequest([], { headSha: "b".repeat(40) }), { headSha: "b".repeat(40) }],
    ["the PR has left draft", aPullRequest({ draft: false }), {}],
    ["the PR is closed", aPullRequest({ open: false }), {}],
    ["the PR is for another Ticket", aPullRequest({ ticket: 8 }), {}],
  ])("isn't pushed when %s", (_, pullRequest, prOverrides) => {
    const plan = planFor(retried(), retrySnapshot({ ...pullRequest, ...prOverrides }), kitConfig());

    expect(plan.kind).toBe("nothing");
  });

  it("isn't pushed when the Ticket has left ready-for-agent", () => {
    const plan = planFor(retried(), retrySnapshot(flawedPullRequest(), anIssue({ number: 7, labels: ["needs-design"] })), kitConfig());

    expect(plan.kind).toBe("nothing");
  });

  it("that touches a trust root goes to the Operator unpushed, as a first run's would", () => {
    const plan = planFor(
      retried({ changes: { net: [{ path: "AGENTS.md" }], commits: [{ path: "AGENTS.md" }] } }),
      retrySnapshot(),
      kitConfig(),
    );

    const actions = actionsOf(plan);
    expect(actions.map((action) => action.kind)).not.toContain("push-branch");
    expect(actions).toContainEqual({ kind: "assign", issue: 7, assignee: "jrey" });
  });

  it("that changes nothing is an Execution flaw on the PR, and starts the next retry", () => {
    const plan = planFor(retried({ changes: { net: [], commits: [] } }), retrySnapshot(), kitConfig());

    const actions = actionsOf(plan);
    expect(actions.map((action) => action.kind)).not.toContain("push-branch");
    const comments = actions.flatMap((action) => (action.kind === "comment" ? [action.body] : []));
    expect(verdictsIn(comments)).toEqual([
      { verdict: "execution-flaw", source: "empty-diff", requestChanges: false, headSha: HEAD_SHA },
    ]);
    expect(actions).toContainEqual({ kind: "add-labels", issue: 50, labels: ["agent:retry"] });
    expect(notificationsOf(plan, "jrey")).toEqual([]);
  });

  it("that changes nothing on the second retry starts no third", () => {
    const plan = planFor(
      retried({ changes: { net: [], commits: [] } }),
      retrySnapshot(flawedPullRequest([earlier("execution-flaw")])),
      kitConfig(),
    );

    expect(actionsOf(plan)).not.toContainEqual({ kind: "add-labels", issue: 50, labels: ["agent:retry"] });
  });

  it("output that breaks the Implementer's contract is an Infrastructure failure and pushes nothing", () => {
    const plan = planFor(retried({ output: "{}" }), retrySnapshot(), kitConfig());

    expect(plan).toMatchObject({ kind: "fail", failure: "infrastructure" });
  });
});

describe("A retry that fails for Infrastructure", () => {
  it("names agent:retry on the PR as the label to re-add, and uses up no retry", () => {
    const plan = planFor(
      {
        kind: "agent-run-failed",
        role: "implement",
        issue: 7,
        runUrl: RUN,
        jobResult: "cancelled",
        secretsStep: "success",
        report: null,
      },
      snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"], openPullRequests: [50] })),
      kitConfig(),
    );

    const actions = actionsOf(plan);
    expect(actions).toContainEqual({ kind: "remove-label", issue: 50, label: "agent:retry" });
    const [body] = actions.flatMap((action) => (action.kind === "comment" ? [action.body] : []));
    expect(body).toContain("Re-add the `agent:retry` label to run it again");
    expect(verdictsIn([body!])).toEqual([]);
  });
});

describe("Retries stay silent", () => {
  it.each([
    ["the Reviewer's first Execution flaw", [], reviewed("verdict: execution-flaw\n\nThe empty-cart case throws, @someone.")],
    ["red CI", [], redChecks()],
    ["the second Execution flaw, a Step-up", [earlier("execution-flaw")], reviewed("verdict: execution-flaw\n\nStill throws.")],
  ])("%s notifies nobody", (_, before, event) => {
    const pullRequest = aPullRequest({ verdicts: before });
    const plan = planFor(event, snapshotOfPullRequest(pullRequest, { operator: "jrey" }), kitConfig());

    expect(actionsOf(plan)).toContainEqual({ kind: "add-labels", issue: 50, labels: ["agent:retry"] });
    expect(notificationsOf(plan, "jrey")).toEqual([]);
  });

  it("starting a retry, plain or Step-up, notifies nobody", () => {
    for (const before of [[], [earlier("execution-flaw")]]) {
      const plan = planFor(retryLabeled, snapshotOfPullRequest(flawedPullRequest(before)), kitConfig());
      expect(startedRuns(plan)).toHaveLength(1);
      expect(notificationsOf(plan)).toEqual([]);
    }
  });
});
