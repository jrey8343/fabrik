import { describe, expect, it } from "vitest";
import {
  anIssue,
  aPullRequest,
  aResearchDecision,
  aTicket,
  dispatchSnapshotOf,
  kitConfig,
  HEAD_SHA,
  repoSnapshot,
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
    [
      "is blocked by an issue closed as not planned",
      { notPlannedBlockers: [9] },
      "#12 is blocked by #9, closed as not planned",
    ],
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

  it("counts a Ticket resuming its agent PR's run once, by its draft PR, not again by its label", () => {
    const resuming = aTicket({ number: 2, labels: ["ready-for-agent", "agent:implement"], openLinkedPullRequests: [50] });

    const plan = planFor(check, dispatchSnapshotOf([resuming, ...three], { openAgentDraftPullRequests: 1 }), kitConfig());

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

describe("A max_in_flight of 0, which pauses Dispatch", () => {
  const paused = kitConfig({ maxInFlight: 0 });

  it("dispatches no eligible Ticket, saying Dispatch is paused rather than counting what's in flight", () => {
    const plan = planFor(check, dispatchSnapshotOf([aTicket({ number: 4 }), aTicket({ number: 5 })]), paused);

    expect(plan).toEqual({
      kind: "nothing",
      reason: "Dispatch is paused because max_in_flight is 0, so #4 and #5 wait",
    });
  });

  it("still says why when no Ticket is eligible", () => {
    const plan = planFor(check, dispatchSnapshotOf([]), paused);

    expect(plan).toEqual({ kind: "nothing", reason: "No Ticket can be dispatched: none is ready-for-agent" });
  });

  it("dispatches again once max_in_flight is back above 0, holding the Tickets it had paused", () => {
    const tickets = [aTicket({ number: 4 }), aTicket({ number: 5 })];
    expect(planFor(check, dispatchSnapshotOf(tickets), paused).kind).toBe("nothing");

    const plan = planFor(check, dispatchSnapshotOf(tickets), kitConfig({ maxInFlight: 1 }));

    expect(plan).toEqual({
      kind: "act",
      actions: [{ kind: "add-labels", issue: 4, labels: ["agent:implement"] }],
    });
  });
});

describe("What triggers a Dispatch check", () => {
  const checkDispatch = { kind: "act", actions: [{ kind: "check-dispatch" }] };

  it("an issue closing, which frees a slot or unblocks a Ticket", () => {
    const issue = anIssue({ number: 9, labels: ["enhancement", "ready-for-agent"] });

    const plan = planFor({ kind: "issue-closed", issue: 9 }, snapshotOf(issue), kitConfig());

    expect(plan.kind === "act" && plan.actions).toContainEqual({ kind: "check-dispatch" });
  });

  it("a change to the Kit config, so raising max_in_flight from 0 resumes Dispatch straight away", () => {
    const plan = planFor({ kind: "kit-config-changed", head: HEAD_SHA }, repoSnapshot({ conflicts: { main: HEAD_SHA, now: "2026-01-01T00:00:00Z", implementJobUnderWay: null, pullRequests: [] } }), kitConfig());

    expect(plan.kind === "act" && plan.actions).toContainEqual({ kind: "check-dispatch" });
  });

  it("the Fast path, after Triage's labels land", () => {
    const issue = anIssue({ number: 7, labels: ["needs-triage"] });
    const output = JSON.stringify({
      category: "bug",
      state: "ready-for-agent",
      comment: "All six Fast-path tests pass.",
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

describe("A Dispatch check releasing research Decisions", () => {
  it("adds agent:research to an eligible research Decision", () => {
    const plan = planFor(check, dispatchSnapshotOf([], { researchDecisions: [aResearchDecision({ number: 12 })] }), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [{ kind: "add-labels", issue: 12, labels: ["agent:research"] }],
    });
  });

  it.each([
    ["is assigned, which claims it for the Operator", { assignees: ["jrey"] }, "#12 is assigned to jrey"],
    ["has an open blocker", { openBlockers: [9] }, "#12 is blocked by #9"],
    ["has open blockers", { openBlockers: [9, 10] }, "#12 is blocked by #9, #10"],
    [
      "already has agent:research",
      { labels: ["wayfinder:research", "agent:research"] },
      "#12 already has agent:research",
    ],
    [
      "had its last run fail",
      { lastRunFailed: true },
      "#12's last Research run failed, so only adding agent:research again runs it",
    ],
    [
      "is under a closed Map",
      { parentIssue: { number: 3, open: false, labels: ["wayfinder:map"] } },
      "#12's Map #3 is closed",
    ],
    ["is no sub-issue of a Map", { parentIssue: null }, "#12 isn't a sub-issue of a Map"],
    [
      "has a parent that isn't a Map",
      { parentIssue: { number: 3, open: true, labels: ["enhancement", "ready-for-agent"] } },
      "#12's parent #3 has no wayfinder:map label, so it isn't a Map",
    ],
    [
      "isn't a research Decision",
      { labels: ["wayfinder:grilling"] },
      "#12 has no wayfinder:research label, so it isn't a research Decision",
    ],
    ["is closed", { open: false }, "#12 is closed"],
  ])("doesn't release a research Decision that %s, saying why", (_, overrides, why) => {
    const snapshot = dispatchSnapshotOf([], { researchDecisions: [aResearchDecision({ number: 12, ...overrides })] });

    const plan = planFor(check, snapshot, kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: `No Ticket or research Decision can be dispatched: ${why}` });
  });
});

describe("The max_in_flight cap, shared by Implementers and the Researcher", () => {
  const three = [aTicket({ number: 4 }), aTicket({ number: 5 }), aTicket({ number: 6 })];
  const dispatched = (plan: ReturnType<typeof planFor>) =>
    plan.kind === "act" ? plan.actions.map((action) => ("issue" in action ? action.issue : null)) : [];

  it("counts a Research run in progress against the cap", () => {
    const plan = planFor(check, dispatchSnapshotOf(three, { researchRunsInProgress: 1 }), kitConfig());

    expect(dispatched(plan)).toEqual([4]);
  });

  it("counts a research Decision given agent:research whose Research run hasn't started against the cap", () => {
    const waiting = aResearchDecision({ number: 2, labels: ["wayfinder:research", "agent:research"] });

    const plan = planFor(check, dispatchSnapshotOf(three, { researchDecisions: [waiting] }), kitConfig());

    expect(dispatched(plan)).toEqual([4]);
  });

  it("doesn't count a research Decision given agent:research under a closed Map, whose Research run never starts", () => {
    const stranded = aResearchDecision({
      number: 2,
      labels: ["wayfinder:research", "agent:research"],
      parentIssue: { number: 3, open: false, labels: ["wayfinder:map"] },
    });

    const plan = planFor(check, dispatchSnapshotOf(three, { researchDecisions: [stranded] }), kitConfig());

    expect(dispatched(plan)).toEqual([4, 5]);
  });

  it("counts Research runs and research Decisions against the cap for Implementers and the Researcher alike, saying what fills it", () => {
    const snapshot = dispatchSnapshotOf([aTicket({ number: 4 })], {
      implementRunsInProgress: 1,
      researchRunsInProgress: 1,
      researchDecisions: [
        aResearchDecision({ number: 2, labels: ["wayfinder:research", "agent:research"] }),
        aResearchDecision({ number: 12 }),
      ],
    });

    const plan = planFor(check, snapshot, kitConfig({ maxInFlight: 3 }));

    expect(plan).toEqual({
      kind: "nothing",
      reason:
        "max_in_flight is 3 and 3 are in flight (0 open agent draft PRs, 1 Implement run in progress, 1 Research run in progress, 1 dispatched and waiting), so #4 and #12 wait",
    });
  });
});

describe("Dispatch order across Tickets and research Decisions", () => {
  it("gives the free slots to the lowest issue numbers, whether Ticket or research Decision", () => {
    const snapshot = dispatchSnapshotOf([aTicket({ number: 31 }), aTicket({ number: 8 })], {
      researchDecisions: [aResearchDecision({ number: 40 }), aResearchDecision({ number: 17 })],
    });

    const plan = planFor(check, snapshot, kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "add-labels", issue: 8, labels: ["agent:implement"] },
        { kind: "add-labels", issue: 17, labels: ["agent:research"] },
      ],
    });
  });

  it("releases a research Decision ahead of a newer Ticket when one slot is free", () => {
    const snapshot = dispatchSnapshotOf([aTicket({ number: 9 })], {
      openAgentDraftPullRequests: 1,
      researchDecisions: [aResearchDecision({ number: 5 })],
    });

    const plan = planFor(check, snapshot, kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "add-labels", issue: 5, labels: ["agent:research"] }] });
  });

  it("names every eligible Ticket and research Decision that waits, in issue-number order", () => {
    const snapshot = dispatchSnapshotOf([aTicket({ number: 9 })], {
      implementRunsInProgress: 2,
      researchDecisions: [aResearchDecision({ number: 12 }), aResearchDecision({ number: 5 })],
    });

    const plan = planFor(check, snapshot, kitConfig());

    expect(plan).toEqual({
      kind: "nothing",
      reason:
        "max_in_flight is 2 and 2 are in flight (0 open agent draft PRs, 2 Implement runs in progress, 0 dispatched and waiting), so #5, #9 and #12 wait",
    });
  });
});

describe("A max_in_flight of 0, with research Decisions to release", () => {
  it("releases neither Tickets nor research Decisions, saying Dispatch is paused", () => {
    const snapshot = dispatchSnapshotOf([aTicket({ number: 4 })], { researchDecisions: [aResearchDecision({ number: 12 })] });

    const plan = planFor(check, snapshot, kitConfig({ maxInFlight: 0 }));

    expect(plan).toEqual({ kind: "nothing", reason: "Dispatch is paused because max_in_flight is 0, so #4 and #12 wait" });
  });
});
