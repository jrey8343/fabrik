import { describe, expect, it } from "vitest";
import {
  anIssue,
  aPullRequest,
  aTicket,
  dispatchSnapshotOf,
  kitConfig,
  snapshotOf,
  snapshotOfPullRequest,
} from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";

const check = { kind: "dispatch-check" } as const;

describe("A Dispatch check", () => {
  it("adds agent:implement to an eligible Ticket", () => {
    const plan = planFor(check, dispatchSnapshotOf([aTicket({ number: 12 })]), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [{ kind: "add-labels", issue: 12, labels: ["agent:implement"] }],
    });
  });

  it.each([
    ["is closed", { open: false }, "#12 is closed"],
    ["isn't ready-for-agent", { labels: ["enhancement", "needs-design"] }, "#12 isn't ready-for-agent"],
    ["has an open blocker", { openBlockers: [9] }, "#12 is blocked by #9"],
    ["has open blockers", { openBlockers: [9, 10] }, "#12 is blocked by #9, #10"],
    ["has sub-issues, so it's a Spec", { subIssues: 3 }, "#12 has sub-issues, so it's a Spec"],
    ["has an open linked PR", { openLinkedPullRequests: [40] }, "#12 already has the open PR #40"],
    [
      "already has agent:implement",
      { labels: ["ready-for-agent", "agent:implement"] },
      "#12 already has agent:implement",
    ],
  ])("doesn't dispatch a Ticket that %s, saying why", (_, overrides, why) => {
    const plan = planFor(check, dispatchSnapshotOf([aTicket({ number: 12, ...overrides })]), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: `No Ticket can be dispatched: ${why}` });
  });

  it("dispatches nothing when no issue is ready-for-agent", () => {
    const plan = planFor(check, dispatchSnapshotOf([]), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: "No Ticket can be dispatched: none is ready-for-agent" });
  });

  it("passes over an ineligible Ticket to dispatch an eligible one", () => {
    const plan = planFor(
      check,
      dispatchSnapshotOf([aTicket({ number: 3, openBlockers: [2] }), aTicket({ number: 5 })]),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [{ kind: "add-labels", issue: 5, labels: ["agent:implement"] }],
    });
  });
});

describe("The max_in_flight cap", () => {
  const three = [aTicket({ number: 4 }), aTicket({ number: 5 }), aTicket({ number: 6 })];
  const dispatched = (plan: ReturnType<typeof planFor>) =>
    plan.kind === "act" ? plan.actions.map((action) => ("issue" in action ? action.issue : null)) : [];

  it("dispatches up to the default of 2 when nothing is in flight", () => {
    const plan = planFor(check, dispatchSnapshotOf(three), kitConfig());

    expect(dispatched(plan)).toEqual([4, 5]);
  });

  it("counts an open agent draft PR against the cap", () => {
    const plan = planFor(check, dispatchSnapshotOf(three, { openAgentDraftPullRequests: 1 }), kitConfig());

    expect(dispatched(plan)).toEqual([4]);
  });

  it("counts an Implement run in progress against the cap", () => {
    const plan = planFor(check, dispatchSnapshotOf(three, { implementRunsInProgress: 1 }), kitConfig());

    expect(dispatched(plan)).toEqual([4]);
  });

  it("counts a dispatched Ticket whose Implement run hasn't started against the cap", () => {
    const waiting = aTicket({ number: 2, labels: ["ready-for-agent", "agent:implement"] });

    const plan = planFor(check, dispatchSnapshotOf([waiting, ...three]), kitConfig());

    expect(dispatched(plan)).toEqual([4]);
  });

  it("dispatches nothing when draft PRs plus runs in progress fill the cap, saying why", () => {
    const plan = planFor(
      check,
      dispatchSnapshotOf(three, { openAgentDraftPullRequests: 1, implementRunsInProgress: 1 }),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "nothing",
      reason:
        "max_in_flight is 2 and 2 are in flight (1 open agent draft PR, 1 Implement run in progress, 0 dispatched and waiting), so #4, #5 and #6 wait",
    });
  });

  it("dispatches nothing when more than the cap is in flight, as after lowering max_in_flight", () => {
    const plan = planFor(check, dispatchSnapshotOf(three, { openAgentDraftPullRequests: 3 }), kitConfig());

    expect(plan.kind).toBe("nothing");
  });

  it("uses the Kit config's max_in_flight", () => {
    const four = [...three, aTicket({ number: 7 })];

    const plan = planFor(check, dispatchSnapshotOf(four, { implementRunsInProgress: 1 }), kitConfig({ maxInFlight: 4 }));

    expect(dispatched(plan)).toEqual([4, 5, 6]);
  });
});

describe("What triggers a Dispatch check", () => {
  const checkDispatch = { kind: "act", actions: [{ kind: "check-dispatch" }] };

  it("an issue closing, which frees a slot or unblocks a Ticket", () => {
    const issue = anIssue({ number: 9, labels: ["enhancement", "ready-for-agent"] });

    const plan = planFor({ kind: "issue-closed", issue: 9 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual(checkDispatch);
  });

  it("the Fast path, after Triage's labels land", () => {
    const issue = anIssue({ number: 7, labels: ["needs-triage"] });
    const output = JSON.stringify({
      category: "bug",
      state: "ready-for-agent",
      comment: "All five Fast-path tests pass.",
      brief: { summary: "Fix the typo.", acceptanceCriteria: ["The heading reads Physiotherapy"] },
    });

    const plan = planFor({ kind: "agent-run-finished", role: "triage", issue: 7, output }, snapshotOf(issue), kitConfig());

    expect(plan.kind === "act" && plan.actions.at(-1)).toEqual({ kind: "check-dispatch" });
  });

  it.each(["needs-design", "needs-info", "ready-for-human", "wontfix"])(
    "not a Triage outcome of %s, which doesn't make anything ready",
    (state) => {
      const issue = anIssue({ number: 7, labels: ["needs-triage"] });
      const output = JSON.stringify({ category: "bug", state, comment: "Sorted." });

      const plan = planFor({ kind: "agent-run-finished", role: "triage", issue: 7, output }, snapshotOf(issue), kitConfig());

      expect(plan.kind === "act" && plan.actions).not.toContainEqual({ kind: "check-dispatch" });
    },
  );

  it.each(["pull-request-left-draft", "pull-request-closed"] as const)(
    "an agent PR's %s event, which frees a slot",
    (kind) => {
      const plan = planFor({ kind, pullRequest: 50 }, snapshotOfPullRequest(aPullRequest({ number: 50 })), kitConfig());

      expect(plan).toEqual(checkDispatch);
    },
  );

  it.each(["pull-request-left-draft", "pull-request-closed"] as const)(
    "not the %s event of a PR the Fabrik App didn't open, which holds no slot",
    (kind) => {
      const pullRequest = aPullRequest({ number: 50, isAgent: false });

      const plan = planFor({ kind, pullRequest: 50 }, snapshotOfPullRequest(pullRequest), kitConfig());

      expect(plan).toEqual({ kind: "nothing", reason: "#50 isn't an agent PR" });
    },
  );
});

describe("Dispatch order", () => {
  it("releases the oldest Ticket (lowest issue number) first", () => {
    const tickets = [aTicket({ number: 31 }), aTicket({ number: 8 }), aTicket({ number: 17 })];

    const plan = planFor(check, dispatchSnapshotOf(tickets, { openAgentDraftPullRequests: 1 }), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [{ kind: "add-labels", issue: 8, labels: ["agent:implement"] }],
    });
  });

  it("releases several Tickets in issue-number order", () => {
    const tickets = [aTicket({ number: 31 }), aTicket({ number: 8 }), aTicket({ number: 17 })];

    const plan = planFor(check, dispatchSnapshotOf(tickets), kitConfig({ maxInFlight: 5 }));

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "add-labels", issue: 8, labels: ["agent:implement"] },
        { kind: "add-labels", issue: 17, labels: ["agent:implement"] },
        { kind: "add-labels", issue: 31, labels: ["agent:implement"] },
      ],
    });
  });
});
