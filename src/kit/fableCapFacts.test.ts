import { describe, expect, it } from "vitest";
import { aReading } from "../__fixtures__/replay.ts";
import { A_REPLAY, aRunRecord } from "../read/builders.ts";
import { fableStorePaths, storeFableCaps } from "./fableCapFacts.ts";

/** Wednesday 2026-11-11, so the store's last two months are October and November 2026. */
const NOW = "2026-11-11T04:00:00.000Z";
const FABLE = "claude-fable-5-2";

/** A Fable run refused on its Subscription's Fable cap, as its Run record keeps it, its reset in epoch seconds. */
function aFableCap(endedAt: string, resetsAt: string | null, subscription = "Claude token") {
  return aRunRecord({
    endedAt,
    subscription,
    model: FABLE,
    role: "review",
    jobResult: "failure",
    infrastructureFailure: "fable-cap",
    refusal: { rateLimitType: "seven_day_fable", resetsAt: resetsAt === null ? null : Date.parse(resetsAt) / 1000 },
  });
}

// The Kit job's sparse checkout of the store, in an opted-in repo (.github/actions/fable-store), in git's non-cone patterns.
describe("What the Kit job checks out of the store for the Fable cap readings", () => {
  it("is every Product repo's Run records from the store's last two months, since a Subscription is shared across them", () => {
    expect(fableStorePaths(NOW)).toEqual(["/runs/*/*/2026-11/", "/runs/*/*/2026-10/"]);
  });
});

describe("The Fable cap readings in the store's newest Run records (ADR-0034)", () => {
  it("is each Subscription's newest Fable cap, from any Product repo's records, until the reset its refusal gave", () => {
    const records = [
      aFableCap("2026-11-09T10:00:00Z", "2026-11-12T04:00:00Z"),
      { ...aFableCap("2026-11-10T10:00:00Z", "2026-11-14T04:00:00Z"), repo: "acme/clinic" },
      aFableCap("2026-11-10T09:00:00Z", "2026-11-15T04:00:00Z", "Claude token 2"),
    ];

    expect(storeFableCaps(records, NOW)).toEqual([
      { subscription: "Claude token", until: "2026-11-14T04:00:00.000Z" },
      { subscription: "Claude token 2", until: "2026-11-15T04:00:00.000Z" },
    ]);
  });

  it("gives a reading whose reset has passed as it is: whether it is still in force is the reader's to tell", () => {
    expect(storeFableCaps([aFableCap("2026-11-02T10:00:00Z", "2026-11-05T04:00:00Z")], NOW)).toEqual([
      { subscription: "Claude token", until: "2026-11-05T04:00:00.000Z" },
    ]);
  });

  it("reads no reading off any other run, a weekly-limit refusal or a Fable run that ran included", () => {
    const records = [
      aRunRecord({ model: FABLE, endedAt: "2026-11-10T10:00:00Z" }),
      aRunRecord({
        endedAt: "2026-11-10T11:00:00Z",
        jobResult: "failure",
        infrastructureFailure: "weekly-limit",
        refusal: { rateLimitType: "seven_day", resetsAt: Date.parse("2026-11-16T04:00:00Z") / 1000 },
      }),
    ];

    expect(storeFableCaps(records, NOW)).toEqual([]);
  });

  it("counts a Replay arm's Fable cap, which is its Subscription's all the same", () => {
    expect(storeFableCaps([{ ...aFableCap("2026-11-10T10:00:00Z", "2026-11-14T04:00:00Z"), replay: A_REPLAY }], NOW)).toEqual([
      { subscription: "Claude token", until: "2026-11-14T04:00:00.000Z" },
    ]);
  });

  it("reads only the store's last two months, this month and the one before", () => {
    const records = [aFableCap("2026-09-30T23:00:00Z", "2026-12-01T00:00:00Z")];

    expect(storeFableCaps(records, NOW)).toEqual([]);
    expect(storeFableCaps([aFableCap("2026-10-01T00:00:00Z", "2026-10-05T00:00:00Z")], NOW)).toHaveLength(1);
  });

  it("counts a reading with no reset until its Subscription's weekly-limit reset, as the store's newest weekly-limit reading gives it", () => {
    const records = [aRunRecord({ endedAt: "2026-11-09T10:00:00Z", rateLimit: aReading(0.4) }), aFableCap("2026-11-10T10:00:00Z", null)];

    expect(storeFableCaps(records, NOW)).toEqual([{ subscription: "Claude token", until: "2026-11-16T04:00:00.000Z" }]);
  });

  it("counts a reading with no reset for 7 days from its run's end, with no weekly-limit reset known on its Subscription", () => {
    const records = [aRunRecord({ endedAt: "2026-11-09T10:00:00Z", subscription: "Claude token 2", rateLimit: aReading(0.4) }), aFableCap("2026-11-10T10:00:00Z", null)];

    expect(storeFableCaps(records, NOW)).toEqual([{ subscription: "Claude token", until: "2026-11-17T10:00:00.000Z" }]);
  });

  it("counts a reading with no reset for 7 days when its Subscription's weekly-limit reset came before it, from an earlier week", () => {
    const old = { ...aReading(0.4), resetsAt: Date.parse("2026-11-09T04:00:00Z") / 1000 };
    const records = [aRunRecord({ endedAt: "2026-11-03T10:00:00Z", rateLimit: old }), aFableCap("2026-11-10T10:00:00Z", null)];

    expect(storeFableCaps(records, NOW)).toEqual([{ subscription: "Claude token", until: "2026-11-17T10:00:00.000Z" }]);
  });
});
