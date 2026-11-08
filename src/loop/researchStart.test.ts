import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
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
  ])("agent:research on %s comes off, starting nothing, and one comment says why (#417)", (_subject, decision, reason) => {
    const plan = planFor(labelled(), snapshotOf(decision), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 12, label: "agent:research" },
        { kind: "comment", issue: 12, body: `agent:research came off and nothing started: ${reason}.` },
      ],
    });
  });
});
