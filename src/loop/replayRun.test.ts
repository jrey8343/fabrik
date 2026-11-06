import { describe, expect, it } from "vitest";
import { acceptedBody } from "../__fixtures__/replay.ts";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { replayMarksIn } from "../kit/replay.ts";
import { planFor } from "./rules.ts";
import type { IssueSnapshot, KitIssueSnapshot, LoopEvent, Plan } from "./types.ts";

const TWO_SUBSCRIPTIONS = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });

/** agent:replay added to #140. */
const ADDED: LoopEvent = { kind: "label-added", issue: 140, label: "agent:replay" };

/** Replay issue #140, open, filed by the Operator and accepted, review.effort: high on Tickets 12 and 7, both pending, with agent:replay on. */
function aReplay(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return anIssue({ number: 140, author: "operator", labels: ["fabrik:replay", "agent:replay"], body: acceptedBody(), ...overrides });
}

/** The Kit's open weekly-limit issue on `subscription`. */
function weeklyLimitIssue(number: number, subscription: string): KitIssueSnapshot {
  return {
    number,
    labels: ["fabrik:weekly-limit"],
    body: `@operator Every listed Subscription has hit its limit.\n\n<!-- fabrik:notified -->\n<!-- fabrik:subscription ${subscription} -->\n<!-- fabrik:resets-at 2026-11-16T04:00:00.000Z -->`,
    comments: [],
  };
}

describe("agent:replay on a replay issue", () => {
  it("routes to replay: takes the label off, marks the next pending Ticket started, and starts both its arms on the chosen Subscription", () => {
    const planned = replayMarksIn(acceptedBody())?.plan.tickets[0];

    expect(planFor(ADDED, snapshotOf(aReplay()), kitConfig())).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 140, label: "agent:replay" },
        { kind: "mark-replay-started", issue: 140, ticket: 12 },
        { kind: "start-replay", issue: 140, ticket: planned, subscription: "Claude token" },
      ],
    });
  });

  it("starts the Ticket after one done, or one waiting to run again after an Infrastructure failure", () => {
    const body = acceptedBody([12, 7, 20], [{ ticket: 12, state: "done", run: 9001 }, { ticket: 7, state: "retried", reason: "it crashed" }]);

    expect(actionsOf(planFor(ADDED, snapshotOf(aReplay({ body })), kitConfig()))).toContainEqual({ kind: "mark-replay-started", issue: 140, ticket: 7 });
  });

  describe("is never held, and never starts while a Subscription is used up, leaving its Ticket pending for a later tick", () => {
    it("with rotation on and every Subscription at its weekly limit, where a live run would be held", () => {
      const kitIssues = [weeklyLimitIssue(41, "Claude token"), weeklyLimitIssue(42, "Claude token 2")];

      const plan = planFor(ADDED, snapshotOf(aReplay(), { kitIssues }), TWO_SUBSCRIPTIONS);

      expect(plan).toEqual({ kind: "nothing", reason: "A Subscription is used up, as the weekly-limit issue #41 says, and a replay run is never held: its Ticket waits for spare capacity" });
    });

    it("with one Subscription of two at its weekly limit, where a live run would start on the other", () => {
      expect(planFor(ADDED, snapshotOf(aReplay(), { kitIssues: [weeklyLimitIssue(42, "Claude token 2")] }), TWO_SUBSCRIPTIONS)).toMatchObject({ kind: "nothing" });
    });

    it("with an open usage-credits issue", () => {
      const credits = { number: 43, labels: ["fabrik:usage-credits"], body: "<!-- fabrik:subscription Claude token 2 -->", comments: [] };

      expect(planFor(ADDED, snapshotOf(aReplay(), { kitIssues: [credits] }), TWO_SUBSCRIPTIONS)).toMatchObject({ kind: "nothing" });
    });
  });

  it.each<[string, Partial<IssueSnapshot>, string]>([
    ["isn't a replay issue", { labels: ["enhancement", "agent:replay"] }, "#140 isn't a replay issue: it has no fabrik:replay"],
    ["is closed", { open: false }, "#140 is closed, which cancels its Replay"],
    ["someone else filed", { author: "someone-else" }, "#140 isn't the Operator's, so its Replay never runs"],
    ["the tick hasn't accepted", { body: "```replay\nreview.effort: high\n```\n" }, "#140's request isn't accepted yet"],
    ["has a Ticket in progress", { body: acceptedBody([12, 7], [{ ticket: 12, state: "in-progress", run: 9001, retrying: null }]) }, "#12 is in progress on #140 already, and one replay Ticket runs at a time"],
    ["has no Ticket left to run", { body: acceptedBody([12], [{ ticket: 12, state: "done", run: 9001 }]) }, "No Ticket of #140 waits to run"],
  ])("starts nothing on an issue that %s, saying why", (_, overrides, reason) => {
    expect(planFor(ADDED, snapshotOf(aReplay(overrides)), kitConfig())).toEqual({ kind: "nothing", reason });
  });
});

function actionsOf(plan: Plan) {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}
