import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";

describe("Intake", () => {
  it("adds needs-triage to a plain new issue", () => {
    const issue = anIssue({ number: 7 });

    const plan = planFor({ kind: "issue-opened", issue: 7 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [{ kind: "add-labels", issue: 7, labels: ["needs-triage"] }],
    });
  });

  it.each([
    "needs-triage",
    "needs-info",
    "needs-design",
    "ready-for-agent",
    "ready-for-human",
    "wontfix",
  ])("leaves a new issue that already has the %s state alone, saying why", (state) => {
    const issue = anIssue({ number: 7, labels: ["bug", state] });

    const plan = planFor({ kind: "issue-opened", issue: 7 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({
      kind: "nothing",
      reason: `#7 already has the state label ${state}`,
    });
  });

  it.each(["wayfinder:map", "wayfinder:ticket"])(
    "leaves a new issue with the %s label alone, because a skill made it",
    (label) => {
      const issue = anIssue({ number: 7, labels: [label] });

      const plan = planFor({ kind: "issue-opened", issue: 7 }, snapshotOf(issue), kitConfig());

      expect(plan).toEqual({
        kind: "nothing",
        reason: `#7 has the label ${label}, so a skill made it`,
      });
    },
  );

  it("does not mistake a label that merely starts with wayfinder for a wayfinder label", () => {
    const issue = anIssue({ number: 7, labels: ["wayfinders"] });

    const plan = planFor({ kind: "issue-opened", issue: 7 }, snapshotOf(issue), kitConfig());

    expect(plan.kind).toBe("act");
  });

  it("leaves a new sub-issue alone, because a skill made it under its parent", () => {
    const issue = anIssue({ number: 7, parent: 3 });

    const plan = planFor({ kind: "issue-opened", issue: 7 }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({
      kind: "nothing",
      reason: "#7 is a sub-issue of #3, so a skill made it",
    });
  });
});
