// The start check (#725): agent:implement on a Ticket with no open PR starts
// no first run while another Implement run on it is unlanded, its run's Push
// job not yet finished, unless that run has already posted its outcome on the
// Ticket, as an empty diff's, a Broken run's and a Kept-branch start-again's
// own push jobs do just before they add the label for the run after.
import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, HEAD_SHA, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, IssueSnapshot, Plan } from "./types.ts";

const dispatched = { kind: "label-added", issue: 310, label: "agent:implement" } as const;

const ticket = (overrides: Partial<IssueSnapshot> = {}) =>
  anIssue({ number: 310, labels: ["enhancement", "ready-for-agent", "agent:implement"], ...overrides });

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

const started = (plan: Plan) => actionsOf(plan).find((action) => action.kind === "start-agent-run");

describe("agent:implement while another Implement run on the Ticket is unlanded", () => {
  // gradually-core #310: the first run's Implement job had finished and its Push job hadn't opened the PR yet.
  it("is declined: the label comes off, one comment names the other run, and no Implementer starts", () => {
    const plan = planFor(dispatched, snapshotOf(ticket({ unlandedImplementRuns: [43674702101] })), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 310, label: "agent:implement" },
        {
          kind: "comment",
          issue: 310,
          body: "agent:implement came off and nothing started: #310 has an Implement run under way (run 43674702101).",
        },
      ],
    });
  });

  it("is declined on a Retry's start too, when the run after the last flaw hasn't posted its outcome", () => {
    const plan = planFor(dispatched, snapshotOf(ticket({ landedNothing: 1, unlandedImplementRuns: [12], runsWithOutcome: [11] })), kitConfig());

    expect(started(plan)).toBeUndefined();
    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "comment", body: expect.stringContaining("(run 12)") }));
  });

  // An empty diff's, a Broken run's and a Kept-branch start-again's push job each post their comment, then add the label.
  it("starts the run after it once that run has posted its outcome on the Ticket, its Push job still running", () => {
    const plan = planFor(dispatched, snapshotOf(ticket({ landedNothing: 1, unlandedImplementRuns: [12], runsWithOutcome: [12] })), kitConfig());

    expect(started(plan)).toMatchObject({ role: "implement", issue: 310, retry: 1 });
  });

  it("starts the run when no other Implement run on the Ticket is unlanded", () => {
    expect(started(planFor(dispatched, snapshotOf(ticket({ unlandedImplementRuns: [] })), kitConfig()))).toMatchObject({ role: "implement", issue: 310 });
  });

  // A failed read never stalls a Ticket.
  it("starts the run as before when the Actions runs couldn't be read", () => {
    expect(started(planFor(dispatched, snapshotOf(ticket({ unlandedImplementRuns: null })), kitConfig()))).toMatchObject({ role: "implement", issue: 310 });
  });

  it("still resumes the run an open agent PR is owed, a Retry here, as before", () => {
    const pullRequest = aPullRequest({
      number: 50,
      ticket: 310,
      verdicts: [{ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }],
    });
    const snapshot = snapshotOf(ticket({ openPullRequests: [50], unlandedImplementRuns: [43674702101] }), { pullRequest });

    expect(started(planFor(dispatched, snapshot, kitConfig()))).toMatchObject({ role: "implement", issue: 310, pullRequest: 50, retry: 1 });
  });
});
