import { describe, expect, it } from "vitest";
import { aLabelAdded, aMergedPullRequest, aRunRecord, aTicketTimeline, factsOf } from "../__fixtures__/weeklySummary.ts";
import { type WeeklySummaryInput, weeklySummary } from "./weeklySummary.ts";

// The filing: Monday 9 November 2026, 07:00 in Sydney (AEDT, UTC+11). The
// week it covers runs from Monday 2 November 00:00 to Monday 9 November 00:00
// Sydney time, that is 2026-11-01T13:00Z to 2026-11-08T13:00Z.
const NOW = "2026-11-08T20:00:00Z";

function input(overrides: Partial<WeeklySummaryInput> = {}): WeeklySummaryInput {
  return { records: [], facts: [factsOf()], operator: "operator", timeZone: "Australia/Sydney", now: NOW, ...overrides };
}

describe("the Weekly summary", () => {
  it("is skipped in a week with no records and nothing waiting or stuck", () => {
    expect(weeklySummary(input())).toEqual({ kind: "skip" });
  });

  it("covers Monday to Monday in the Operator's time zone, with last week beside it", () => {
    const result = weeklySummary(
      input({
        records: [
          aRunRecord({ endedAt: "2026-11-01T12:59:59Z", totalCostUsd: 2 }), // Sunday 23:59:59 in Sydney: last week
          aRunRecord({ endedAt: "2026-11-01T13:00:00Z", totalCostUsd: 1.5 }), // Monday 00:00 in Sydney: this week
          aRunRecord({ endedAt: "2026-11-08T12:59:59Z", totalCostUsd: 0.25 }), // Sunday 23:59:59: still this week
          aRunRecord({ endedAt: "2026-11-08T13:00:00Z", totalCostUsd: 4 }), // the week being filed in
          aRunRecord({ endedAt: "2026-10-25T12:59:59Z", totalCostUsd: 8 }), // the week before last
        ],
      }),
    );
    expect(result.kind).toBe("summary");
    if (result.kind !== "summary") return;
    expect(result.summary.week).toBe("2026-11-02");
    expect(result.summary.cost).toEqual({ thisWeek: 1.75, lastWeek: 2 });
  });

  it("reports Subscription usage as the latest weekly-limit reading across the week's records", () => {
    const reading = (utilization: number, resetsAt: number) => ({ status: "allowed", rateLimitType: "seven_day", utilization, resetsAt });
    const result = weeklySummary(
      input({
        records: [
          aRunRecord({ endedAt: "2026-11-06T00:00:00Z", rateLimit: reading(0.62, 1_794_000_000) }), // the latest reading
          aRunRecord({ endedAt: "2026-11-03T00:00:00Z", rateLimit: reading(0.4, 1_793_000_000) }),
          aRunRecord({ endedAt: "2026-11-07T00:00:00Z", rateLimit: null }), // later, but read none
          aRunRecord({ endedAt: "2026-10-28T00:00:00Z", rateLimit: reading(0.9, 1_792_000_000) }), // last week
        ],
      }),
    );
    expect(result).toMatchObject({
      kind: "summary",
      summary: {
        weeklyLimit: {
          thisWeek: { utilization: 0.62, resetsAt: 1_794_000_000 },
          lastWeek: { utilization: 0.9, resetsAt: 1_792_000_000 },
        },
      },
    });
  });

  it("reports no weekly-limit reading in a week whose records read none", () => {
    const result = weeklySummary(input({ records: [aRunRecord({ endedAt: "2026-11-06T00:00:00Z", rateLimit: null })] }));
    expect(result).toMatchObject({ kind: "summary", summary: { weeklyLimit: { thisWeek: null, lastWeek: null } } });
  });

  it("leaves a run whose cost basis is unknown out of the cost, and counts it", () => {
    const result = weeklySummary(
      input({
        records: [
          aRunRecord({ endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1 }),
          aRunRecord({ endedAt: "2026-11-04T00:00:00Z", totalCostUsd: null }),
        ],
      }),
    );
    expect(result).toMatchObject({ kind: "summary", summary: { cost: { thisWeek: 1, lastWeek: 0 }, unknownCost: { thisWeek: 1, lastWeek: 0 } } });
  });

  it("counts the agent PRs merged in the week across every Product repo", () => {
    const result = weeklySummary(
      input({
        records: [aRunRecord()],
        facts: [
          factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-03T00:00:00Z", { number: 50 }),
              aMergedPullRequest("2026-11-08T13:00:00Z", { number: 51 }), // merged after the week
              aMergedPullRequest("2026-10-30T00:00:00Z", { number: 52 }), // last week
              aMergedPullRequest("2026-11-04T00:00:00Z", { number: 53, mergedAt: null }), // closed unmerged
            ],
          }),
          factsOf({ repo: "owner/other", pullRequests: [aMergedPullRequest("2026-11-05T00:00:00Z")] }),
        ],
      }),
    );
    expect(result).toMatchObject({ kind: "summary", summary: { counts: { mergedPullRequests: { thisWeek: 2, lastWeek: 1 } } } });
  });

  it("counts a Ticket as dispatched in the week its first agent:implement was added", () => {
    const result = weeklySummary(
      input({
        records: [aRunRecord()],
        facts: [
          factsOf({
            tickets: [
              aTicketTimeline([aLabelAdded("agent:implement", "2026-11-03T00:00:00Z")], { number: 1 }),
              // Dispatched last week, then a Retry this week: dispatched last week only.
              aTicketTimeline(
                [aLabelAdded("agent:implement", "2026-10-28T00:00:00Z"), aLabelAdded("agent:implement", "2026-11-04T00:00:00Z")],
                { number: 2 },
              ),
              aTicketTimeline([aLabelAdded("ready-for-agent", "2026-11-03T00:00:00Z")], { number: 3 }),
              aTicketTimeline([aLabelAdded("agent:implement", "2026-11-03T00:00:00Z", { action: "unlabeled" })], { number: 4 }),
            ],
          }),
          factsOf({ repo: "owner/other", tickets: [aTicketTimeline([aLabelAdded("agent:implement", "2026-11-06T00:00:00Z")])] }),
        ],
      }),
    );
    expect(result).toMatchObject({ kind: "summary", summary: { counts: { ticketsDispatched: { thisWeek: 2, lastWeek: 1 } } } });
  });

  it("counts the week's Retries and Step-ups from its records", () => {
    const result = weeklySummary(
      input({
        records: [
          aRunRecord({ endedAt: "2026-11-03T00:00:00Z" }), // a first run
          aRunRecord({ endedAt: "2026-11-04T00:00:00Z", retry: 1 }),
          aRunRecord({ endedAt: "2026-11-05T00:00:00Z", retry: 2, stepUp: true }),
          aRunRecord({ endedAt: "2026-11-05T00:00:00Z", role: "review" }),
          aRunRecord({ endedAt: "2026-10-29T00:00:00Z", retry: 1 }), // last week
        ],
      }),
    );
    expect(result).toMatchObject({
      kind: "summary",
      summary: { counts: { retries: { thisWeek: 2, lastWeek: 1 }, stepUps: { thisWeek: 1, lastWeek: 0 } } },
    });
  });

  it("keeps Monday 00:00 local across a daylight-saving change", () => {
    // Los Angeles left daylight saving on Sunday 1 November 2026: last week
    // began at 00:00 PDT (07:00Z) and this week at 00:00 PST (08:00Z).
    const result = weeklySummary(
      input({
        timeZone: "America/Los_Angeles",
        now: "2026-11-09T15:00:00Z", // Monday 07:00 PST
        records: [
          aRunRecord({ endedAt: "2026-10-26T06:59:59Z", totalCostUsd: 8 }), // Sunday 23:59:59 PDT: the week before last
          aRunRecord({ endedAt: "2026-10-26T07:00:00Z", totalCostUsd: 2 }), // Monday 00:00 PDT: last week
          aRunRecord({ endedAt: "2026-11-02T07:59:59Z", totalCostUsd: 1 }), // Sunday 23:59:59 PST: last week
          aRunRecord({ endedAt: "2026-11-02T08:00:00Z", totalCostUsd: 0.5 }), // Monday 00:00 PST: this week
        ],
      }),
    );
    expect(result).toMatchObject({ kind: "summary", summary: { week: "2026-11-02", cost: { thisWeek: 0.5, lastWeek: 3 } } });
  });
});
