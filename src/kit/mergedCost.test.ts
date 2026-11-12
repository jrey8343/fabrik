import { describe, expect, it } from "vitest";
import { AN_UNKNOWN_COST, aReplayRunRecord, aRunRecord } from "../read/builders.ts";
import { costPerMergedPullRequestOf } from "./mergedCost.ts";
import type { Week } from "./weeklySummary.ts";

/** The week of Monday 2 November 2026, in UTC. */
const WEEK: Week = { start: Date.parse("2026-11-02T00:00:00Z"), end: Date.parse("2026-11-09T00:00:00Z"), monday: "2026-11-02" };

describe("what a merged pull request cost", () => {
  it("sums each merged pull request's Implement and Review records on its Ticket and averages over the pull requests", () => {
    const records = [
      aRunRecord({ runId: 1, role: "implement", issue: 7, totalCostUsd: 2 }),
      aRunRecord({ runId: 2, role: "implement", issue: 7, retry: 1, totalCostUsd: 1 }),
      aRunRecord({ runId: 3, role: "review", issue: 7, totalCostUsd: 1 }),
      aRunRecord({ runId: 4, role: "triage", issue: 7, totalCostUsd: 5 }),
      aRunRecord({ runId: 5, role: "implement", issue: 8, totalCostUsd: 2 }),
    ];
    const merged = [
      { repo: "owner/product", ticket: 7 },
      { repo: "owner/product", ticket: 8 },
    ];

    expect(costPerMergedPullRequestOf(WEEK, records, merged)).toEqual({ usd: 3, unknownCost: 0, merged: 2 });
  });

  it("counts a record that ended in an earlier week, and none that ended after the week did", () => {
    const records = [
      aRunRecord({ runId: 1, endedAt: "2026-10-20T12:00:00Z", totalCostUsd: 2 }),
      aRunRecord({ runId: 2, endedAt: "2026-11-09T00:00:00Z", totalCostUsd: 7 }),
    ];

    expect(costPerMergedPullRequestOf(WEEK, records, [{ repo: "owner/product", ticket: 7 }])).toEqual({ usd: 2, unknownCost: 0, merged: 1 });
  });

  it("counts a pull request that names no Ticket as merged at no cost", () => {
    const records = [aRunRecord({ totalCostUsd: 4 })];
    const merged = [
      { repo: "owner/product", ticket: 7 },
      { repo: "owner/product", ticket: null },
    ];

    expect(costPerMergedPullRequestOf(WEEK, records, merged)).toEqual({ usd: 2, unknownCost: 0, merged: 2 });
  });

  it("counts a Ticket's records once for each of its pull requests merged in the week", () => {
    const merged = [
      { repo: "owner/product", ticket: 7 },
      { repo: "owner/product", ticket: 7 },
    ];

    expect(costPerMergedPullRequestOf(WEEK, [aRunRecord({ totalCostUsd: 3 })], merged)).toEqual({ usd: 3, unknownCost: 0, merged: 2 });
  });

  it("reads a record only against a pull request of its own repo", () => {
    const records = [aRunRecord({ repo: "owner/product", totalCostUsd: 2 }), aRunRecord({ runId: 2, repo: "owner/other", totalCostUsd: 6 })];
    const merged = [
      { repo: "owner/product", ticket: 7 },
      { repo: "owner/other", ticket: 7 },
    ];

    expect(costPerMergedPullRequestOf(WEEK, records, merged)).toEqual({ usd: 4, unknownCost: 0, merged: 2 });
  });

  it("leaves out a Replay arm's Implement record on a merged Ticket", () => {
    const records = [aRunRecord({ totalCostUsd: 2 }), aReplayRunRecord({ totalCostUsd: 40 })];

    expect(costPerMergedPullRequestOf(WEEK, records, [{ repo: "owner/product", ticket: 7 }])).toEqual({ usd: 2, unknownCost: 0, merged: 1 });
  });

  it("counts a record with an unknown cost basis, which adds nothing to the figure", () => {
    const records = [aRunRecord({ totalCostUsd: 2 }), aRunRecord({ runId: 2, ...AN_UNKNOWN_COST })];

    expect(costPerMergedPullRequestOf(WEEK, records, [{ repo: "owner/product", ticket: 7 }])).toEqual({ usd: 2, unknownCost: 1, merged: 1 });
  });

  it("has no figure when nothing merged", () => {
    expect(costPerMergedPullRequestOf(WEEK, [aRunRecord()], [])).toEqual({ usd: null, unknownCost: 0, merged: 0 });
  });
});
