import { describe, expect, it } from "vitest";
import type { RunRecord } from "../kit/runRecord.ts";
import { aRunRecord } from "./builders.ts";
import { runwayOf } from "./runway.ts";

/** Thursday 12 November 2026, noon UTC. */
const NOW = "2026-11-12T12:00:00Z";
const HOUR = 3_600_000;

/** `hours` after NOW (before it when negative), as an ISO time. */
function hoursOn(hours: number): string {
  return new Date(Date.parse(NOW) + hours * HOUR).toISOString();
}

/** A run on `subscription` that ended `hoursAgo` before NOW having read `share` of its weekly limit, the week resetting at `resetsAt`. */
function aReading(subscription: string, hoursAgo: number, share: number | null, resetsAt: string | null): RunRecord {
  return aRunRecord({
    subscription,
    endedAt: hoursOn(-hoursAgo),
    rateLimit: { status: "allowed", rateLimitType: "seven_day", utilization: share, resetsAt: resetsAt === null ? null : Date.parse(resetsAt) / 1000 },
  });
}

describe("the runway", () => {
  describe("when every Subscription is used up", () => {
    const records = [aReading("Claude token", 3, 1, hoursOn(24)), aReading("Claude max", 5, 1, hoursOn(48))];

    it("is held until the first of them frees", () => {
      const runway = runwayOf(
        records,
        [
          { subscription: "Claude max", until: "2026-11-13T09:00:00.000Z" },
          { subscription: "Claude token", until: "2026-11-12T20:00:00.000Z" },
        ],
        NOW,
      );

      expect(runway).toEqual({ kind: "held", until: "2026-11-12T20:00:00.000Z" });
    });

    it("is held with no end when none of them is timed", () => {
      const runway = runwayOf(
        records,
        [
          { subscription: "Claude max", until: null },
          { subscription: "Claude token", until: null },
        ],
        NOW,
      );

      expect(runway).toEqual({ kind: "held", until: null });
    });

    it("knows only the Subscriptions the records of the last two months name", () => {
      const runway = runwayOf(
        [...records, aRunRecord({ subscription: "Claude spare", endedAt: "2026-09-30T23:00:00Z" })],
        [
          { subscription: "Claude max", until: null },
          { subscription: "Claude token", until: null },
        ],
        NOW,
      );

      expect(runway).toEqual({ kind: "held", until: null });
    });
  });

  describe("when one Subscription rose from 30% to 40% in ten hours of one week", () => {
    it("runs out sixty hours after the newest reading, held until its reset, when it resets in five days", () => {
      const resets = hoursOn(5 * 24);

      const runway = runwayOf([aReading("Claude token", 12, 0.3, resets), aReading("Claude token", 2, 0.4, resets)], [], NOW);

      expect(runway).toEqual({ kind: "runs-out", at: hoursOn(-2 + 60), heldUntil: resets });
    });

    it("runs all week when it resets in two days, before runs would run out", () => {
      const resets = hoursOn(2 * 24);

      const runway = runwayOf([aReading("Claude token", 12, 0.3, resets), aReading("Claude token", 2, 0.4, resets)], [], NOW);

      expect(runway).toEqual({ kind: "all-week" });
    });
  });

  describe("the room left", () => {
    const resets = hoursOn(5 * 24);
    /** Claude token, rising from 20% to 40% in ten hours: two points an hour, so its own room lasts thirty hours. */
    const inUse = [aReading("Claude token", 12, 0.2, resets), aReading("Claude token", 2, 0.4, resets)];

    it("takes the whole limit of a second Subscription untouched this week", () => {
      const runway = runwayOf([...inUse, aRunRecord({ subscription: "Claude max", endedAt: hoursOn(-30), rateLimit: null })], [], NOW);

      expect(runway).toEqual({ kind: "runs-out", at: hoursOn(-2 + 80), heldUntil: resets });
    });

    it("takes the whole limit of a Subscription whose week has reset since its newest reading", () => {
      const runway = runwayOf([...inUse, aReading("Claude max", 30, 0.9, hoursOn(-6))], [], NOW);

      expect(runway).toEqual({ kind: "runs-out", at: hoursOn(-2 + 80), heldUntil: resets });
    });

    it("leaves out a Subscription that is used up", () => {
      const runway = runwayOf([...inUse, aReading("Claude max", 30, 1, hoursOn(30))], [{ subscription: "Claude max", until: hoursOn(30) }], NOW);

      expect(runway).toEqual({ kind: "runs-out", at: hoursOn(-2 + 30), heldUntil: hoursOn(30) });
    });
  });

  it("judges a Subscription that took over yesterday on its readings since, not on its whole week", () => {
    // Its week began two days ago. A straight line from that reset, 20% in
    // 48 hours, would say it lasts the week; it read 0% twenty hours ago,
    // and forty, and 20% now.
    const resets = hoursOn(5 * 24);
    const records = [
      aReading("Claude token", 60, 0.95, hoursOn(30)),
      aReading("Claude max", 40, 0, resets),
      aReading("Claude max", 20, 0, resets),
      aReading("Claude max", 0, 0.2, resets),
    ];

    const runway = runwayOf(records, [{ subscription: "Claude token", until: null }], NOW);

    expect(runway).toEqual({ kind: "runs-out", at: hoursOn(80), heldUntil: resets });
  });

  describe("too few readings to tell", () => {
    const resets = hoursOn(5 * 24);

    it("is unknown with one reading in the last 24 hours", () => {
      const runway = runwayOf([aReading("Claude token", 30, 0.3, resets), aReading("Claude token", 2, 0.4, resets)], [], NOW);

      expect(runway).toEqual({ kind: "unknown" });
    });

    it("is unknown with two readings less than an hour apart", () => {
      const runway = runwayOf([aReading("Claude token", 2.5, 0.3, resets), aReading("Claude token", 2, 0.4, resets)], [], NOW);

      expect(runway).toEqual({ kind: "unknown" });
    });

    it("is unknown when the earlier reading is of the week before", () => {
      const runway = runwayOf([aReading("Claude token", 12, 0.9, hoursOn(-6)), aReading("Claude token", 2, 0.1, resets)], [], NOW);

      expect(runway).toEqual({ kind: "unknown" });
    });

    it("skips a reading with no share or no reset", () => {
      const runway = runwayOf(
        [aReading("Claude token", 12, null, resets), aReading("Claude token", 8, 0.3, null), aReading("Claude token", 2, 0.4, resets)],
        [],
        NOW,
      );

      expect(runway).toEqual({ kind: "unknown" });
    });

    it("is unknown when no record has a reading at all", () => {
      expect(runwayOf([aRunRecord({ endedAt: hoursOn(-2), rateLimit: null })], [], NOW)).toEqual({ kind: "unknown" });
      expect(runwayOf([], [], NOW)).toEqual({ kind: "unknown" });
    });
  });

  describe("a share that did not rise", () => {
    const resets = hoursOn(5 * 24);

    it("runs all week when it fell", () => {
      const runway = runwayOf([aReading("Claude token", 12, 0.4, resets), aReading("Claude token", 2, 0.3, resets)], [], NOW);

      expect(runway).toEqual({ kind: "all-week" });
    });

    it("runs all week when it stood still", () => {
      const runway = runwayOf([aReading("Claude token", 12, 0.4, resets), aReading("Claude token", 2, 0.4, resets)], [], NOW);

      expect(runway).toEqual({ kind: "all-week" });
    });

    it("runs all week when it stood still in a week that has since reset, with no reset ahead known", () => {
      const reset = hoursOn(-1);

      const runway = runwayOf([aReading("Claude token", 12, 0.4, reset), aReading("Claude token", 2, 0.4, reset)], [], NOW);

      expect(runway).toEqual({ kind: "all-week" });
    });
  });
});
