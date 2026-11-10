import { describe, expect, it } from "vitest";
import { aPullRequest, aTicket, dispatchSnapshotOf, kitConfig, snapshotOfPullRequest, tickSnapshot, withoutNotes } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan } from "./types.ts";

// GitHub sometimes leaves a Ticket open after a PR that closes it merged (#543).
// Its work has landed, so no Implement run starts on it again, and only the
// scheduled tick closes it: GitHub may not yet have closed it right after a merge.

const tick: LoopEvent = { kind: "scheduled-tick", now: "2026-11-10T04:00:00.000Z" };

function actionsOf(plan: Plan): readonly Action[] {
  return plan.kind === "act" ? plan.actions : [];
}

/** What the plan does to these issues, leaving out the queue checks every tick asks for. */
function actionsOn(plan: Plan, issues: readonly number[]): readonly Action[] {
  return actionsOf(plan).filter((action) => "issue" in action && issues.includes(action.issue));
}

describe("The scheduled tick, on a Ticket GitHub left open after its PR merged (#543)", () => {
  const leftOpen = aTicket({ number: 130, labels: ["bug", "ready-for-agent"], mergedLinkedPullRequests: [131] });

  it("comments naming the merged PR, then closes the Ticket as completed, adding no agent:implement", () => {
    const plan = planFor(tick, tickSnapshot({ readyTickets: [leftOpen] }), kitConfig());

    expect(actionsOn(plan, [130])).toEqual([
      {
        kind: "comment",
        issue: 130,
        body: "PR #131 merged, but GitHub left this Ticket open, so the Kit closed it as completed.",
      },
      { kind: "close", issue: 130, reason: "completed" },
    ]);
  });

  it("names every merged PR when more than one closes it", () => {
    const plan = planFor(tick, tickSnapshot({ readyTickets: [{ ...leftOpen, mergedLinkedPullRequests: [131, 140] }] }), kitConfig());

    expect(actionsOn(plan, [130])[0]).toMatchObject({
      body: "PRs #131 and #140 merged, but GitHub left this Ticket open, so the Kit closed it as completed.",
    });
  });

  // "Closes #N" says the same whoever wrote it, and the adapter reads no author for this.
  it("closes one whose merged PR a person opened the same way", () => {
    const human = aTicket({ number: 234, mergedLinkedPullRequests: [240], openLinkedPullRequests: [] });

    const plan = planFor(tick, tickSnapshot({ readyTickets: [human] }), kitConfig());

    expect(actionsOn(plan, [234]).map((action) => action.kind)).toEqual(["comment", "close"]);
  });

  it("closes each such Ticket, lowest number first, and leaves the others alone", () => {
    const tickets = [
      aTicket({ number: 9, mergedLinkedPullRequests: [20] }),
      aTicket({ number: 3 }),
      aTicket({ number: 5, mergedLinkedPullRequests: [21] }),
      aTicket({ number: 7, openLinkedPullRequests: [22] }),
    ];

    const plan = planFor(tick, tickSnapshot({ readyTickets: tickets }), kitConfig());

    expect(actionsOf(plan).flatMap((action) => (action.kind === "close" ? [action.issue] : []))).toEqual([5, 9]);
  });

  it("changes nothing else the tick plans when no Ticket's PR has merged", () => {
    const plan = planFor(tick, tickSnapshot({ readyTickets: [aTicket({ number: 3 }), aTicket({ number: 7, openLinkedPullRequests: [22] })] }), kitConfig());

    expect(withoutNotes(plan)).toEqual(withoutNotes(planFor(tick, tickSnapshot(), kitConfig())));
  });

  it("fails rather than guess when the snapshot is missing the Tickets", () => {
    const plan = planFor(tick, tickSnapshot({ readyTickets: null }), kitConfig());

    expect(plan).toMatchObject({ kind: "fail", failure: "infrastructure" });
  });
});

describe("A Dispatch check, on a Ticket GitHub left open after its PR merged (#543)", () => {
  it("doesn't release it, nor comment on or close it, as GitHub may not have closed it yet", () => {
    const plan = planFor({ kind: "dispatch-check" }, dispatchSnapshotOf([aTicket({ number: 130, mergedLinkedPullRequests: [131] })]), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: "No Ticket can be dispatched: #130's PR #131 has merged" });
  });

  it("releases the next eligible Ticket past it", () => {
    const tickets = [aTicket({ number: 130, mergedLinkedPullRequests: [131] }), aTicket({ number: 135 })];

    const plan = planFor({ kind: "dispatch-check" }, dispatchSnapshotOf(tickets), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "add-labels", issue: 135, labels: ["agent:implement"] }] });
  });
});

describe("An agent PR merging (#543)", () => {
  it("only asks for a Dispatch check: it neither comments on nor closes its Ticket", () => {
    const merged: LoopEvent = { kind: "pull-request-closed", pullRequest: 131, merged: true, closedByBot: false };
    const pullRequest = aPullRequest({ number: 131, ticket: 130, open: false, ticketLabels: ["bug", "ready-for-agent"] });

    expect(actionsOf(planFor(merged, snapshotOfPullRequest(pullRequest), kitConfig()))).toEqual([{ kind: "check-dispatch" }]);
  });
});
