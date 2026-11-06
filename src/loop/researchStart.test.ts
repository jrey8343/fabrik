import { describe, expect, it } from "vitest";
import { anIssue, aTicket, dispatchSnapshotOf, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { planFor } from "./rules.ts";

const labelled = (issue = 12) => ({ kind: "label-added", issue, label: "agent:research" }) as const;

/** An open research Decision under the open Map #3, labelled to start its Researcher run. */
const aDecision = (overrides: Parameters<typeof anIssue>[0] = {}) =>
  anIssue({
    number: 12,
    labels: ["wayfinder:research", "agent:research"],
    parent: 3,
    parentIssue: { number: 3, open: true, labels: ["enhancement", "wayfinder:map"] },
    ...overrides,
  });

describe("Starting a Researcher", () => {
  it("agent:research on an open research Decision under an open Map starts a research run on roles.research and takes the label off", () => {
    const config = kitConfig({
      roles: { ...DEFAULT_KIT_CONFIG.roles, research: { model: "claude-researcher", effort: "high", timeoutMinutes: 25 } },
    });

    const plan = planFor(labelled(), snapshotOf(aDecision()), config);

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 12, label: "agent:research" },
        {
          kind: "start-agent-run",
          role: "research",
          issue: 12,
          model: "claude-researcher",
          effort: "high",
          timeoutMinutes: 25,
          subscription: "Claude token",
        },
      ],
    });
  });

  it.each([
    ["a closed Decision", aDecision({ open: false }), "#12 is closed"],
    [
      "a grilling Decision",
      aDecision({ labels: ["wayfinder:grilling", "agent:research"] }),
      "#12 has no wayfinder:research label, so it isn't a research Decision",
    ],
    [
      "a Decision under a closed Map",
      aDecision({ parentIssue: { number: 3, open: false, labels: ["enhancement", "wayfinder:map"] } }),
      "#12's Map #3 is closed",
    ],
    ["a Decision with no parent", aDecision({ parent: null, parentIssue: null }), "#12 isn't a sub-issue of a Map"],
    [
      "a Decision whose parent isn't a Map",
      aDecision({ parentIssue: { number: 3, open: true, labels: ["enhancement", "ready-for-agent"] } }),
      "#12's parent #3 has no wayfinder:map label, so it isn't a Map",
    ],
  ])("agent:research on %s starts nothing, and says why", (_subject, decision, reason) => {
    const plan = planFor(labelled(), snapshotOf(decision), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason });
  });
});

describe("A Dispatch check, while nothing adds agent:research yet", () => {
  const ready = {
    number: 12,
    open: true,
    labels: ["wayfinder:research"],
    assignees: [],
    openBlockers: [],
    parentIssue: { number: 3, open: true, labels: ["wayfinder:map"] },
    lastRunFailed: false,
  };

  it("releases its Tickets as before, and no research Decision, however ready", () => {
    const plan = planFor({ kind: "dispatch-check" }, dispatchSnapshotOf([aTicket({ number: 7 })], { researchDecisions: [ready] }), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "add-labels", issue: 7, labels: ["agent:implement"] }] });
  });

  it("releases nothing when a research Decision is all it has", () => {
    const plan = planFor({ kind: "dispatch-check" }, dispatchSnapshotOf([], { researchDecisions: [ready] }), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: "No Ticket can be dispatched: none is ready-for-agent" });
  });
});
