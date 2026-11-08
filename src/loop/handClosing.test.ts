import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, kitConfig, snapshotOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan } from "./types.ts";

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

describe("Closing a Ticket by hand (#428)", () => {
  it("closes its open agent draft PR unmerged, saying why on the PR, before the Dispatch check its freed slot asks for", () => {
    const ticket = anIssue({ number: 9, open: false, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50], openAgentDrafts: [50] });

    const actions = actionsOf(planFor({ kind: "issue-closed", issue: 9 }, snapshotOf(ticket), kitConfig()));

    expect(actions.map((action) => action.kind)).toEqual(["comment", "close-pull-request", "check-dispatch", "check-design-queue"]);
    expect(actions[0]).toEqual({
      kind: "comment",
      issue: 50,
      body: "#9 was closed, so the Kit closed this PR unmerged, keeping its branch `fabrik/ticket-9`.",
    });
    expect(actions[1]).toEqual({ kind: "close-pull-request", pullRequest: 50 });
  });

  it("leaves an open PR that isn't its agent draft PR alone", () => {
    const ticket = anIssue({ number: 9, open: false, openPullRequests: [50], openAgentDrafts: [] });

    const actions = actionsOf(planFor({ kind: "issue-closed", issue: 9 }, snapshotOf(ticket), kitConfig()));

    expect(actions.map((action) => action.kind)).toEqual(["check-dispatch", "check-design-queue"]);
  });
});

describe("Closing an agent PR by hand (#428)", () => {
  const closedByHand: LoopEvent = { kind: "pull-request-closed", pullRequest: 50, merged: false, closedByBot: false };
  const readyTicket = aPullRequest({ number: 50, ticket: 7, open: false, ticketLabels: ["enhancement", "ready-for-agent"] });

  it("stops its Ticket rather than starting it again: ready-for-human, assigned to the Operator, with a comment saying how to run it again", () => {
    const actions = actionsOf(planFor(closedByHand, snapshotOfPullRequest(readyTicket), kitConfig()));

    expect(actions).toEqual([
      {
        kind: "comment",
        issue: 7,
        body: "#50 was closed unmerged by hand, so the Kit won't start another Implement run on this Ticket by itself, and its branch `fabrik/ticket-7` stays. To have an Implementer try again, mark it `ready-for-agent`: the new run starts from `main` and replaces that branch.",
      },
      { kind: "remove-label", issue: 7, label: "ready-for-agent" },
      { kind: "add-labels", issue: 7, labels: ["ready-for-human"] },
      { kind: "assign", issue: 7, assignee: "operator" },
      { kind: "check-dispatch" },
    ]);
  });

  it("stops it the same way when the PR had left draft for the Merge gate", () => {
    const actions = actionsOf(planFor(closedByHand, snapshotOfPullRequest({ ...readyTicket, draft: false }), kitConfig()));

    expect(actions.map((action) => action.kind)).toEqual(["comment", "remove-label", "add-labels", "assign", "check-dispatch"]);
  });

  it.each([
    ["the Kit closed it, as Send it back, back to design or a refusal does", { closedByBot: true }],
    ["it merged", { merged: true }],
  ])("only frees its slot when %s", (_, overrides) => {
    const plan = planFor({ ...closedByHand, ...overrides }, snapshotOfPullRequest(readyTicket), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "check-dispatch" }] });
  });

  it("only frees its slot when its Ticket has closed, so there's nothing left to stop", () => {
    const plan = planFor(closedByHand, snapshotOfPullRequest({ ...readyTicket, ticketOpen: false }), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "check-dispatch" }] });
  });

  it("only frees its slot when its Ticket is no longer ready-for-agent, so it was already stopped another way", () => {
    const pullRequest = { ...readyTicket, ticketLabels: ["enhancement", "needs-design"] };

    const plan = planFor(closedByHand, snapshotOfPullRequest(pullRequest), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "check-dispatch" }] });
  });
});
