import { describe, expect, it } from "vitest";
import { aRunRecord } from "./builders.ts";
import { runnerTimeOf } from "./spend.ts";

describe("Runner time over a week's Run records", () => {
  it("sums each run's duration rounded up to a whole minute, and counts the records with no duration, which add nothing", () => {
    const records = [aRunRecord({ runId: 1, durationMs: 61_000 }), aRunRecord({ runId: 2, durationMs: 59_000 }), aRunRecord({ runId: 3, durationMs: null })];

    expect(runnerTimeOf(records)).toEqual({ minutes: 3, uncounted: 1 });
  });

  it("is nothing for a week with no records", () => {
    expect(runnerTimeOf([])).toEqual({ minutes: 0, uncounted: 0 });
  });
});
