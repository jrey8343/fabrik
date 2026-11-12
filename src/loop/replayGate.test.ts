import { describe, expect, it } from "vitest";
import { aReading, acceptedBody, aReplayIssue, baseOf, replaySlice, requestBody } from "../__fixtures__/replay.ts";
import { aResearchDecision, aTicket, kitConfig, tickSnapshot, withoutNotes } from "../__fixtures__/snapshots.ts";
import { aRunRecord } from "../read/builders.ts";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { type ReplayCandidate, replayMarksIn } from "../kit/replay.ts";
import { planFor } from "./rules.ts";
import type { Action, KitConfig, KitIssueSnapshot, Plan, ReplayCapacitySnapshot, ReplaySnapshot } from "./types.ts";

/** Wednesday 2026-11-11 04:00 UTC: neither the Audit's day nor the Retro's, so neither gate opens anything. */
const WEDNESDAY = "2026-11-11T04:00:00.000Z";

/** The scheduled tick's plan, with this replay slice and these open Kit-owned issues. */
function tick(replay: ReplaySnapshot, kitIssues: readonly KitIssueSnapshot[] = [], config: KitConfig = kitConfig(), now = WEDNESDAY): Plan {
  return withoutNotes(planFor({ kind: "scheduled-tick", now }, tickSnapshot({ replay, kitIssues }), config));
}

/** Before and after WEDNESDAY. */
const EARLIER = "2026-11-11T01:00:00.000Z";
const LATER = "2026-11-12T04:00:00.000Z";

const TWO_SUBSCRIPTIONS = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });

/** The Kit's open weekly-limit issue on `subscription`, for a limit that resets at `resetsAt`. */
function weeklyLimitIssue(number: number, subscription: string, resetsAt: string): KitIssueSnapshot {
  return {
    number,
    labels: ["fabrik:weekly-limit"],
    body: `The Triage run on #7 hit the weekly usage limit.\n\n<!-- fabrik:subscription ${subscription} -->\n<!-- fabrik:resets-at ${resetsAt} -->`,
    comments: [],
  };
}

/** The Kit's open usage-credits issue on `subscription`. */
function usageCreditsIssue(number: number, subscription: string): KitIssueSnapshot {
  return { number, labels: ["fabrik:usage-credits"], body: `Turn usage credits off.\n\n<!-- fabrik:subscription ${subscription} -->`, comments: [] };
}

/** A tick that starts no replay, and opens or posts nothing else: it only asks for the Design queue check every tick ends with. */
const STARTS_NOTHING: Plan = { kind: "act", actions: [{ kind: "check-dispatch" }, { kind: "check-design-queue" }] };

/** The tick starting replay #140's next pending Ticket. */
const STARTS_140: Plan = {
  kind: "act",
  actions: [{ kind: "add-labels", issue: 140, labels: ["agent:replay"] }, { kind: "check-dispatch" }, { kind: "check-design-queue" }],
};

describe("The scheduled tick's replay step", () => {
  it("starts the oldest accepted replay's next pending Ticket with spare capacity, adding agent:replay to its replay issue", () => {
    expect(tick(replaySlice([aReplayIssue({ number: 150 }), aReplayIssue({ number: 140 })]))).toEqual(STARTS_140);
  });

  describe("starts no replay while Dispatch has something to start, by Dispatch's own eligibility, so live work goes first", () => {
    it("a ready, unblocked Ticket", () => {
      expect(tick(replaySlice(undefined, { tickets: [aTicket({ number: 31 })] }))).toEqual(STARTS_NOTHING);
    });

    it("a research Decision on an open Map", () => {
      expect(tick(replaySlice(undefined, { researchDecisions: [aResearchDecision({ number: 32 })] }))).toEqual(STARTS_NOTHING);
    });

    it("even while max_in_flight leaves it no slot, or pauses it", () => {
      expect(tick(replaySlice(undefined, { tickets: [aTicket({ number: 31 })] }), [], kitConfig({ maxInFlight: 0 }))).toEqual(STARTS_NOTHING);
    });

    it.each([
      ["blocked", aTicket({ number: 31, openBlockers: [30] })],
      ["already dispatched", aTicket({ number: 31, labels: ["enhancement", "ready-for-agent", "agent:implement"] })],
      ["building in an open PR", aTicket({ number: 31, openLinkedPullRequests: [60] })],
      ["a Spec", aTicket({ number: 31, subIssues: 3 })],
    ])("but starts one beside a Ticket that's %s, which Dispatch wouldn't start", (_, ticket) => {
      expect(tick(replaySlice(undefined, { tickets: [ticket] }))).toEqual(STARTS_140);
    });
  });

  describe("starts no replay while any Subscription is used up", () => {
    it("by an open weekly-limit issue on the one Subscription", () => {
      expect(tick(replaySlice(), [weeklyLimitIssue(41, "Claude token", LATER)])).toEqual(STARTS_NOTHING);
    });

    it("by an open weekly-limit issue on another listed Subscription, though the one the run would use is free", () => {
      expect(tick(replaySlice(), [weeklyLimitIssue(41, "Claude token 2", LATER)], TWO_SUBSCRIPTIONS)).toEqual(STARTS_NOTHING);
    });

    it("by an open usage-credits issue on any Subscription", () => {
      expect(tick(replaySlice(), [usageCreditsIssue(42, "Claude token 2")], TWO_SUBSCRIPTIONS)).toEqual(STARTS_NOTHING);
    });

    it("by an open token-rotation issue for a dead token on any Subscription", () => {
      const rotation: KitIssueSnapshot = {
        number: 43,
        labels: ["ready-for-human", "fabrik:token-rotation"],
        body: "Rotate it.\n\n<!-- fabrik:subscription Claude token 2 -->",
        comments: [],
      };

      expect(tick(replaySlice(), [rotation], TWO_SUBSCRIPTIONS)).toEqual(STARTS_NOTHING);
    });

    it("but starts one alongside closing a weekly-limit issue whose limit has reset, and leaves that close as it was", () => {
      const plan = tick(replaySlice(), [weeklyLimitIssue(41, "Claude token 2", EARLIER)], TWO_SUBSCRIPTIONS);

      expect(plan).toEqual({
        kind: "act",
        actions: [
          expect.objectContaining({ kind: "comment", issue: 41 }),
          { kind: "close", issue: 41, reason: "completed" },
          { kind: "add-labels", issue: 140, labels: ["agent:replay"] },
          { kind: "check-dispatch" },
          { kind: "check-design-queue" },
        ],
      });
      expect(actionsOf(plan).slice(0, 2)).toEqual(actionsOf(planFor({ kind: "scheduled-tick", now: WEDNESDAY }, tickSnapshot({ kitIssues: [weeklyLimitIssue(41, "Claude token 2", EARLIER)] }), TWO_SUBSCRIPTIONS)).slice(0, 2));
    });
  });

  describe("weighs the newest weekly-limit reading on the Subscription the run would use, the first listed", () => {
    const withReadings = (weeklyLimits: ReplayCapacitySnapshot["weeklyLimits"]) => replaySlice(undefined, { weeklyLimits });

    it("starting one when its utilization is just under 0.5", () => {
      expect(tick(withReadings({ "Claude token": aReading(0.49) }))).toEqual(STARTS_140);
    });

    it("starting none at 0.5", () => {
      expect(tick(withReadings({ "Claude token": aReading(0.5) }))).toEqual(STARTS_NOTHING);
    });

    it.each(["allowed_warning", "rejected"])("starting none when its status is %s, however low its utilization", (status) => {
      expect(tick(withReadings({ "Claude token": aReading(0.1, status) }))).toEqual(STARTS_NOTHING);
    });

    it("starting one with no reading at all, so a quiet repo still replays, its own first run giving the next reading", () => {
      expect(tick(withReadings({}))).toEqual(STARTS_140);
    });

    it("starting one when its allowed reading gave no utilization, as the Scorers read it", () => {
      expect(tick(withReadings({ "Claude token": aReading(null) }))).toEqual(STARTS_140);
    });

    it("starting one when the limit it read has reset since, so the reading is no longer the week's", () => {
      const reading = { ...aReading(0.9, "allowed_warning"), resetsAt: Date.parse(EARLIER) / 1000 };

      expect(tick(withReadings({ "Claude token": reading }))).toEqual(STARTS_140);
    });

    it("whatever another Subscription read", () => {
      expect(tick(withReadings({ "Claude token": aReading(0.2), "Claude token 2": aReading(0.95, "allowed_warning") }), [], TWO_SUBSCRIPTIONS)).toEqual(STARTS_140);
    });

    it("starting none when the store couldn't be read, so its utilization isn't known", () => {
      expect(tick(withReadings(null))).toEqual(STARTS_NOTHING);
    });
  });
});

describe("The scheduled tick's replay step, beside its gates", () => {
  it.each([
    ["on the issue it would start", [aReplayIssue({ body: acceptedBody([12, 7], [{ ticket: 12, state: "in-progress", run: 9001, retrying: null, startedAt: EARLIER }]) })]],
    [
      "on any other replay issue",
      [aReplayIssue(), aReplayIssue({ number: 150, body: acceptedBody([20], [{ ticket: 20, state: "in-progress", run: 9001, retrying: null, startedAt: EARLIER }]) })],
    ],
  ])("starts none while a replay Ticket is in progress %s, since one runs at a time", (_, issues) => {
    expect(tick(replaySlice(issues))).toEqual(STARTS_NOTHING);
  });

  describe("releases a replay Ticket whose run never landed, so none stays in progress for good", () => {
    /** Replay #140 with its Ticket 12 in progress in run 9001 since `startedAt`. */
    const inProgressSince = (startedAt: string) =>
      replaySlice([aReplayIssue({ body: acceptedBody([12, 7], [{ ticket: 12, state: "in-progress", run: 9001, retrying: null, startedAt }]) })]);

    // At Kit config's default timeouts a replay Ticket's run can last 210 minutes: the Kit job's 5 and the claim's 10,
    // Implement's 60, the slowest of the gates, Review and judge at 60, the replay-record job's 15, and an hour to queue.
    it("ending its run as an Infrastructure failure once it's in progress past the longest its run can last, so it runs again on a later tick, then fails", () => {
      expect(tick(inProgressSince("2026-11-11T00:29:00.000Z"))).toEqual({
        kind: "act",
        actions: [
          {
            kind: "release-replay-ticket",
            issue: 140,
            ticket: 12,
            run: 9001,
            reason: "run 9001 never landed, still in progress 211 minutes after it started, past the 210 a replay Ticket's run can last, as when its replay-record job couldn't run",
            resultsReady: expect.stringContaining("@operator **This Replay's results are in.**"),
          },
          { kind: "check-dispatch" },
          { kind: "check-design-queue" },
        ],
      });
    });

    it("but leaving one in progress within it, starting nothing beside it", () => {
      expect(tick(inProgressSince("2026-11-11T00:31:00.000Z"))).toEqual(STARTS_NOTHING);
    });

    it("allowing a run longer under Kit config's longer timeouts", () => {
      const slower = kitConfig({ roles: { ...DEFAULT_KIT_CONFIG.roles, review: { ...DEFAULT_KIT_CONFIG.roles.review, timeoutMinutes: 90 } } });

      expect(tick(inProgressSince("2026-11-11T00:29:00.000Z"), [], slower)).toEqual(STARTS_NOTHING);
    });
  });

  it.each([
    ["someone else's", { author: "someone-else" }],
    ["a closed", { open: false }],
  ])("starts nothing on %s replay issue", (_, overrides) => {
    expect(tick(replaySlice([aReplayIssue(overrides)]))).toEqual(STARTS_NOTHING);
  });

  it("leaves an issue that still has agent:replay, as after a claim that never ran, to the stuck-trigger sweep, which re-adds it once (#419)", () => {
    expect(tick(replaySlice([aReplayIssue({ labels: ["fabrik:replay", "agent:replay"] })]))).toEqual(STARTS_NOTHING);
  });

  it("doesn't add agent:replay back to an issue the Kit gave up on, until someone adds it again (#419)", () => {
    expect(tick(replaySlice([aReplayIssue({ gaveUp: true })]))).toEqual(STARTS_NOTHING);
  });

  describe("on a waiting request, which needs no spare capacity", () => {
    const waiting = aReplayIssue({ body: requestBody("review.effort: high", "12") });
    const acceptance = { candidates: [aCandidate(12)], baseConfigs: { [baseOf(12)]: { ok: true, config: DEFAULT_KIT_CONFIG } as const }, fabrikCommits: {} };

    it("accepts a valid one, writing its plan into the body, while Dispatch has a Ticket to start", () => {
      const plan = tick(replaySlice([waiting], { tickets: [aTicket({ number: 31 })] }, acceptance));

      const [edit] = actionsOf(plan);
      expect(edit).toMatchObject({ kind: "edit-issue-body", issue: 140 });
      expect(edit?.kind === "edit-issue-body" && replayMarksIn(edit.body)?.progress).toEqual([{ ticket: 12, state: "pending" }]);
      expect(actionsOf(plan).slice(1)).toEqual([{ kind: "check-dispatch" }, { kind: "check-design-queue" }]);
    });

    it("rejects an invalid one with one comment", () => {
      const plan = tick(replaySlice([aReplayIssue({ body: requestBody("review.effort: highest", "12") })], {}, acceptance));

      expect(plan).toEqual({
        kind: "act",
        actions: [{ kind: "comment", issue: 140, body: expect.stringContaining('review.effort is "highest"') }, { kind: "check-dispatch" }, { kind: "check-design-queue" }],
      });
    });
  });

  // Replay is on from the release that ships it, and a repo with no experiment pays nothing for it.
  it("takes its step on every tick, and with no replay issue open it starts, accepts and posts nothing", () => {
    expect(tick({ issues: [], capacity: null, acceptance: null })).toEqual(STARTS_NOTHING);
    expect(tick(replaySlice())).toEqual(STARTS_140);
  });
});

/** Ticket `ticket`, merged in PR `ticket + 100`, after one first Implement run from baseOf(ticket): eligible to replay. */
function aCandidate(ticket: number): ReplayCandidate {
  return {
    ticket,
    merged: { number: ticket + 100, mergedAt: "2026-11-02T12:00:00Z", reverted: false, files: [{ path: "src/booking.test.ts", removed: false }] },
    records: [aRunRecord({ issue: ticket, pullRequest: null, baseSha: baseOf(ticket), endedAt: "2026-11-01T09:00:00Z" })],
    humanTouches: 0,
    lastEdited: { ticket: null, spec: null },
  };
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}
