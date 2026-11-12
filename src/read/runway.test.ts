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
  });

  describe("when one Subscription rose from 30% to 40% in ten hours of one week", () => {
    it("runs out sixty hours after the newest reading, held until its reset, when it resets in five days", () => {
      const resets = hoursOn(5 * 24);

      const runway = runwayOf([aReading("Claude token", 12, 0.3, resets), aReading("Claude token", 2, 0.4, resets)], [], NOW);

      expect(runway).toEqual({ kind: "runs-out", at: hoursOn(-2 + 60), heldUntil: resets });
    });
  });
});
