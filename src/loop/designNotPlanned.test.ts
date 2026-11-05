import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, notificationsOf, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { LoopEvent } from "./types.ts";

const notPlanned = { kind: "not-planned", comment: "The Operator decided the cart stays as it is: nobody asked for it." };

function finished(output: unknown): LoopEvent {
  return { kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(output) };
}

describe("A Design session finishes as not planned", () => {
  it("posts the closing comment, swaps needs-design for wontfix, and closes the issue as not planned", () => {
    const issue = anIssue({ number: 7, labels: ["enhancement", "needs-design"] });

    expect(planFor(finished(notPlanned), snapshotOf(issue), kitConfig())).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 7,
          body: "**Design session finished.** This issue won't be built, so the Kit closes it as not planned.\n\nThe Operator decided the cart stays as it is: nobody asked for it.",
        },
        { kind: "remove-label", issue: 7, label: "needs-design" },
        { kind: "add-labels", issue: 7, labels: ["wontfix"] },
        { kind: "close", issue: 7, reason: "not_planned" },
        { kind: "check-design-queue" },
      ],
    });
  });

  it.each([
    ["an empty comment", { kind: "not-planned", comment: " " }],
    ["no comment", { kind: "not-planned" }],
  ])("fails the turn as an Infrastructure failure, changing nothing, with %s", (_, output) => {
    const issue = anIssue({ number: 7, labels: ["enhancement", "needs-design"] });

    expect(planFor(finished(output), snapshotOf(issue), kitConfig())).toMatchObject({
      kind: "fail",
      failure: "infrastructure",
      reason: expect.stringContaining("not-planned needs non-empty comment text"),
    });
  });

  it("notifies nobody", () => {
    const issue = anIssue({ number: 7, labels: ["enhancement", "needs-design"] });
    const plan = planFor(finished({ ...notPlanned, comment: "@jrey said no." }), snapshotOf(issue, { operator: "jrey" }), kitConfig());

    expect(notificationsOf(plan, "jrey")).toEqual([]);
  });

  it("on a Ticket back from a Spec, closes it as not planned and says which Tickets stay blocked by it", () => {
    const ticket = anIssue({ number: 7, parent: 3, labels: ["enhancement", "needs-design"], openBlocking: [8, 9] });

    expect(planFor(finished(notPlanned), snapshotOf(ticket), kitConfig())).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 7,
          body: [
            "**Design session finished.** This issue won't be built, so the Kit closes it as not planned.",
            "",
            "The Operator decided the cart stays as it is: nobody asked for it.",
            "",
            "#8, #9 stay blocked by it: an issue closed as not planned never lands its work, so Dispatch won't start them until the Operator removes the blocked-by edge.",
          ].join("\n"),
        },
        { kind: "remove-label", issue: 7, label: "needs-design" },
        { kind: "add-labels", issue: 7, labels: ["wontfix"] },
        { kind: "close", issue: 7, reason: "not_planned" },
        { kind: "check-design-queue" },
      ],
    });
  });
});
