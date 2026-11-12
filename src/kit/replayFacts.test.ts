import { describe, expect, it } from "vitest";
import { aReading } from "../__fixtures__/replay.ts";
import { A_REPLAY, aRunRecord } from "../read/builders.ts";
import { newestWeeklyLimits, replayCandidatesOf, replayStorePaths, replayTicketsIn, subscriptionReadingsOf } from "./replayFacts.ts";

/** Wednesday 2026-11-11, so the store's last two months are October and November 2026. */
const NOW = "2026-11-11T04:00:00.000Z";

// The tick's sparse checkout of the store (.github/actions/replay-store), in git's non-cone patterns.
describe("What the tick checks out of the store for the replay step", () => {
  it("is every Product repo's Run records from the store's last two months, and every one of this repo's, whatever month", () => {
    expect(replayStorePaths("acme/shop", NOW)).toEqual(["/runs/*/*/2026-11/", "/runs/*/*/2026-10/", "/runs/acme/shop/"]);
  });

  it("reaches back into last year from January, by UTC", () => {
    expect(replayStorePaths("acme/shop", "2027-01-01T00:30:00+10:00")).toEqual(["/runs/*/*/2026-12/", "/runs/*/*/2026-11/", "/runs/acme/shop/"]);
  });
});

describe("The newest weekly-limit reading on each Subscription, as the spare-capacity gate weighs it", () => {
  it("is each Subscription's newest, from any Product repo's records, a Replay run's included", () => {
    const records = [
      aRunRecord({ repo: "acme/shop", endedAt: "2026-11-09T10:00:00Z", rateLimit: aReading(0.3) }),
      aRunRecord({ repo: "acme/clinic", endedAt: "2026-11-10T10:00:00Z", rateLimit: aReading(0.42) }),
      aRunRecord({ repo: "acme/shop", endedAt: "2026-11-08T10:00:00Z", rateLimit: aReading(0.9) }),
      aRunRecord({ repo: "acme/shop", endedAt: "2026-11-10T09:00:00Z", subscription: "Claude token 2", replay: A_REPLAY, rateLimit: aReading(0.6) }),
    ];

    expect(newestWeeklyLimits(records, NOW)).toEqual({ "Claude token": aReading(0.42), "Claude token 2": aReading(0.6) });
  });

  it("skips a record with no reading, or only the five-hour limit's, so a run that never reached the model hides no reading before it", () => {
    const records = [
      aRunRecord({ endedAt: "2026-11-09T10:00:00Z", rateLimit: aReading(0.7) }),
      aRunRecord({ endedAt: "2026-11-10T10:00:00Z", rateLimit: null }),
      aRunRecord({ endedAt: "2026-11-10T11:00:00Z", rateLimit: { ...aReading(0.1), rateLimitType: "five_hour" } }),
    ];

    expect(newestWeeklyLimits(records, NOW)).toEqual({ "Claude token": aReading(0.7) });
  });

  it("reads only the store's last two months, this month and the one before", () => {
    const records = [aRunRecord({ endedAt: "2026-09-30T23:00:00Z", rateLimit: aReading(0.8) }), aRunRecord({ endedAt: "2026-10-01T00:00:00Z", rateLimit: aReading(0.2) })];

    expect(newestWeeklyLimits(records, NOW)).toEqual({ "Claude token": aReading(0.2) });
    expect(newestWeeklyLimits(records.slice(0, 1), NOW)).toEqual({});
  });
});

describe("Each Subscription's last weekly-limit reading, with when it was read and when its week resets", () => {
  it("is each Subscription's newest, read when its run ended, its reset as a time", () => {
    const records = [
      aRunRecord({ endedAt: "2026-11-09T10:00:00Z", rateLimit: aReading(0.3) }),
      aRunRecord({ endedAt: "2026-11-10T10:00:00Z", rateLimit: aReading(0.42) }),
      aRunRecord({ endedAt: "2026-11-10T09:00:00Z", subscription: "Claude token 2", replay: A_REPLAY, rateLimit: aReading(0.6, "allowed_warning") }),
    ];

    expect(subscriptionReadingsOf(records, NOW)).toEqual([
      { subscription: "Claude token", share: 0.42, said: "allowed", readAt: "2026-11-10T10:00:00Z", resetsAt: "2026-11-16T04:00:00.000Z" },
      { subscription: "Claude token 2", share: 0.6, said: "allowed_warning", readAt: "2026-11-10T09:00:00Z", resetsAt: "2026-11-16T04:00:00.000Z" },
    ]);
  });

  it("skips a record with no reading, or only the five-hour limit's, and leaves out a Subscription with none", () => {
    const records = [
      aRunRecord({ endedAt: "2026-11-09T10:00:00Z", rateLimit: aReading(0.7) }),
      aRunRecord({ endedAt: "2026-11-10T10:00:00Z", rateLimit: null }),
      aRunRecord({ endedAt: "2026-11-10T11:00:00Z", rateLimit: { ...aReading(0.1), rateLimitType: "five_hour" } }),
      aRunRecord({ endedAt: "2026-11-10T12:00:00Z", subscription: "Claude token 2", rateLimit: { ...aReading(0.2), rateLimitType: "five_hour" } }),
      aRunRecord({ endedAt: "2026-11-10T13:00:00Z", subscription: "Claude token 3", rateLimit: null }),
    ];

    expect(subscriptionReadingsOf(records, NOW)).toEqual([
      { subscription: "Claude token", share: 0.7, said: "allowed", readAt: "2026-11-09T10:00:00Z", resetsAt: "2026-11-16T04:00:00.000Z" },
    ]);
  });

  it("gives a reading with no share, no word or no reset as null for each", () => {
    const records = [aRunRecord({ endedAt: "2026-11-10T10:00:00Z", rateLimit: { status: null, rateLimitType: "seven_day", utilization: null, resetsAt: null } })];

    expect(subscriptionReadingsOf(records, NOW)).toEqual([{ subscription: "Claude token", share: null, said: null, readAt: "2026-11-10T10:00:00Z", resetsAt: null }]);
  });

  it("reads only the store's last two months, this month and the one before", () => {
    const records = [aRunRecord({ endedAt: "2026-09-30T23:00:00Z", rateLimit: aReading(0.8) })];

    expect(subscriptionReadingsOf(records, NOW)).toEqual([]);
  });
});

describe("A Replay's candidate Tickets, from this repo's Run records and its merged agent PRs", () => {
  const firstRun = (ticket: number, repo = "acme/shop") => aRunRecord({ repo, issue: ticket, pullRequest: null, endedAt: "2026-10-20T10:00:00Z" });

  it("are this repo's Tickets with a live Implement run, never another repo's, nor one only a Replay or another role ran on", () => {
    const records = [
      firstRun(12),
      firstRun(13, "acme/clinic"),
      aRunRecord({ repo: "acme/shop", issue: 14, replay: A_REPLAY }),
      aRunRecord({ repo: "acme/shop", issue: 15, role: "triage" }),
      aRunRecord({ repo: "acme/shop", issue: 15, role: "review" }),
    ];

    expect(replayTicketsIn(records, "acme/shop")).toEqual([12]);
  });

  it("hold only this repo's records of each, since Ticket numbers repeat across Product repos, every role's", () => {
    const review = aRunRecord({ repo: "acme/shop", issue: 12, role: "review", pullRequest: 112 });
    const records = [firstRun(12), review, firstRun(12, "acme/clinic")];

    const [candidate] = replayCandidatesOf({ repo: "acme/shop", records, merged: [], files: {}, lastEdited: {} });

    expect(candidate?.records).toEqual([firstRun(12), review]);
  });

  it("hold each one's last merged PR, whether it was reverted, its files, Human touches and edit times", () => {
    const merged = [
      { ticket: 12, number: 104, mergedAt: "2026-10-21T10:00:00Z", reverted: true, humanTouches: 0 },
      { ticket: 12, number: 112, mergedAt: "2026-10-24T10:00:00Z", reverted: false, humanTouches: 2 },
    ];
    const files = { 112: [{ path: "src/booking.test.ts", removed: false }] };
    const lastEdited = { 12: { ticket: "2026-10-22T10:00:00Z", spec: null } };

    expect(replayCandidatesOf({ repo: "acme/shop", records: [firstRun(12)], merged, files, lastEdited })).toEqual([
      {
        ticket: 12,
        merged: { number: 112, mergedAt: "2026-10-24T10:00:00Z", reverted: false, files: [{ path: "src/booking.test.ts", removed: false }] },
        records: [firstRun(12)],
        humanTouches: 2,
        lastEdited: { ticket: "2026-10-22T10:00:00Z", spec: null },
      },
    ]);
  });

  it("hold no merged PR for a Ticket none of whose agent PRs merged", () => {
    expect(replayCandidatesOf({ repo: "acme/shop", records: [firstRun(12)], merged: [], files: {}, lastEdited: {} })).toEqual([
      { ticket: 12, merged: null, records: [firstRun(12)], humanTouches: 0, lastEdited: { ticket: null, spec: null } },
    ]);
  });
});
