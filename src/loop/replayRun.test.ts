import { describe, expect, it } from "vitest";
import { acceptedBody, aReading, aReplayIssue, replaySlice } from "../__fixtures__/replay.ts";
import { anIssue, kitConfig, notificationsOf, snapshotOf } from "../__fixtures__/snapshots.ts";
import { aRunRecord } from "../__fixtures__/weeklySummary.ts";
import { replayMarksIn, type ReplayTicketEnd } from "../kit/replay.ts";
import { planFor } from "./rules.ts";
import type { IssueSnapshot, KitIssueSnapshot, LoopEvent, Plan, ReplayIssueSnapshot, ReplaySnapshot, Snapshot } from "./types.ts";

const TWO_SUBSCRIPTIONS = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });

/** When a run's claim marked a Ticket in progress. */
const STARTED = "2026-11-11T04:00:00.000Z";

/** agent:replay added to #140. */
const ADDED: LoopEvent = { kind: "label-added", issue: 140, label: "agent:replay" };

/** Replay issue #140, open, filed by the Operator and accepted, review.effort: high on Tickets 12 and 7, both pending, with agent:replay on. */
function aReplay(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return anIssue({ number: 140, author: "operator", labels: ["fabrik:replay", "agent:replay"], body: acceptedBody(), ...overrides });
}

/**
 * The claim's snapshot of replay issue `issue`: with every open replay issue
 * read beside it, it among them, and these others, as the adapter reads them
 * for agent:replay.
 */
function claimSnapshot(issue: IssueSnapshot, others: readonly ReplayIssueSnapshot[] = [], overrides: Partial<Snapshot> = {}): Snapshot {
  const itself = aReplayIssue({ number: issue.number, open: issue.open, author: issue.author, body: issue.body, labels: issue.labels });
  const replay: ReplaySnapshot = { issues: [itself, ...others], capacity: null, acceptance: null };
  return snapshotOf(issue, { replay, ...overrides });
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

    expect(planFor(ADDED, claimSnapshot(aReplay()), kitConfig())).toEqual({
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

    expect(actionsOf(planFor(ADDED, claimSnapshot(aReplay({ body })), kitConfig()))).toContainEqual({ kind: "mark-replay-started", issue: 140, ticket: 7 });
  });

  describe("is never held, and never starts while a Subscription is used up, leaving its Ticket pending for a later tick", () => {
    it("with rotation on and every Subscription at its weekly limit, where a live run would be held", () => {
      const kitIssues = [weeklyLimitIssue(41, "Claude token"), weeklyLimitIssue(42, "Claude token 2")];

      const plan = planFor(ADDED, claimSnapshot(aReplay(), [], { kitIssues }), TWO_SUBSCRIPTIONS);

      expect(plan).toEqual({ kind: "nothing", reason: "A Subscription is used up, as the weekly-limit issue #41 says, and a replay run is never held: its Ticket waits for spare capacity" });
    });

    it("with one Subscription of two at its weekly limit, where a live run would start on the other", () => {
      expect(planFor(ADDED, claimSnapshot(aReplay(), [], { kitIssues: [weeklyLimitIssue(42, "Claude token 2")] }), TWO_SUBSCRIPTIONS)).toMatchObject({ kind: "nothing" });
    });

    it("with an open usage-credits issue", () => {
      const credits = { number: 43, labels: ["fabrik:usage-credits"], body: "<!-- fabrik:subscription Claude token 2 -->", comments: [] };

      expect(planFor(ADDED, claimSnapshot(aReplay(), [], { kitIssues: [credits] }), TWO_SUBSCRIPTIONS)).toMatchObject({ kind: "nothing" });
    });
  });

  describe("runs one replay Ticket at a time across every one of the Operator's replay issues", () => {
    /** The Operator's replay issue #130, accepted, with its Ticket 20 in progress in run 8000. */
    const busy = aReplayIssue({ number: 130, body: acceptedBody([20], [{ ticket: 20, state: "in-progress", run: 8000, retrying: null, startedAt: STARTED }]) });

    it("starting nothing while a Ticket of another of them is in progress, saying which", () => {
      expect(planFor(ADDED, claimSnapshot(aReplay(), [busy]), kitConfig())).toEqual({
        kind: "nothing",
        reason: "#20 is in progress on replay #130, and one replay Ticket runs at a time",
      });
    });

    it("but not for a replay issue someone else filed, which never runs", () => {
      expect(planFor(ADDED, claimSnapshot(aReplay(), [{ ...busy, author: "mallory" }]), kitConfig())).toMatchObject({ kind: "act" });
    });

    it("and failing, starting nothing, on a snapshot that holds no replay issues to weigh", () => {
      expect(planFor(ADDED, snapshotOf(aReplay()), kitConfig())).toEqual({
        kind: "fail",
        failure: "infrastructure",
        reason: "The snapshot is missing the replay issues a replay Ticket's claim weighs",
      });
    });
  });

  it("starts the next Ticket of an agent:replay added by hand whatever Dispatch waits on and the last weekly-limit reading, as agent:implement added by hand starts past Dispatch's cap", () => {
    const ready = { number: 31, open: true, labels: ["ready-for-agent"], openBlockers: [], notPlannedBlockers: [], subIssues: 0, openLinkedPullRequests: [], lastRunFailed: false };
    const busyTick = replaySlice([aReplayIssue()], { tickets: [ready], weeklyLimits: { "Claude token": aReading(0.9) } });

    expect(actionsOf(planFor(ADDED, snapshotOf(aReplay(), { replay: busyTick }), kitConfig()))).toContainEqual({ kind: "mark-replay-started", issue: 140, ticket: 12 });
  });

  it.each<[string, Partial<IssueSnapshot>, string]>([
    ["isn't a replay issue", { labels: ["enhancement", "agent:replay"] }, "#140 isn't a replay issue: it has no fabrik:replay"],
    ["is closed", { open: false }, "#140 is closed, which cancels its Replay"],
    ["someone else filed", { author: "someone-else" }, "#140 isn't the Operator's, so its Replay never runs"],
    ["the tick hasn't accepted", { body: "```replay\nreview.effort: high\n```\n" }, "#140's request isn't accepted yet"],
    ["has a Ticket in progress", { body: acceptedBody([12, 7], [{ ticket: 12, state: "in-progress", run: 9001, retrying: null, startedAt: STARTED }]) }, "#12 is in progress on replay #140, and one replay Ticket runs at a time"],
    ["has no Ticket left to run", { body: acceptedBody([12], [{ ticket: 12, state: "done", run: 9001 }]) }, "No Ticket of #140 waits to run"],
  ])("starts nothing on an issue that %s, saying why", (_, overrides, reason) => {
    expect(planFor(ADDED, claimSnapshot(aReplay(overrides)), kitConfig())).toEqual({ kind: "nothing", reason });
  });
});

describe("A replay Ticket's run ending, as its replay-record job lands it", () => {
  const RUN = "https://github.com/acme/shop/actions/runs/9001/attempts/1";
  const RESETS_AT = "2026-11-12T04:00:00.000Z";
  /** Replay #140 with Ticket 12 in progress in run 9001. */
  const running = aReplay({ labels: ["fabrik:replay"], body: acceptedBody([12, 7], [{ ticket: 12, state: "in-progress", run: 9001, retrying: null, startedAt: STARTED }]) });

  function ended(end: ReplayTicketEnd, subscription = "Claude token"): Extract<LoopEvent, { kind: "replay-run-finished" }> {
    return {
      kind: "replay-run-finished",
      issue: 140,
      ticket: 12,
      run: 9001,
      end,
      runUrl: RUN,
      subscription,
      ...(end.kind === "weekly-limit" ? { resetsAt: RESETS_AT } : {}),
      outcomes: null,
    };
  }

  /** Ticket 12's progress in the body the plan writes. */
  function progressIn(plan: Plan) {
    const edit = actionsOf(plan).find((action) => action.kind === "edit-issue-body");
    return edit?.kind === "edit-issue-body" ? replayMarksIn(edit.body)?.progress[0] : undefined;
  }

  it("marks the Ticket done once both arms ran", () => {
    const plan = planFor(ended({ kind: "done" }), snapshotOf(running), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "edit-issue-body", issue: 140, body: expect.any(String) }] });
    expect(progressIn(plan)).toEqual({ ticket: 12, state: "done", run: 9001 });
  });

  it("marks it to run again after an Infrastructure failure", () => {
    expect(progressIn(planFor(ended({ kind: "infrastructure", reason: "it crashed" }), snapshotOf(running), kitConfig()))).toEqual({
      ticket: 12,
      state: "retried",
      reason: "it crashed",
    });
  });

  describe("refused on its Subscription's weekly limit", () => {
    it("puts the Ticket back to pending and opens the weekly-limit issue, as any refused run does", () => {
      const plan = planFor(ended({ kind: "weekly-limit" }), snapshotOf(running), kitConfig());

      expect(progressIn(plan)).toEqual({ ticket: 12, state: "pending" });
      expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "open-issue", labels: ["fabrik:weekly-limit"] }));
    });

    it("with rotation on and another Subscription free, opens that Subscription's issue quietly and never re-runs it on the other", () => {
      const plan = planFor(ended({ kind: "weekly-limit" }, "Claude token"), snapshotOf(running), TWO_SUBSCRIPTIONS);

      expect(actionsOf(plan).map((action) => action.kind)).toEqual(["edit-issue-body", "open-issue"]);
      expect(actionsOf(plan)[1]).toMatchObject({ body: expect.stringContaining("<!-- fabrik:subscription Claude token -->") });
      expect(notificationsOf(plan)).toEqual([]);
    });

    it("with rotation on and every Subscription used up, buzzes the Operator but never holds it", () => {
      const plan = planFor(ended({ kind: "weekly-limit" }, "Claude token"), snapshotOf(running, { kitIssues: [weeklyLimitIssue(42, "Claude token 2")] }), TWO_SUBSCRIPTIONS);

      expect(actionsOf(plan).some((action) => action.kind === "hold-agent-run" || action.kind === "add-labels")).toBe(false);
      expect(JSON.stringify(plan)).not.toContain("fabrik:held");
      expect(progressIn(plan)).toEqual({ ticket: 12, state: "pending" });
    });
  });

  it("leaves a closed replay issue's body as it is, its Replay cancelled, but still opens the weekly-limit issue", () => {
    const plan = planFor(ended({ kind: "weekly-limit" }), snapshotOf({ ...running, open: false }), kitConfig());

    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["open-issue"]);
  });

  it("changes nothing when the Ticket isn't in progress in that run", () => {
    expect(planFor(ended({ kind: "done" }), snapshotOf(aReplay()), kitConfig())).toEqual({
      kind: "nothing",
      reason: "#12 isn't in progress in run 9001 on replay #140, so its run's end changes nothing there",
    });
  });

  describe("with what the store holds of the Replay, as the replay-record job read it back", () => {
    /** Both arms' Implement and Review runs of Ticket `ticket` in run `run`. */
    const armsOf = (ticket: number, run: number) =>
      (["baseline", "variant"] as const).flatMap((arm) =>
        (["implement", "review"] as const).map((role) =>
          aRunRecord({ repo: "acme/shop", runId: run, role, issue: ticket, verdict: role === "review" ? "pass" : null, replay: { issue: 140, arm, ticket, candidateSha: null } }),
        ),
      );
    const outcomes = (records = armsOf(12, 9001)) => ({ records, scoreFiles: [], gates: [] });
    const finished = (body: string, end: ReplayTicketEnd = { kind: "done" }, store: ReturnType<typeof outcomes> | null = outcomes()) =>
      planFor({ ...ended(end), outcomes: store }, snapshotOf({ ...running, body }), kitConfig());
    const bodyOf = (plan: Plan) => {
      const edit = actionsOf(plan).find((action) => action.kind === "edit-issue-body");
      return edit?.kind === "edit-issue-body" ? edit.body : "";
    };
    const commentsOf = (plan: Plan) => actionsOf(plan).filter((action) => action.kind === "comment");

    it("shows the Ticket's results as it finishes, each arm's linking its patch, and posts nothing while another Ticket waits", () => {
      const plan = finished(running.body);

      expect(bodyOf(plan)).toContain("replays/acme/shop/140/12-baseline-9001.patch");
      expect(bodyOf(plan)).toContain("replays/acme/shop/140/12-variant-9001.patch");
      expect(commentsOf(plan)).toEqual([]);
    });

    describe("once the last Ticket finishes", () => {
      const lastRunning = acceptedBody([12, 7], [{ ticket: 7, state: "done", run: 8001 }, { ticket: 12, state: "in-progress", run: 9001, retrying: null, startedAt: STARTED }]);

      it("posts one comment saying the results are in, mentioning the Operator once", () => {
        const plan = finished(lastRunning, { kind: "done" }, outcomes([...armsOf(7, 8001), ...armsOf(12, 9001)]));

        expect(commentsOf(plan)).toEqual([{ kind: "comment", issue: 140, body: expect.stringContaining("@operator") }]);
        expect(notificationsOf(plan)).toEqual(["mention on #140"]);
        expect(bodyOf(plan)).toContain("replays/acme/shop/140/7-variant-8001.patch");
      });

      it("posts it when the last Ticket fails a second time too, since every Ticket is then done or failed", () => {
        const retrying = acceptedBody([12, 7], [{ ticket: 7, state: "done", run: 8001 }, { ticket: 12, state: "in-progress", run: 9001, retrying: "it crashed", startedAt: STARTED }]);

        expect(notificationsOf(finished(retrying, { kind: "infrastructure", reason: "it crashed again" }))).toEqual(["mention on #140"]);
      });

      it("posts none when it goes back to waiting, refused on the weekly limit", () => {
        expect(commentsOf(finished(lastRunning, { kind: "weekly-limit" }))).toEqual([]);
      });

      it("still posts it when the store couldn't be read, showing the progress without rewriting the results", () => {
        const plan = finished(lastRunning, { kind: "done" }, null);

        expect(progressIn(plan)).toEqual({ ticket: 12, state: "done", run: 9001 });
        expect(notificationsOf(plan)).toEqual(["mention on #140"]);
      });
    });

    it("rewrites nothing and posts nothing on a closed replay issue, which cancelled it", () => {
      const lastRunning = acceptedBody([12], [{ ticket: 12, state: "in-progress", run: 9001, retrying: null, startedAt: STARTED }]);
      const plan = planFor({ ...ended({ kind: "done" }), outcomes: outcomes() }, snapshotOf({ ...running, open: false, body: lastRunning }), kitConfig());

      expect(plan).toMatchObject({ kind: "nothing" });
    });
  });
});

function actionsOf(plan: Plan) {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}
