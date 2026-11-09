import { describe, expect, it } from "vitest";
import {
  aComment,
  aCommit,
  anAnswersComment,
  aDesignRound,
  aLabelAdded,
  A_REPLAY,
  aMergedPullRequest,
  anEscapeMarkerIssue,
  anOpenAudit,
  anOpenIssue,
  anOpenMonitorIssue,
  anOpenPullRequest,
  anOpenReplay,
  anOpenRetro,
  anAuditRunRecord,
  aReplayBody,
  aReplayRunRecord,
  aRetroRunRecord,
  aReview,
  aRunRecord,
  aScoreEntry,
  aScoreFile,
  aSkippedScoreFile,
  aSpec,
  aTicketTimeline,
  aVerdictComment,
  factsOf,
  UNKNOWN_COST_BASIS,
} from "../__fixtures__/weeklySummary.ts";
import { aMonitorIssueBody, AGROUP_STATS } from "../__fixtures__/monitor.ts";
import { aDesignQueueIssue } from "../__fixtures__/snapshots.ts";
import { RESEARCH_RUN_FAILED_MARKER } from "../loop/markers.ts";
import type { Verdict } from "../loop/types.ts";
import { readRunRecord, type RunRecord } from "./runRecord.ts";
import { type AgentPullRequestFacts, type CommentFacts, type GitHubFacts, type TicketFacts, type WeeklySummaryInput, weeklySummary } from "./weeklySummary.ts";

// The filing: Monday 9 November 2026, 07:00 in Sydney (AEDT, UTC+11). The
// week it covers runs from Monday 2 November 00:00 to Monday 9 November 00:00
// Sydney time, that is 2026-11-01T13:00Z to 2026-11-08T13:00Z.
const NOW = "2026-11-08T20:00:00Z";

function input(overrides: Partial<WeeklySummaryInput> = {}): WeeklySummaryInput {
  return { records: [], scoreFiles: [], facts: [factsOf()], unread: [], operator: "operator", appLogin: "fabrik-app[bot]", timeZone: "Australia/Sydney", now: NOW, ...overrides };
}

describe("the Weekly summary", () => {
  it("is skipped in a week with no records and nothing waiting or stuck", () => {
    expect(weeklySummary(input())).toEqual({ kind: "skip" });
  });

  it.each([
    ["something waiting on the Operator", factsOf({ openIssues: [anOpenIssue({ labels: ["ready-for-human"] })] })],
    ["something stuck", factsOf({ openPullRequests: [anOpenPullRequest()] })],
  ])("isn't skipped in a week with no records but %s", (_, facts) => {
    expect(weeklySummary(input({ facts: [factsOf({ repo: "owner/quiet" }), facts] })).kind).toBe("summary");
  });

  it("isn't skipped in a week with no records but a Product repo the Kit couldn't read", () => {
    expect(weeklySummary(input({ unread: [{ repo: "owner/gone", why: "GitHub GraphQL query failed: Bad Gateway" }] })).kind).toBe("summary");
  });

  it("gives a Product repo the Kit couldn't read a line in its section saying why, and the other repo its whole section", () => {
    const result = weeklySummary(
      input({
        records: [aRunRecord()],
        facts: [factsOf({ repo: "owner/product", openIssues: [anOpenIssue({ labels: ["ready-for-human"] })] })],
        unread: [{ repo: "owner/gone", why: "GitHub GraphQL query failed: Bad Gateway" }],
      }),
    );
    if (result.kind !== "summary") throw new Error("expected a summary");

    expect(result.summary.repos.map(({ repo, unread }) => ({ repo, unread }))).toEqual([
      { repo: "owner/product", unread: null },
      { repo: "owner/gone", unread: "GitHub GraphQL query failed: Bad Gateway" },
    ]);
    expect(result.summary.repos[0]?.waitingOnYou).toHaveLength(1);
    expect(result.body).toContain(
      "## owner/gone\n\nThe Kit couldn't read this repo on GitHub this run, so what waits on you, what's stuck and what's held there, and its PRs, Tickets and Specs in the metrics, are left out of this summary: GitHub GraphQL query failed: Bad Gateway. Re-run the Weekly summary to try it again.",
    );
    expect(result.body).toContain("## owner/product\n\n### Waiting on you");
  });

  it("isn't skipped in a week with no records but an open Audit", () => {
    const facts = [factsOf({ repo: "owner/quiet" }), factsOf({ openAudits: [anOpenAudit()] })];
    expect(weeklySummary(input({ facts })).kind).toBe("summary");
  });

  it("isn't skipped in a week with no records but an open Retro", () => {
    const facts = [factsOf({ repo: "owner/quiet" }), factsOf({ openRetros: [anOpenRetro()] })];
    expect(weeklySummary(input({ facts })).kind).toBe("summary");
  });

  it("isn't skipped in a week with no records but a Replay whose results are in", () => {
    const facts = [factsOf({ repo: "owner/quiet" }), factsOf({ openReplays: [anOpenReplay()] })];
    expect(weeklySummary(input({ facts })).kind).toBe("summary");
  });

  it("isn't skipped in a week with no records but an open Map", () => {
    const facts = [factsOf({ repo: "owner/quiet" }), factsOf({ openIssues: [anOpenIssue({ number: 30, labels: ["wayfinder:map"] })], openMaps: [30] })];
    expect(weeklySummary(input({ facts })).kind).toBe("summary");
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

  it("reports Subscription usage from weekly-limit readings only, never a later five-hour one", () => {
    const result = weeklySummary(
      input({
        records: [
          aRunRecord({ endedAt: "2026-11-05T00:00:00Z", rateLimit: { status: "allowed", rateLimitType: "seven_day", utilization: 0.3, resetsAt: 1_794_000_000 } }),
          aRunRecord({ endedAt: "2026-11-06T00:00:00Z", rateLimit: { status: "allowed", rateLimitType: "five_hour", utilization: 0.95, resetsAt: 1_793_500_000 } }),
        ],
      }),
    );
    expect(result).toMatchObject({ kind: "summary", summary: { weeklyLimit: { thisWeek: { rateLimitType: "seven_day", utilization: 0.3 } } } });
  });

  it("reports no weekly-limit reading in a week whose records read none", () => {
    const result = weeklySummary(input({ records: [aRunRecord({ endedAt: "2026-11-06T00:00:00Z", rateLimit: null })] }));
    expect(result).toMatchObject({ kind: "summary", summary: { weeklyLimit: { thisWeek: null, lastWeek: null } } });
  });

  describe("Subscription usage, per Subscription", () => {
    const reading = (utilization: number, resetsAt: number) => ({ status: "allowed", rateLimitType: "seven_day", utilization, resetsAt });
    const bodyOf = (records: WeeklySummaryInput["records"]) => {
      const result = weeklySummary(input({ records }));
      return result.kind === "summary" ? result.body : "";
    };

    it("shows one line for each Subscription the week's runs used, with its cost and its last weekly-limit reading", () => {
      const body = bodyOf([
        aRunRecord({ endedAt: "2026-11-03T00:00:00Z", subscription: "Claude token", totalCostUsd: 2, rateLimit: reading(0.4, 1_793_000_000) }),
        aRunRecord({ endedAt: "2026-11-05T00:00:00Z", subscription: "Claude token", totalCostUsd: 1, rateLimit: reading(0.97, 1_794_000_000) }),
        aRunRecord({ endedAt: "2026-11-06T00:00:00Z", subscription: "Claude token 2", totalCostUsd: 1.5, rateLimit: reading(0.12, 1_794_500_000) }),
        aRunRecord({ endedAt: "2026-11-07T00:00:00Z", subscription: "Claude token 2", totalCostUsd: 0.25, rateLimit: null }),
        aRunRecord({ endedAt: "2026-10-28T00:00:00Z", subscription: "Claude token", totalCostUsd: 4, rateLimit: reading(0.9, 1_792_000_000) }),
      ]);
      expect(body).toContain(
        [
          "Subscription usage:",
          "",
          "- Claude token: $3.00 API-equivalent cost, 97% of the weekly limit, resetting 2026-11-07 08:20 (Australia/Sydney). Last week: 90%.",
          "- Claude token 2: $1.75 API-equivalent cost, 12% of the weekly limit, resetting 2026-11-13 03:13 (Australia/Sydney).",
        ].join("\n"),
      );
    });

    it("says so for a Subscription whose runs read no weekly limit this week", () => {
      const body = bodyOf([
        aRunRecord({ endedAt: "2026-11-03T00:00:00Z", subscription: "Claude token", totalCostUsd: 2, rateLimit: reading(0.4, 1_793_000_000) }),
        aRunRecord({ endedAt: "2026-11-06T00:00:00Z", subscription: "Claude token 2", totalCostUsd: 0.5, rateLimit: null }),
      ]);
      expect(body).toContain("- Claude token 2: $0.50 API-equivalent cost, no weekly-limit reading this week.");
    });

    it("shows today's one line for a week on one Subscription", () => {
      const body = bodyOf([
        aRunRecord({ endedAt: "2026-11-05T00:00:00Z", subscription: "Claude token", rateLimit: reading(0.97, 1_794_000_000) }),
        aRunRecord({ endedAt: "2026-10-28T00:00:00Z", subscription: "Claude token 2", rateLimit: reading(0.9, 1_792_000_000) }),
      ]);
      expect(body).toContain("\nSubscription usage: 97% of the weekly limit, resetting 2026-11-07 08:20 (Australia/Sydney). Last week: 90%.\n");
      expect(body).not.toContain("- Claude token");
    });

    it("counts a record written before runs named their Subscription towards the first listed Subscription", () => {
      const older = (record: RunRecord) => {
        const { subscription: _, ...rest } = record;
        return readRunRecord({ ...rest, schema: 1 }, ["Claude token", "Claude token 2"]);
      };
      const body = bodyOf(
        [
          older(aRunRecord({ endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 2, rateLimit: reading(0.97, 1_794_000_000) })),
          aRunRecord({ endedAt: "2026-11-05T00:00:00Z", subscription: "Claude token", totalCostUsd: 1 }),
          aRunRecord({ endedAt: "2026-11-06T00:00:00Z", subscription: "Claude token 2", totalCostUsd: 0.5 }),
        ].flatMap((record) => record ?? []),
      );
      expect(body).toContain("- Claude token: $3.00 API-equivalent cost, 97% of the weekly limit, resetting 2026-11-07 08:20 (Australia/Sydney).");
      expect(body).toContain("- Claude token 2: $0.50 API-equivalent cost, no weekly-limit reading this week.");
    });
  });

  it("leaves a run whose cost basis is unknown out of the cost, and counts it", () => {
    const result = weeklySummary(
      input({
        records: [
          aRunRecord({ endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1 }),
          aRunRecord({ endedAt: "2026-11-04T00:00:00Z", ...UNKNOWN_COST_BASIS }),
        ],
      }),
    );
    expect(result).toMatchObject({ kind: "summary", summary: { cost: { thisWeek: 1, lastWeek: 0 }, unknownCost: { thisWeek: 1, lastWeek: 0 } } });
  });

  it("doesn't count a run with no cost figure, such as one its timeout cut off, as one of unknown cost basis", () => {
    const result = weeklySummary(
      input({
        records: [
          aRunRecord({ endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1 }),
          aRunRecord({ endedAt: "2026-11-04T00:00:00Z", jobResult: "cancelled", totalCostUsd: null, transcript: null }),
        ],
        facts: [factsOf({ pullRequests: [aMergedPullRequest("2026-11-05T00:00:00Z")] })],
      }),
    );
    expect(result).toMatchObject({
      kind: "summary",
      summary: {
        cost: { thisWeek: 1 },
        unknownCost: { thisWeek: 0 },
        costPerMergedPullRequest: { thisWeek: { usd: 1, unknownCost: 0 } },
      },
    });
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

  it("breaks the week's Step-ups down by reason", () => {
    const result = weeklySummary(
      input({
        records: [
          aRunRecord({ endedAt: "2026-11-03T00:00:00Z", stepUp: true, stepUpReason: "marked" }),
          aRunRecord({ endedAt: "2026-11-03T00:00:00Z", retry: 1, stepUp: true, stepUpReason: "marked" }),
          aRunRecord({ endedAt: "2026-11-04T00:00:00Z", retry: 2, stepUp: true, stepUpReason: "retry" }),
          aRunRecord({ endedAt: "2026-11-05T00:00:00Z", stepUp: true, stepUpReason: "request-changes", requestChanges: true }),
          aRunRecord({ endedAt: "2026-10-29T00:00:00Z", stepUp: true, stepUpReason: "conflict-only" }), // last week
        ],
      }),
    );
    expect(result).toMatchObject({
      kind: "summary",
      summary: {
        counts: {
          stepUps: { thisWeek: 4, lastWeek: 1 },
          stepUpsByReason: {
            thisWeek: { retry: 1, marked: 2, "request-changes": 1, "conflict-only": 0 },
            lastWeek: { retry: 0, marked: 0, "request-changes": 0, "conflict-only": 1 },
          },
        },
      },
    });
  });

  it("counts the marked Tickets merged in the week, and how many of them needed no Retry", () => {
    const marked = (issue: number, endedAt: string) => aRunRecord({ issue, endedAt, stepUp: true, stepUpReason: "marked" });
    const result = weeklySummary(
      input({
        records: [
          marked(7, "2026-11-03T00:00:00Z"), // merged with no Retry
          marked(8, "2026-11-03T00:00:00Z"),
          aRunRecord({ issue: 8, endedAt: "2026-11-04T00:00:00Z", retry: 1, stepUp: true, stepUpReason: "marked" }),
          // Marked only after its first run: no Stepped-up start.
          aRunRecord({ issue: 9, endedAt: "2026-11-03T00:00:00Z" }),
          aRunRecord({ issue: 9, endedAt: "2026-11-04T00:00:00Z", retry: 1, stepUp: true, stepUpReason: "marked" }),
          aRunRecord({ issue: 10, endedAt: "2026-11-03T00:00:00Z" }), // unmarked
          marked(6, "2026-10-27T00:00:00Z"), // merged last week
        ],
        facts: [
          factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-05T00:00:00Z", { number: 50, ticket: 7 }),
              aMergedPullRequest("2026-11-05T00:00:00Z", { number: 51, ticket: 8 }),
              aMergedPullRequest("2026-11-05T00:00:00Z", { number: 52, ticket: 9 }),
              aMergedPullRequest("2026-11-05T00:00:00Z", { number: 53, ticket: 10 }),
              aMergedPullRequest("2026-10-29T00:00:00Z", { number: 49, ticket: 6 }),
            ],
          }),
        ],
      }),
    );
    expect(result).toMatchObject({
      kind: "summary",
      summary: { counts: { steppedUpStarts: { thisWeek: { merged: 2, noRetry: 1 }, lastWeek: { merged: 1, noRetry: 1 } } } },
    });
    if (result.kind !== "summary") throw new Error("expected a summary");
    expect(result.body).toContain("| Stepped-up starts merged | 2 (1 with no Retry) | 1 (1 with no Retry) | +1 |");
  });

  describe("Waiting on you", () => {
    const HOUR = 60 * 60 * 1000;
    const head = "h".repeat(40);
    const operatorAnswer = (at: string) => aComment("Option A, please.", at, { author: "operator", byBot: false });
    const waitingIn = (facts: Parameters<typeof factsOf>[0]) => {
      const result = weeklySummary(input({ records: [aRunRecord()], facts: [factsOf(facts)] }));
      if (result.kind !== "summary") throw new Error("expected a summary");
      return result.summary.repos[0]?.waitingOnYou;
    };

    it("lists unanswered Design rounds, ready-for-human issues and PRs at the Merge gate, oldest first, with their ages", () => {
      const waiting = waitingIn({
        openIssues: [
          anOpenIssue({
            number: 12,
            title: "Design the thing",
            labels: ["needs-design"],
            comments: [aDesignRound(1, "2026-11-02T20:00:00Z"), operatorAnswer("2026-11-03T20:00:00Z"), aDesignRound(2, "2026-11-05T20:00:00Z")],
          }),
          anOpenIssue({
            number: 13,
            title: "Rotate the key",
            labels: ["ready-for-human"],
            labelEvents: [aLabelAdded("needs-triage", "2026-10-30T20:00:00Z"), aLabelAdded("ready-for-human", "2026-11-01T20:00:00Z")],
          }),
          // The Operator answered the last round: the next move is the session's.
          anOpenIssue({
            number: 14,
            labels: ["needs-design"],
            comments: [aDesignRound(1, "2026-11-02T20:00:00Z"), operatorAnswer("2026-11-03T20:00:00Z")],
          }),
        ],
        openPullRequests: [
          anOpenPullRequest({ number: 50, title: "Build the thing", draft: false, comments: [aVerdictComment("pass", head, "2026-11-07T20:00:00Z")] }),
          // Passed on an older head: the Operator pushed since, so it waits for its Review.
          anOpenPullRequest({ number: 51, draft: false, comments: [aVerdictComment("pass", "o".repeat(40), "2026-11-07T20:00:00Z")] }),
          // Still a draft: the Loop has it.
          anOpenPullRequest({ number: 52, comments: [aVerdictComment("pass", head, "2026-11-07T20:00:00Z")] }),
          // Its latest Verdict on its head is a flaw.
          anOpenPullRequest({
            number: 53,
            draft: false,
            comments: [aVerdictComment("pass", head, "2026-11-06T20:00:00Z"), aVerdictComment("execution-flaw", head, "2026-11-07T20:00:00Z")],
          }),
        ],
      });
      expect(waiting).toEqual([
        {
          kind: "ready-for-human",
          number: 13,
          title: "Rotate the key",
          url: "https://github.com/owner/product/issues/13",
          since: "2026-11-01T20:00:00Z",
          age: 7 * 24 * HOUR,
        },
        {
          kind: "design-round",
          number: 12,
          title: "Design the thing",
          url: "https://github.com/owner/product/issues/12",
          since: "2026-11-05T20:00:00Z",
          age: 3 * 24 * HOUR,
        },
        {
          kind: "merge-gate",
          number: 50,
          title: "Build the thing",
          url: "https://github.com/owner/product/pull/50",
          since: "2026-11-07T20:00:00Z",
          age: 24 * HOUR,
          operatorWait: 24 * HOUR,
        },
      ]);
    });

    it("lists the App's needs-info issue nobody answered as the Operator's, waiting since it got needs-info (#425)", () => {
      const asked = (overrides: Parameters<typeof anOpenIssue>[0]) =>
        anOpenIssue({
          number: 15,
          title: "TypeError in checkout",
          author: "fabrik-app[bot]",
          labels: ["bug", "needs-info", "fabrik:monitor"],
          labelEvents: [aLabelAdded("needs-info", "2026-11-06T20:00:00Z")],
          comments: [aComment("@operator The Monitor filed this issue, so its question is yours.", "2026-11-06T20:00:00Z", { author: "fabrik-app[bot]", byBot: true })],
          ...overrides,
        });
      const waiting = waitingIn({
        openIssues: [
          asked({}),
          // A person filed it: Triage asked them, not the Operator.
          asked({ number: 16, author: "kate" }),
          // Someone answered: Triage has it again, or Stuck lists it.
          asked({ number: 17, comments: [aComment("Since 2.3.", "2026-11-07T20:00:00Z", { author: "operator", byBot: false })] }),
        ],
      });
      expect(waiting).toEqual([
        {
          kind: "monitor-needs-info",
          number: 15,
          title: "TypeError in checkout",
          url: "https://github.com/owner/product/issues/15",
          since: "2026-11-06T20:00:00Z",
          age: 2 * 24 * HOUR,
        },
      ]);
    });

    describe("with an open Audit", () => {
      const waitingIn = (facts: Parameters<typeof factsOf>[0]) => {
        const result = weeklySummary(input({ records: [aRunRecord()], facts: [factsOf(facts)] }));
        if (result.kind !== "summary") throw new Error("expected a summary");
        return result.summary.repos[0]?.waitingOnYou;
      };

      it("lists the Fabrik App's open Audit, filled or still pending, aged from when it was opened", () => {
        const waiting = waitingIn({
          openIssues: [anOpenIssue({ number: 13, labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", "2026-11-06T20:00:00Z")] })],
          openAudits: [anOpenAudit({ number: 90, title: "Audit: week of 2026-11-02", createdAt: "2026-11-02T20:00:00Z" })],
        });
        expect(waiting).toEqual([
          {
            kind: "audit",
            number: 90,
            title: "Audit: week of 2026-11-02",
            url: "https://github.com/owner/product/issues/90",
            since: "2026-11-02T20:00:00Z",
            age: 6 * 24 * HOUR,
          },
          expect.objectContaining({ kind: "ready-for-human", number: 13 }),
        ]);
      });

      it("never lists a fabrik:audit issue someone other than the Fabrik App opened", () => {
        const waiting = waitingIn({
          openAudits: [anOpenAudit({ author: "operator" }), anOpenAudit({ number: 91, author: "other-app[bot]" })],
        });
        expect(waiting).toEqual([]);
      });
    });

    describe("with an open Retro", () => {
      const waitingWith = (facts: Parameters<typeof factsOf>[0]) => {
        const result = weeklySummary(input({ records: [aRunRecord()], facts: [factsOf(facts)] }));
        if (result.kind !== "summary") throw new Error("expected a summary");
        return result.summary.repos[0]?.waitingOnYou;
      };

      it("lists the Fabrik App's open Retro, filled or still pending, aged from when it was opened", () => {
        const waiting = waitingWith({
          openIssues: [anOpenIssue({ number: 13, labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", "2026-11-06T20:00:00Z")] })],
          openRetros: [anOpenRetro({ number: 120, title: "Retro: week of 2026-10-26", createdAt: "2026-10-31T20:00:00Z" })],
        });
        expect(waiting).toEqual([
          {
            kind: "retro",
            number: 120,
            title: "Retro: week of 2026-10-26",
            url: "https://github.com/owner/product/issues/120",
            since: "2026-10-31T20:00:00Z",
            age: 8 * 24 * HOUR,
          },
          expect.objectContaining({ kind: "ready-for-human", number: 13 }),
        ]);
      });

      it("never lists a fabrik:retro issue someone other than the Fabrik App opened", () => {
        const waiting = waitingWith({
          openRetros: [anOpenRetro({ author: "operator" }), anOpenRetro({ number: 121, author: "other-app[bot]" })],
        });
        expect(waiting).toEqual([]);
      });
    });

    describe("with an open Replay", () => {
      it("lists the Operator's open replay issue whose results are in, waiting since the Kit last wrote its body", () => {
        const waiting = waitingIn({
          openIssues: [anOpenIssue({ number: 13, labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", "2026-11-05T20:00:00Z")] })],
          openReplays: [anOpenReplay({ number: 140, title: "Replay review.effort: high", lastEditedAt: "2026-11-06T20:00:00Z" })],
        });
        expect(waiting).toEqual([
          expect.objectContaining({ kind: "ready-for-human", number: 13 }),
          {
            kind: "replay",
            number: 140,
            title: "Replay review.effort: high",
            url: "https://github.com/owner/product/issues/140",
            since: "2026-11-06T20:00:00Z",
            age: 2 * 24 * HOUR,
          },
        ]);
      });

      it("lists one whose Tickets all failed too, its results being in", () => {
        const failed = aReplayBody({ state: "failed", run: 2001, reason: "the Sandbox timed out" });
        expect(waitingIn({ openReplays: [anOpenReplay({ body: failed })] })).toMatchObject([{ kind: "replay", number: 140 }]);
      });

      it.each([
        ["whose request the tick hasn't accepted", { body: "```replay\nreview.effort: high\n```\n" }],
        ["whose Ticket is still pending", { body: aReplayBody({ state: "pending" }) }],
        ["whose Ticket is in progress", { body: aReplayBody({ state: "in-progress", run: 2000, retrying: null, startedAt: "2026-11-05T10:00:00.000Z" }) }],
        ["that someone other than the Operator filed", { author: "someone-else" }],
      ])("never lists one %s", (_, overrides) => {
        expect(waitingIn({ openReplays: [anOpenReplay(overrides)] })).toEqual([]);
      });
    });

    describe("with Maps", () => {
      const waitingWith = (facts: Parameters<typeof factsOf>[0]) => {
        const result = weeklySummary(input({ records: [aRunRecord()], facts: [factsOf(facts)] }));
        if (result.kind !== "summary") throw new Error("expected a summary");
        return result.summary.repos[0]?.waitingOnYou;
      };

      it("lists each open Map, waiting since it got wayfinder:map, with how many of its Decisions wait on the Operator: its open grilling, prototype and task ones", () => {
        const waiting = waitingWith({
          openIssues: [
            anOpenIssue({
              number: 30,
              title: "Let patients book group classes",
              labels: ["enhancement", "wayfinder:map"],
              labelEvents: [aLabelAdded("needs-design", "2026-10-20T20:00:00Z"), aLabelAdded("wayfinder:map", "2026-11-03T20:00:00Z")],
              // 35 is closed, so it isn't among the open issues.
              subIssues: [31, 32, 33, 34, 35],
            }),
            anOpenIssue({ number: 31, labels: ["wayfinder:grilling"] }),
            anOpenIssue({ number: 32, labels: ["wayfinder:prototype"] }),
            anOpenIssue({ number: 33, labels: ["wayfinder:task"] }),
            // The Researcher's, not the Operator's.
            anOpenIssue({ number: 34, labels: ["wayfinder:research"] }),
            // On no Map.
            anOpenIssue({ number: 36, labels: ["wayfinder:grilling"] }),
            // Charted by hand, labelled as it was opened.
            anOpenIssue({ number: 40, title: "Move intake online", labels: ["wayfinder:map"], createdAt: "2026-11-05T20:00:00Z", subIssues: [41] }),
            anOpenIssue({ number: 41, labels: ["wayfinder:task"] }),
          ],
          openMaps: [30, 40],
        });
        expect(waiting).toEqual([
          {
            kind: "map",
            number: 30,
            title: "Let patients book group classes",
            url: "https://github.com/owner/product/issues/30",
            since: "2026-11-03T20:00:00Z",
            age: 5 * 24 * HOUR,
            decisionsWaiting: 3,
          },
          {
            kind: "map",
            number: 40,
            title: "Move intake online",
            url: "https://github.com/owner/product/issues/40",
            since: "2026-11-05T20:00:00Z",
            age: 3 * 24 * HOUR,
            decisionsWaiting: 1,
          },
        ]);
      });

      const failureNotice = (decision: number, at: string) =>
        aComment(`${RESEARCH_RUN_FAILED_MARKER}\n@operator The Research run on #${decision} failed: it timed out.`, at);
      const mapOf = (number: number, decisions: readonly number[]) =>
        anOpenIssue({ number, labels: ["wayfinder:map"], labelEvents: [aLabelAdded("wayfinder:map", "2026-11-07T20:00:00Z")], subIssues: decisions });

      it("lists each research Decision on an open Map whose last run failed, waiting since the failure notice for the Operator to re-add agent:research", () => {
        const waiting = waitingWith({
          openIssues: [
            mapOf(30, [31, 32, 33]),
            anOpenIssue({
              number: 31,
              title: "Which booking providers take group payments?",
              labels: ["wayfinder:research"],
              // A person's reply leaves the notice standing.
              comments: [failureNotice(31, "2026-11-06T20:00:00Z"), aComment("Odd, it ran fine last time.", "2026-11-07T08:00:00Z", { author: "operator", byBot: false })],
            }),
            // A later run's word, such as its resolution, answers the failure.
            anOpenIssue({
              number: 32,
              labels: ["wayfinder:research"],
              comments: [failureNotice(32, "2026-11-04T20:00:00Z"), aComment("Resolved: Stripe and Square both do.", "2026-11-05T20:00:00Z")],
            }),
            // Its run never failed.
            anOpenIssue({ number: 33, labels: ["wayfinder:research"] }),
          ],
          openMaps: [30],
        });
        expect(waiting).toEqual([
          {
            kind: "research-failed",
            number: 31,
            title: "Which booking providers take group payments?",
            url: "https://github.com/owner/product/issues/31",
            since: "2026-11-06T20:00:00Z",
            age: 2 * 24 * HOUR,
          },
          expect.objectContaining({ kind: "map", number: 30, decisionsWaiting: 0 }),
        ]);
      });

      it("reads a research Decision's last run from the Fabrik App's comments alone, so another bot's comment neither clears the failure nor fakes one", () => {
        const otherBot = { author: "dependabot[bot]", byBot: true };
        const waiting = waitingWith({
          openIssues: [
            mapOf(30, [31, 32]),
            // Another bot's comment after the notice leaves it standing, and the age still runs from the notice.
            anOpenIssue({
              number: 31,
              labels: ["wayfinder:research"],
              comments: [failureNotice(31, "2026-11-06T20:00:00Z"), aComment("Bumped a dependency.", "2026-11-07T08:00:00Z", otherBot)],
            }),
            // Another bot's look-alike notice is no failure.
            anOpenIssue({
              number: 32,
              labels: ["wayfinder:research"],
              comments: [aComment(`${RESEARCH_RUN_FAILED_MARKER}\nA look-alike.`, "2026-11-06T20:00:00Z", otherBot)],
            }),
          ],
          openMaps: [30],
        });
        expect(waiting).toEqual([
          expect.objectContaining({ kind: "research-failed", number: 31, since: "2026-11-06T20:00:00Z" }),
          expect.objectContaining({ kind: "map", number: 30 }),
        ]);
      });

      it("never lists a failed research Decision the Operator has re-added agent:research to since, or one on no open Map", () => {
        const failed = (number: number, overrides: Parameters<typeof anOpenIssue>[0] = {}) =>
          anOpenIssue({ number, labels: ["wayfinder:research"], comments: [failureNotice(number, "2026-11-06T20:00:00Z")], ...overrides });
        const waiting = waitingWith({
          openIssues: [
            mapOf(30, [31]),
            // Re-added, so its run has started again or soon will.
            failed(31, { labelEvents: [aLabelAdded("agent:research", "2026-11-07T20:00:00Z", { actor: "operator" })] }),
            // Its Map is closed, or it never had one.
            failed(32),
            // Its parent is a Spec, not a Map.
            anOpenIssue({ number: 3, labels: ["ready-for-agent"], subIssues: [33] }),
            failed(33),
          ],
          openMaps: [30],
        });
        expect(waiting).toEqual([expect.objectContaining({ kind: "map", number: 30 })]);
      });
    });
  });

  describe("Stuck", () => {
    const HOUR = 60 * 60 * 1000;
    const hoursAgo = (hours: number) => new Date(Date.parse(NOW) - hours * HOUR).toISOString();
    const person = (body: string, at: string) => aComment(body, at, { author: "someone", byBot: false });
    const stuckIn = (facts: Parameters<typeof factsOf>[0], records = [aRunRecord()]) => {
      const result = weeklySummary(input({ records, facts: [factsOf(facts)] }));
      if (result.kind !== "summary") throw new Error("expected a summary");
      return result.summary.repos[0]?.stuck;
    };
    const askedOn = (labelledAt: string, comments: Parameters<typeof aComment>[] = []) =>
      anOpenIssue({
        number: 20,
        title: "It crashes",
        labels: ["needs-info"],
        labelEvents: [aLabelAdded("needs-info", labelledAt)],
        comments: [aComment("Which version are you on?", labelledAt), ...comments.map((args) => aComment(...args))],
      });

    it.each([
      [23, []],
      [25, [{ kind: "needs-info-answered", number: 20, title: "It crashes", url: "https://github.com/owner/product/issues/20" }]],
    ])("lists a needs-info issue someone answered %i hours ago with no state change since only past 24 hours", (hours, stuck) => {
      const issue = askedOn(hoursAgo(30), [["Version 2.", hoursAgo(hours), { author: "someone", byBot: false }]]);
      expect(stuckIn({ openIssues: [issue] })).toMatchObject(stuck);
    });

    it("dates an answered needs-info issue from the first answer after the question", () => {
      const issue = askedOn(hoursAgo(50), [
        ["An earlier thought.", hoursAgo(60), { author: "someone", byBot: false }],
        ["Version 2.", hoursAgo(40), { author: "someone", byBot: false }],
        ["Also on 3.", hoursAgo(30), { author: "someone", byBot: false }],
      ]);
      expect(stuckIn({ openIssues: [issue] })).toMatchObject([{ kind: "needs-info-answered", since: hoursAgo(40), age: 40 * HOUR }]);
    });

    it("doesn't list a needs-info issue only a bot answered, or one whose answer came before the question", () => {
      const botOnly = askedOn(hoursAgo(50), [["Thanks for the report!", hoursAgo(40), { author: "dependabot[bot]", byBot: true }]]);
      const answeredBefore = { ...askedOn(hoursAgo(50)), number: 21, comments: [person("Version 2.", hoursAgo(60))] };
      expect(stuckIn({ openIssues: [botOnly, answeredBefore] })).toEqual([]);
    });

    it("doesn't list a needs-info issue whose state changed after the answer", () => {
      const issue = {
        ...askedOn(hoursAgo(50), [["Version 2.", hoursAgo(40), { author: "someone", byBot: false }]]),
        labelEvents: [
          aLabelAdded("needs-info", hoursAgo(50)),
          aLabelAdded("needs-info", hoursAgo(35), { action: "unlabeled" }),
          aLabelAdded("needs-triage", hoursAgo(35)),
          aLabelAdded("needs-info", hoursAgo(30)),
        ],
      };
      expect(stuckIn({ openIssues: [issue] })).toEqual([]);
    });

    it.each([
      ["commit", (at: string) => anOpenPullRequest({ number: 51, commits: [{ at }] })],
      ["comment", (at: string) => anOpenPullRequest({ number: 51, comments: [aComment("Still going.", at)] })],
      ["label event", (at: string) => anOpenPullRequest({ number: 51, labelEvents: [aLabelAdded("agent:review", at)] })],
    ])("lists a draft agent PR whose last %s came more than 24 hours ago", (_, draft) => {
      expect(stuckIn({ openPullRequests: [draft(hoursAgo(23))] })).toEqual([]);
      expect(stuckIn({ openPullRequests: [draft(hoursAgo(25))] })).toEqual([
        {
          kind: "idle-draft",
          number: 51,
          title: "Build the thing",
          url: "https://github.com/owner/product/pull/51",
          since: hoursAgo(25),
          age: 25 * HOUR,
        },
      ]);
    });

    it("doesn't list an agent PR out of draft, however long it has been quiet", () => {
      expect(stuckIn({ openPullRequests: [anOpenPullRequest({ draft: false })] })).toEqual([]);
    });

    it.each([
      [23, []],
      [25, [{ kind: "infrastructure-failure", number: 7, title: "Build the thing", url: "https://github.com/owner/product/issues/7", failure: "timeout" }]],
    ])("lists an open Ticket whose latest record, %i hours ago, ended in an Infrastructure failure, only past 24 hours", (hours, stuck) => {
      const records = [
        aRunRecord({ endedAt: hoursAgo(40) }),
        aRunRecord({ endedAt: hoursAgo(hours), jobResult: "cancelled", infrastructureFailure: "timeout" }),
      ];
      expect(stuckIn({ openIssues: [anOpenIssue({ number: 7, title: "Build the thing" })] }, records)).toMatchObject(stuck);
    });

    it("doesn't list a Ticket that has a record after its Infrastructure failure, or one that's closed", () => {
      const records = [
        aRunRecord({ endedAt: hoursAgo(40), infrastructureFailure: "provider-error" }),
        aRunRecord({ endedAt: hoursAgo(30) }),
        aRunRecord({ issue: 8, endedAt: hoursAgo(40), infrastructureFailure: "provider-error" }), // Ticket 8 is closed
        aRunRecord({ repo: "owner/other", issue: 12, endedAt: hoursAgo(40), infrastructureFailure: "crash" }), // another repo's 12
      ];
      expect(stuckIn({ openIssues: [anOpenIssue({ number: 7 }), anOpenIssue({ number: 12 })] }, records)).toEqual([]);
    });

    it("doesn't list an issue whose failed run was a Triage or a Design turn, as it isn't a Ticket", () => {
      const records = [
        aRunRecord({ role: "triage", issue: 13, pullRequest: null, endedAt: hoursAgo(40), infrastructureFailure: "crash" }),
        aRunRecord({ role: "design", issue: 14, pullRequest: null, endedAt: hoursAgo(40), infrastructureFailure: "timeout" }),
      ];
      expect(stuckIn({ openIssues: [anOpenIssue({ number: 13 }), anOpenIssue({ number: 14 })] }, records)).toEqual([]);
    });

    it("a judge run's record neither hides the failed run it scored nor is listed for failing itself", () => {
      const records = [
        aRunRecord({ endedAt: hoursAgo(30), jobResult: "cancelled", infrastructureFailure: "timeout" }),
        aRunRecord({ role: "score", endedAt: hoursAgo(29), baseSha: null }), // scored the timed-out run, after it
        aRunRecord({ issue: 9, endedAt: hoursAgo(40) }),
        aRunRecord({ role: "score", issue: 9, endedAt: hoursAgo(39), baseSha: null, jobResult: "failure", infrastructureFailure: "crash" }),
      ];
      expect(stuckIn({ openIssues: [anOpenIssue({ number: 7, title: "Build the thing" }), anOpenIssue({ number: 9 })] }, records)).toEqual([
        {
          kind: "infrastructure-failure",
          number: 7,
          title: "Build the thing",
          url: "https://github.com/owner/product/issues/7",
          since: hoursAgo(30),
          age: 30 * HOUR,
          failure: "timeout",
        },
      ]);
    });
  });

  describe("Human touches per merged PR", () => {
    // Ticket 7 dispatched on Monday, its PR merged on Friday.
    const DISPATCH = "2026-11-02T00:00:00Z";
    const MERGE = "2026-11-06T00:00:00Z";
    const touches = (pullRequest: Partial<AgentPullRequestFacts>, ticket: Partial<TicketFacts> = {}, more: AgentPullRequestFacts[] = []) => {
      const result = weeklySummary(
        input({
          records: [aRunRecord()],
          facts: [
            factsOf({
              pullRequests: [aMergedPullRequest(MERGE, pullRequest), ...more],
              tickets: [aTicketTimeline([aLabelAdded("agent:implement", DISPATCH)], ticket)],
            }),
          ],
        }),
      );
      if (result.kind !== "summary") throw new Error("expected a summary");
      return result.summary.humanTouches.thisWeek;
    };

    it("counts each run of consecutive commits not made by the Fabrik App as one push", () => {
      const commits = [
        aCommit("2026-11-02T01:00:00Z", { byApp: true }),
        aCommit("2026-11-03T01:00:00Z"), // the Operator's push of two commits
        aCommit("2026-11-03T01:01:00Z"),
        aCommit("2026-11-04T01:00:00Z", { byApp: true }),
        aCommit("2026-11-05T01:00:00Z"), // a second push
      ];
      expect(touches({ commits })).toBe(2);
    });

    it("counts each Request changes review by the Operator", () => {
      const reviews = [
        aReview("2026-11-03T00:00:00Z"),
        aReview("2026-11-04T00:00:00Z"),
        aReview("2026-11-05T00:00:00Z", { state: "approved" }),
        aReview("2026-11-05T00:00:00Z", { author: "someone-else" }),
      ];
      expect(touches({ reviews })).toBe(2);
    });

    it("counts each agent:implement or agent:review the Operator added themselves", () => {
      const byOperator = { actor: "operator" };
      expect(
        touches(
          {
            labelEvents: [
              aLabelAdded("agent:review", "2026-11-04T00:00:00Z", byOperator),
              aLabelAdded("agent:review", "2026-11-04T01:00:00Z"), // the App's
            ],
          },
          {
            labelEvents: [
              aLabelAdded("agent:implement", DISPATCH),
              aLabelAdded("agent:implement", "2026-11-03T00:00:00Z", byOperator),
              aLabelAdded("agent:implement", "2026-11-03T01:00:00Z"), // the App's Retry
              aLabelAdded("agent:implement", "2026-11-03T02:00:00Z", { ...byOperator, action: "unlabeled" }),
              aLabelAdded("needs-design", "2026-11-03T03:00:00Z", byOperator),
            ],
          },
        ),
      ).toBe(2);
    });

    it("counts the Ticket being labelled ready-for-human after Dispatch, a Pairing session on it", () => {
      expect(touches({}, { labelEvents: [aLabelAdded("agent:implement", DISPATCH), aLabelAdded("ready-for-human", "2026-11-04T00:00:00Z")] })).toBe(1);
      expect(touches({}, { labelEvents: [aLabelAdded("ready-for-human", "2026-11-01T00:00:00Z"), aLabelAdded("agent:implement", DISPATCH)] })).toBe(0);
    });

    it("counts each Operator step the Ticket was blocked by", () => {
      const blockedBy = [
        { number: 3, labels: ["ready-for-human"] }, // an Operator step
        { number: 4, labels: ["ready-for-human", "enhancement"] },
        { number: 5, labels: ["ready-for-agent"] }, // a Ticket
      ];
      expect(touches({}, { blockedBy })).toBe(2);
    });

    it("never counts the merge, Design-session answers or Operator comments", () => {
      expect(
        touches(
          {
            comments: [
              { url: "https://github.com/owner/product/pull/50#issuecomment-2", author: "operator", byBot: false, body: "Looks good, merging.", at: "2026-11-05T00:00:00Z" },
              { url: "https://github.com/owner/product/pull/50#issuecomment-2", author: "operator", byBot: false, body: "Answering round 2: yes.", at: "2026-11-05T01:00:00Z" },
            ],
            reviews: [aReview("2026-11-05T02:00:00Z", { state: "commented" })],
          },
        ),
      ).toBe(0);
    });

    it("counts only what came between Dispatch and the merge", () => {
      const reviews = [aReview("2026-11-01T00:00:00Z"), aReview("2026-11-03T00:00:00Z"), aReview("2026-11-06T00:00:01Z")];
      const commits = [aCommit("2026-11-01T00:00:00Z"), aCommit("2026-11-06T00:00:01Z")];
      expect(touches({ reviews, commits })).toBe(1);
    });

    it("averages over the week's merged PRs", () => {
      const other = aMergedPullRequest("2026-11-05T00:00:00Z", { number: 51, ticket: 8 });
      expect(touches({ reviews: [aReview("2026-11-03T00:00:00Z")] }, {}, [other])).toBe(0.5);
    });
  });

  describe("cycle time and Operator wait", () => {
    const HOUR = 60 * 60 * 1000;
    const summaryOf = (facts: GitHubFacts) => {
      const result = weeklySummary(input({ records: [aRunRecord()], facts: [facts] }));
      if (result.kind !== "summary") throw new Error("expected a summary");
      return result.summary;
    };

    it("runs cycle time from Dispatch, the first agent:implement, to the merge, as a median", () => {
      const summary = summaryOf(
        factsOf({
          pullRequests: [
            aMergedPullRequest("2026-11-03T10:00:00Z", { number: 50, ticket: 1 }),
            aMergedPullRequest("2026-11-04T00:00:00Z", { number: 51, ticket: 2 }),
            aMergedPullRequest("2026-11-05T00:00:00Z", { number: 52, ticket: 3 }),
            aMergedPullRequest("2026-10-30T00:00:00Z", { number: 53, ticket: 4 }), // last week
          ],
          tickets: [
            // 10 hours, a Retry's agent:implement not restarting it.
            aTicketTimeline([aLabelAdded("agent:implement", "2026-11-03T00:00:00Z"), aLabelAdded("agent:implement", "2026-11-03T05:00:00Z")], {
              number: 1,
            }),
            aTicketTimeline([aLabelAdded("agent:implement", "2026-11-03T00:00:00Z")], { number: 2 }), // 24 hours
            aTicketTimeline([aLabelAdded("agent:implement", "2026-11-03T00:00:00Z")], { number: 3 }), // 48 hours
            aTicketTimeline([aLabelAdded("agent:implement", "2026-10-29T00:00:00Z")], { number: 4 }), // 24 hours
          ],
        }),
      );
      expect(summary.cycleTimeMs).toEqual({ thisWeek: 24 * HOUR, lastWeek: 24 * HOUR });
    });

    it("takes the middle two's mean for an even count, and none in a week with no merged PR", () => {
      const summary = summaryOf(
        factsOf({
          pullRequests: [
            aMergedPullRequest("2026-11-03T10:00:00Z", { number: 50, ticket: 1 }),
            aMergedPullRequest("2026-11-04T00:00:00Z", { number: 51, ticket: 2 }),
          ],
          tickets: [
            aTicketTimeline([aLabelAdded("agent:implement", "2026-11-03T00:00:00Z")], { number: 1 }), // 10 hours
            aTicketTimeline([aLabelAdded("agent:implement", "2026-11-03T00:00:00Z")], { number: 2 }), // 24 hours
          ],
        }),
      );
      expect(summary.cycleTimeMs).toEqual({ thisWeek: 17 * HOUR, lastWeek: null });
    });

    it("runs Operator wait from the last passing Verdict, read through its marker, to the merge", () => {
      const verdict = (v: Verdict, at: string, overrides: Partial<CommentFacts> = {}) => aVerdictComment(v, "a".repeat(40), at, overrides);
      const summary = summaryOf(
        factsOf({
          pullRequests: [
            aMergedPullRequest("2026-11-04T00:00:00Z", {
              number: 50,
              comments: [
                verdict("pass", "2026-11-03T00:00:00Z"),
                verdict("execution-flaw", "2026-11-03T06:00:00Z"),
                verdict("pass", "2026-11-03T12:00:00Z"), // the last pass: 12 hours
                verdict("pass", "2026-11-03T20:00:00Z", { byBot: false, author: "operator" }), // quoting a marker fakes nothing
                { url: "https://github.com/owner/product/pull/50#issuecomment-2", author: "operator", byBot: false, body: "Merging.", at: "2026-11-03T22:00:00Z" },
              ],
            }),
            aMergedPullRequest("2026-11-05T00:00:00Z", { number: 51 }), // no passing Verdict: left out
          ],
        }),
      );
      expect(summary.operatorWaitMs).toEqual({ thisWeek: 12 * HOUR, lastWeek: null });
    });
  });

  describe("revert rate", () => {
    // This week's 30-day window runs from 2026-10-09T13:00Z to the week's end,
    // 2026-11-08T13:00Z; last week's from 2026-10-02T13:00Z to 2026-11-01T13:00Z.
    const sha = (n: number) => String(n).repeat(40);
    const merged = (number: number, mergedAt: string) =>
      aMergedPullRequest(mergedAt, { number, mergeSha: sha(number), title: `Build thing ${number}` });
    const revertRateOf = (facts: Partial<GitHubFacts>) => {
      const result = weeklySummary(input({ records: [aRunRecord()], facts: [factsOf(facts)] }));
      if (result.kind !== "summary") throw new Error("expected a summary");
      return result.summary.revertRate;
    };

    it("counts an agent PR reverted by a default-branch commit with its merge sha's trailer", () => {
      const rate = revertRateOf({
        pullRequests: [merged(1, "2026-10-20T00:00:00Z"), merged(2, "2026-10-21T00:00:00Z")],
        defaultBranchCommits: [{ message: `Revert "Build thing 1"\n\nThis reverts commit ${sha(1)}.`, at: "2026-11-04T00:00:00Z" }],
      });
      expect(rate).toEqual({ thisWeek: { reverted: 1, merged: 2 }, lastWeek: { reverted: 0, merged: 2 } });
    });

    it("counts an agent PR reverted by a merged PR titled Revert and its title", () => {
      const rate = revertRateOf({
        pullRequests: [merged(1, "2026-10-20T00:00:00Z"), merged(2, "2026-10-21T00:00:00Z")],
        mergedPullRequestTitles: [
          { title: 'Revert "Build thing 2"', mergedAt: "2026-10-25T00:00:00Z" },
          { title: 'Revert "Something else"', mergedAt: "2026-10-25T00:00:00Z" },
        ],
      });
      expect(rate).toEqual({ thisWeek: { reverted: 1, merged: 2 }, lastWeek: { reverted: 1, merged: 2 } });
    });

    it("doesn't count a revert outside the 30-day window, or of a PR merged outside it", () => {
      const rate = revertRateOf({
        pullRequests: [merged(1, "2026-10-20T00:00:00Z"), merged(2, "2026-10-05T00:00:00Z")],
        defaultBranchCommits: [
          { message: `This reverts commit ${sha(1)}.`, at: "2026-11-08T14:00:00Z" }, // after the week
          { message: `This reverts commit ${sha(2)}.`, at: "2026-10-12T00:00:00Z" }, // of a PR merged before this week's window
        ],
      });
      expect(rate).toEqual({ thisWeek: { reverted: 0, merged: 1 }, lastWeek: { reverted: 1, merged: 2 } });
    });

    it("counts a PR once however many ways it was reverted, and never a PR closed unmerged", () => {
      const rate = revertRateOf({
        pullRequests: [merged(1, "2026-10-20T00:00:00Z"), aMergedPullRequest("2026-10-20T00:00:00Z", { number: 3, mergedAt: null, mergeSha: null })],
        defaultBranchCommits: [{ message: `This reverts commit ${sha(1)}.`, at: "2026-11-04T00:00:00Z" }],
        mergedPullRequestTitles: [{ title: 'Revert "Build thing 1"', mergedAt: "2026-11-04T00:00:00Z" }],
      });
      expect(rate.thisWeek).toEqual({ reverted: 1, merged: 1 });
    });
  });

  describe("architectural escape rate", () => {
    // This week's 90-day window runs from 2026-08-10T13:00Z to the week's end,
    // 2026-11-08T13:00Z; last week's from 2026-08-03T13:00Z to 2026-11-01T13:00Z.
    const DAY = 24 * 60 * 60 * 1000;
    const daysBeforeTheWeekEnds = (days: number) => new Date(Date.parse("2026-11-08T13:00:00Z") - days * DAY).toISOString();
    const merged = (number: number, days: number) => aMergedPullRequest(daysBeforeTheWeekEnds(days), { number, ticket: number });
    const summaryOf = (...facts: Partial<GitHubFacts>[]) => {
      const result = weeklySummary(input({ records: [aRunRecord()], facts: facts.map(factsOf) }));
      if (result.kind !== "summary") throw new Error("expected a summary");
      return result.summary;
    };

    it("counts the agent PRs merged in the 90 days to the week's end that an escape names, out of every agent PR merged in them", () => {
      const summary = summaryOf({
        pullRequests: [merged(50, 89), merged(51, 91), merged(52, 10)],
        escapeMarkerIssues: [anEscapeMarkerIssue("Split the parser.\n\nFrom audit #70\n<!-- fabrik:escape strong #50 #51 -->")],
      });
      expect(summary.escapeRate.thisWeek).toEqual({ escaped: 1, merged: 2 });
    });

    it("counts a PR named in two escapes once", () => {
      const summary = summaryOf({
        pullRequests: [merged(50, 20), merged(51, 20), merged(52, 20)],
        escapeMarkerIssues: [
          anEscapeMarkerIssue("<!-- fabrik:escape strong #50 #51 -->", { number: 80 }),
          anEscapeMarkerIssue("<!-- fabrik:escape speculative #50 -->", { number: 81 }),
        ],
      });
      expect(summary.escapeRate.thisWeek).toEqual({ escaped: 2, merged: 3 });
    });

    it("counts each repo's escapes against its own PRs", () => {
      const summary = summaryOf(
        { pullRequests: [merged(50, 20), merged(51, 20)], escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->")] },
        { repo: "owner/other", pullRequests: [merged(50, 20)], escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #50 #51 -->")] },
      );
      expect(summary.escapeRate.thisWeek).toEqual({ escaped: 2, merged: 3 });
    });

    it("breaks the escapes opened in the 90 days down by Strength, one with an unknown Strength under none but still an escape", () => {
      const summary = summaryOf({
        pullRequests: [merged(50, 20), merged(51, 20), merged(52, 20), merged(53, 20), merged(54, 20)],
        escapeMarkerIssues: [
          anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->", { number: 80 }),
          anEscapeMarkerIssue("<!-- fabrik:escape strong #51 -->", { number: 81 }),
          anEscapeMarkerIssue("<!-- fabrik:escape worth-exploring #52 -->", { number: 82 }),
          anEscapeMarkerIssue("<!-- fabrik:escape critical #53 -->", { number: 83 }),
          anEscapeMarkerIssue("<!-- fabrik:escape #54 -->", { number: 84 }),
          anEscapeMarkerIssue("<!-- fabrik:escape speculative #50 -->", { number: 85, createdAt: daysBeforeTheWeekEnds(91) }), // before the window
        ],
      });
      expect(summary.escapesByStrength.thisWeek).toEqual({ strong: 2, "worth-exploring": 1, speculative: 0, none: 2 });
      expect(summary.escapeRate.thisWeek).toEqual({ escaped: 5, merged: 5 });
    });

    const NO_ESCAPES = { strong: 0, "worth-exploring": 0, speculative: 0, none: 0 };

    it.each([
      // The facts hold agent PRs alone, so a person's PR is never among them.
      ["a human PR", "<!-- fabrik:escape strong #60 -->"],
      ["an unmerged PR", "<!-- fabrik:escape strong #51 -->"],
      ["no PR", "<!-- fabrik:escape strong -->"],
    ])("counts no escape for a marker naming %s", (_, body) => {
      const summary = summaryOf({
        pullRequests: [merged(50, 20), aMergedPullRequest(daysBeforeTheWeekEnds(20), { number: 51, mergedAt: null, mergeSha: null })],
        escapeMarkerIssues: [anEscapeMarkerIssue(body)],
      });
      expect(summary.escapesByStrength.thisWeek).toEqual(NO_ESCAPES);
      expect(summary.escapeRate.thisWeek).toEqual({ escaped: 0, merged: 1 });
    });

    it("counts no escape for an issue someone other than the Operator opened", () => {
      const summary = summaryOf({
        pullRequests: [merged(50, 20)],
        escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->", { author: "someone" })],
      });
      expect(summary.escapesByStrength.thisWeek).toEqual(NO_ESCAPES);
      expect(summary.escapeRate.thisWeek).toEqual({ escaped: 0, merged: 1 });
    });

    it("counts an escape against only the PRs its marker still names, not one the Operator took out", () => {
      // The Audit traced it to #50 and #51; the Operator kept only #50 when filing it.
      const summary = summaryOf({
        pullRequests: [merged(50, 20), merged(51, 20)],
        escapeMarkerIssues: [anEscapeMarkerIssue("From audit #70\n<!-- fabrik:escape strong #50 -->")],
      });
      expect(summary.escapeRate.thisWeek).toEqual({ escaped: 1, merged: 2 });
    });

    it("computes last week's rate and breakdown the same way from the same inputs, as of last week's end", () => {
      const summary = summaryOf({
        // #50 is in last week's window alone, #52 and #53 in this week's alone.
        pullRequests: [merged(50, 95), merged(51, 30), merged(52, 3), merged(53, 4)],
        escapeMarkerIssues: [
          anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->", { number: 80, createdAt: daysBeforeTheWeekEnds(10) }),
          anEscapeMarkerIssue("<!-- fabrik:escape speculative #51 -->", { number: 81, createdAt: daysBeforeTheWeekEnds(2) }), // opened this week
        ],
      });
      expect(summary.escapeRate).toEqual({ thisWeek: { escaped: 1, merged: 3 }, lastWeek: { escaped: 1, merged: 2 } });
      expect(summary.escapesByStrength).toEqual({
        thisWeek: { ...NO_ESCAPES, speculative: 1 },
        lastWeek: { ...NO_ESCAPES, strong: 1 },
      });
    });

    it("still reads revert rate over its own 30 days", () => {
      const summary = summaryOf({
        pullRequests: [
          aMergedPullRequest(daysBeforeTheWeekEnds(60), { number: 50, mergeSha: "5".repeat(40) }),
          aMergedPullRequest(daysBeforeTheWeekEnds(20), { number: 51, mergeSha: "6".repeat(40) }),
        ],
        defaultBranchCommits: [{ message: `This reverts commit ${"5".repeat(40)}.`, at: daysBeforeTheWeekEnds(2) }],
      });
      expect(summary.revertRate.thisWeek).toEqual({ reverted: 0, merged: 1 });
      expect(summary.escapeRate.thisWeek).toEqual({ escaped: 0, merged: 2 });
    });

    describe("this week's escapes, with what let each PR through", () => {
      const transcript = (runId: number) => `transcripts/owner/product/2026-11/${runId}-1-review.jsonl.gz`;
      const review = (runId: number, endedAt: string, verdict: Verdict) =>
        aRunRecord({ runId, role: "review", endedAt, verdict, transcript: transcript(runId) });
      const escapesOf = (records: ReturnType<typeof aRunRecord>[], ...facts: Partial<GitHubFacts>[]) => {
        const result = weeklySummary(input({ records, facts: facts.map(factsOf) }));
        if (result.kind !== "summary") throw new Error("expected a summary");
        return result.summary.escapesThisWeek;
      };

      it("names each PR's Ticket, the Run records on it, its last passing Review record with the transcript, and the Operator's pushes", () => {
        const implement = aRunRecord({ runId: 1000, endedAt: "2026-11-02T00:00:00Z" });
        const firstPass = review(1001, "2026-11-02T06:00:00Z", "pass");
        const retry = aRunRecord({ runId: 1002, endedAt: "2026-11-02T12:00:00Z", retry: 1 });
        const lastPass = review(1003, "2026-11-02T18:00:00Z", "pass");
        const flaw = review(1004, "2026-11-02T20:00:00Z", "execution-flaw"); // after the Operator pushed; merged anyway
        const escapes = escapesOf(
          [
            lastPass,
            implement,
            flaw,
            firstPass,
            retry,
            aRunRecord({ runId: 1005, issue: 8, pullRequest: 51, role: "review", verdict: "pass", endedAt: "2026-11-02T21:00:00Z" }), // another PR's
            aRunRecord({ runId: 1006, repo: "owner/other", role: "review", verdict: "pass", endedAt: "2026-11-02T22:00:00Z" }), // another repo's #50
          ],
          {
            pullRequests: [
              aMergedPullRequest("2026-11-03T00:00:00Z", {
                number: 50,
                ticket: 7,
                commits: [aCommit("2026-11-02T00:00:00Z", { byApp: true }), aCommit("2026-11-02T19:00:00Z")],
              }),
            ],
            escapeMarkerIssues: [anEscapeMarkerIssue("From audit #70\n<!-- fabrik:escape strong #50 -->", { number: 80, createdAt: "2026-11-05T00:00:00Z" })],
          },
        );
        expect(escapes).toEqual([
          {
            repo: "owner/product",
            number: 80,
            url: "https://github.com/owner/product/issues/80",
            title: "Make the cart module deeper",
            body: "From audit #70\n<!-- fabrik:escape strong #50 -->",
            strength: "strong",
            pullRequests: [
              {
                number: 50,
                url: "https://github.com/owner/product/pull/50",
                ticket: 7,
                records: [implement, firstPass, retry, lastPass, flaw],
                lastPassingReview: {
                  record: lastPass,
                  transcript: transcript(1003),
                  url: "https://github.com/owner/product/actions/runs/1003/attempts/1",
                },
                operatorPushes: true,
              },
            ],
          },
        ]);
      });

      it("carries each escape's candidate, as the Operator filed it: its issue's title and body", () => {
        const body = "**Files:** `src/parser.ts`\n\n**Problem:** The parser leaks.\n\nFrom audit #70\n<!-- fabrik:escape strong #50 -->";
        const escapes = escapesOf([aRunRecord()], {
          pullRequests: [merged(50, 3)],
          escapeMarkerIssues: [anEscapeMarkerIssue(body, { title: "Split the parser", createdAt: daysBeforeTheWeekEnds(2) })],
        });
        expect(escapes).toMatchObject([{ number: 80, title: "Split the parser", body }]);
      });

      it("flags no Operator pushes on a PR only the Fabrik App pushed to, and names no Review when the store holds no passing one", () => {
        const escapes = escapesOf([review(1001, "2026-11-02T06:00:00Z", "design-flaw")], {
          pullRequests: [aMergedPullRequest("2026-11-03T00:00:00Z", { commits: [aCommit("2026-11-02T00:00:00Z", { byApp: true })] })],
          escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape speculative #50 -->")],
        });
        expect(escapes).toMatchObject([{ number: 80, pullRequests: [{ number: 50, lastPassingReview: null, operatorPushes: false }] }]);
      });

      it("holds only the escapes opened this week, each against only the PRs it counts against", () => {
        const escapes = escapesOf(
          [aRunRecord()],
          {
            pullRequests: [merged(50, 20), merged(51, 95)], // #51 merged before the 90 days
            escapeMarkerIssues: [
              anEscapeMarkerIssue("<!-- fabrik:escape strong #50 #51 #60 -->", { number: 80, createdAt: daysBeforeTheWeekEnds(3) }),
              anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->", { number: 81, createdAt: daysBeforeTheWeekEnds(8) }), // last week
              anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->", { number: 82, createdAt: daysBeforeTheWeekEnds(1), author: "someone" }),
            ],
          },
          { repo: "owner/other", pullRequests: [merged(50, 20)], escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape #50 -->", { number: 83 })] },
        );
        expect(escapes.map(({ repo, number, strength, pullRequests }) => [repo, number, strength, pullRequests.map((pr) => pr.number)])).toEqual([
          ["owner/product", 80, "strong", [50]],
          ["owner/other", 83, null, [50]],
        ]);
      });
    });

    describe("rendered", () => {
      const bodyOf = (facts: Partial<GitHubFacts>) => {
        const result = weeklySummary(input({ records: [aRunRecord()], facts: [factsOf(facts)] }));
        if (result.kind !== "summary") throw new Error("expected a summary");
        return result.body;
      };

      it("shows the rate this week and last week as n of m with its share, and the change in points", () => {
        const body = bodyOf({
          // Last week's window holds #51, #52 and #53.
          pullRequests: [merged(50, 3), merged(51, 20), merged(52, 30), merged(53, 40)],
          escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #51 -->", { createdAt: daysBeforeTheWeekEnds(2) })],
        });
        const rows = body.split("\n");
        expect(rows[rows.findIndex((row) => row.startsWith("| Revert rate")) + 1]).toBe(
          "| Architectural escape rate (90 days) | 1 of 4 (25%) | 0 of 3 (0%) | +25 pts |",
        );
      });

      it("says there were no merged agent PRs in a window with none, rather than 0%, and shows no change", () => {
        const body = bodyOf({ pullRequests: [merged(50, 3)], escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->")] });
        expect(body).toContain("| Architectural escape rate (90 days) | 1 of 1 (100%) | no merged agent PRs | – |");
      });

      it("breaks this week's escapes down by Strength under the table, an unknown Strength's apart", () => {
        const body = bodyOf({
          pullRequests: [merged(50, 3), merged(51, 3), merged(52, 3), merged(53, 3)],
          escapeMarkerIssues: [
            anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->", { number: 80 }),
            anEscapeMarkerIssue("<!-- fabrik:escape strong #51 -->", { number: 81 }),
            anEscapeMarkerIssue("<!-- fabrik:escape worth-exploring #52 -->", { number: 82 }),
            anEscapeMarkerIssue("<!-- fabrik:escape critical #53 -->", { number: 83 }),
          ],
        });
        expect(body).toContain(
          [
            "| Architectural escape rate (90 days) | 4 of 4 (100%) | no merged agent PRs | – |",
            "",
            "Architectural escapes by Strength (90 days): 2 Strong, 1 Worth exploring, 0 Speculative, 1 with no known Strength.",
            "",
          ].join("\n"),
        );
      });

      it("lists each repo's escapes opened this week after its Stuck work, with the PRs, the Review run that missed each and the Operator's pushes", () => {
        const result = weeklySummary(
          input({
            records: [aRunRecord({ runId: 1003, role: "review", verdict: "pass", endedAt: "2026-11-02T18:00:00Z" })],
            facts: [
              factsOf({
                pullRequests: [
                  aMergedPullRequest(daysBeforeTheWeekEnds(5), { number: 50, ticket: 7, commits: [aCommit(daysBeforeTheWeekEnds(6))] }),
                  aMergedPullRequest(daysBeforeTheWeekEnds(5), { number: 51, ticket: 8, commits: [aCommit(daysBeforeTheWeekEnds(6), { byApp: true })] }),
                ],
                openPullRequests: [anOpenPullRequest({ number: 52, title: "Build it", createdAt: daysBeforeTheWeekEnds(2) })],
                escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #50 #51 -->")],
              }),
              factsOf({ repo: "owner/other" }),
            ],
          }),
        );
        if (result.kind !== "summary") throw new Error("expected a summary");
        expect(result.body).toContain(
          [
            "- [#52](https://github.com/owner/product/pull/52) Build it: a draft with no activity for 2 days",
            "",
            "### Architectural escapes this week",
            "",
            "- [#80](https://github.com/owner/product/issues/80)",
            "  - [#50](https://github.com/owner/product/pull/50): missed by [Review run](https://github.com/owner/product/actions/runs/1003/attempts/1), with Operator pushes",
            "  - [#51](https://github.com/owner/product/pull/51): no passing Review run on record",
            "",
            "Live: ",
          ].join("\n"),
        );
        expect(result.body.match(/### Architectural escapes this week/g)).toHaveLength(1);
      });

      it("leaves the escapes list out of a repo with none opened this week", () => {
        const body = bodyOf({
          pullRequests: [merged(50, 20)],
          escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->", { createdAt: daysBeforeTheWeekEnds(10) })], // last week's
        });
        expect(body).toContain("Architectural escape rate");
        expect(body).not.toContain("Architectural escapes this week");
      });

      it("leaves the unknown Strength out of the breakdown when every escape has a known one", () => {
        const body = bodyOf({ pullRequests: [merged(50, 3)], escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape speculative #50 -->")] });
        expect(body).toContain("Architectural escapes by Strength (90 days): 0 Strong, 0 Worth exploring, 1 Speculative.\n");
      });
    });

    it("shows the open Audit beside the rate and the escapes list in the rendered summary", () => {
      const records = [aRunRecord({ role: "review", verdict: "pass", endedAt: "2026-11-02T18:00:00Z" })];
      const pullRequests = [aMergedPullRequest(daysBeforeTheWeekEnds(5), { commits: [aCommit(daysBeforeTheWeekEnds(6))] })];
      const result = weeklySummary(
        input({
          records,
          facts: [factsOf({ pullRequests, openAudits: [anOpenAudit()], escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->")] })],
        }),
      );
      if (result.kind !== "summary") throw new Error("expected a summary");
      expect(result.body).toContain("| Architectural escape rate (90 days) | 1 of 1 (100%) |");
      expect(result.body).toContain("Architectural escapes by Strength (90 days): 1 Strong, 0 Worth exploring, 0 Speculative.");
      expect(result.body).toContain("- [#90](https://github.com/owner/product/issues/90) Audit: week of 2026-10-26: Audit open for ");
      expect(result.body).toContain("### Architectural escapes this week\n\n- [#80](https://github.com/owner/product/issues/80)\n");
    });
  });

  it("counts an Audit run in the week's total cost, but in neither cost per merged PR nor cost per Spec", () => {
    const result = weeklySummary(
      input({
        records: [
          aRunRecord({ issue: 7, endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1 }),
          aRunRecord({ issue: 3, role: "design", pullRequest: null, endedAt: "2026-11-03T06:00:00Z", totalCostUsd: 0.5 }),
          anAuditRunRecord({ issue: 90, endedAt: "2026-11-04T00:00:00Z", totalCostUsd: 4 }),
        ],
        facts: [
          factsOf({
            pullRequests: [aMergedPullRequest("2026-11-05T00:00:00Z")],
            specs: [aSpec([aLabelAdded("ready-for-agent", "2026-11-05T00:00:00Z")], { number: 3 })],
          }),
        ],
      }),
    );
    expect(result).toMatchObject({
      kind: "summary",
      summary: {
        cost: { thisWeek: 5.5 },
        costPerMergedPullRequest: { thisWeek: { usd: 1 } },
        costPerSpec: { thisWeek: { usd: 0.5 } },
      },
    });
  });

  it("counts a Retro run in the week's total cost, but in neither cost per merged PR nor cost per Spec", () => {
    const result = weeklySummary(
      input({
        records: [
          aRunRecord({ issue: 7, endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1 }),
          aRunRecord({ issue: 3, role: "design", pullRequest: null, endedAt: "2026-11-03T06:00:00Z", totalCostUsd: 0.5 }),
          aRetroRunRecord({ issue: 120, endedAt: "2026-11-07T00:00:00Z", totalCostUsd: 2 }),
        ],
        facts: [
          factsOf({
            pullRequests: [aMergedPullRequest("2026-11-05T00:00:00Z")],
            specs: [aSpec([aLabelAdded("ready-for-agent", "2026-11-05T00:00:00Z")], { number: 3 })],
          }),
        ],
      }),
    );
    expect(result).toMatchObject({
      kind: "summary",
      summary: {
        cost: { thisWeek: 3.5 },
        costPerMergedPullRequest: { thisWeek: { usd: 1 } },
        costPerSpec: { thisWeek: { usd: 0.5 } },
      },
    });
  });

  describe("cost per merged PR", () => {
    it("averages, over the week's merged agent PRs, every Implement, Retry, Step-up and Review record on each Ticket", () => {
      const result = weeklySummary(
        input({
          records: [
            aRunRecord({ issue: 7, endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1 }),
            aRunRecord({ issue: 7, endedAt: "2026-11-04T00:00:00Z", totalCostUsd: 2, retry: 1 }),
            aRunRecord({ issue: 7, endedAt: "2026-11-04T06:00:00Z", totalCostUsd: 3, retry: 2, stepUp: true }),
            aRunRecord({ issue: 7, endedAt: "2026-11-04T12:00:00Z", totalCostUsd: 0.5, role: "review" }),
            aRunRecord({ issue: 8, endedAt: "2026-11-05T00:00:00Z", totalCostUsd: 1.5 }),
            aRunRecord({ issue: 9, endedAt: "2026-11-05T00:00:00Z", totalCostUsd: 100 }), // its PR isn't merged
            aRunRecord({ repo: "owner/other", issue: 8, endedAt: "2026-11-05T00:00:00Z", totalCostUsd: 100 }), // another repo's Ticket 8
          ],
          facts: [
            factsOf({
              pullRequests: [
                aMergedPullRequest("2026-11-05T00:00:00Z", { number: 50, ticket: 7 }),
                aMergedPullRequest("2026-11-06T00:00:00Z", { number: 51, ticket: 8 }),
              ],
            }),
          ],
        }),
      );
      // Ticket 7: $6.50, Ticket 8: $1.50.
      expect(result).toMatchObject({
        kind: "summary",
        summary: { costPerMergedPullRequest: { thisWeek: { usd: 4, unknownCost: 0 }, lastWeek: { usd: null, unknownCost: 0 } } },
      });
    });

    it("counts a run from an earlier week toward a PR merged this week", () => {
      const result = weeklySummary(
        input({
          records: [
            aRunRecord({ endedAt: "2026-10-27T00:00:00Z", totalCostUsd: 2 }), // last week
            aRunRecord({ endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1, role: "review" }),
          ],
          facts: [factsOf({ pullRequests: [aMergedPullRequest("2026-11-03T06:00:00Z")] })],
        }),
      );
      expect(result).toMatchObject({ kind: "summary", summary: { costPerMergedPullRequest: { thisWeek: { usd: 3 } } } });
    });

    it("never counts the Ticket's Triage or Design records", () => {
      const result = weeklySummary(
        input({
          records: [
            aRunRecord({ endedAt: "2026-10-27T00:00:00Z", totalCostUsd: 5, role: "triage", pullRequest: null }),
            aRunRecord({ endedAt: "2026-10-28T00:00:00Z", totalCostUsd: 5, role: "design", pullRequest: null }),
            aRunRecord({ endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1 }),
          ],
          facts: [factsOf({ pullRequests: [aMergedPullRequest("2026-11-03T06:00:00Z")] })],
        }),
      );
      expect(result).toMatchObject({ kind: "summary", summary: { costPerMergedPullRequest: { thisWeek: { usd: 1 } } } });
    });

    it("never counts the record of a judge run that scored a run on the Ticket", () => {
      const result = weeklySummary(
        input({
          records: [
            aRunRecord({ endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1 }),
            aRunRecord({ endedAt: "2026-11-03T00:05:00Z", totalCostUsd: 0.25, role: "score", baseSha: null }),
          ],
          facts: [factsOf({ pullRequests: [aMergedPullRequest("2026-11-03T06:00:00Z")] })],
        }),
      );
      expect(result).toMatchObject({ kind: "summary", summary: { cost: { thisWeek: 1.25 }, costPerMergedPullRequest: { thisWeek: { usd: 1 } } } });
    });

    it("leaves a run whose cost basis is unknown out of the sum, and counts it", () => {
      const result = weeklySummary(
        input({
          records: [
            aRunRecord({ endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1 }),
            aRunRecord({ endedAt: "2026-11-03T06:00:00Z", ...UNKNOWN_COST_BASIS, retry: 1 }),
          ],
          facts: [factsOf({ pullRequests: [aMergedPullRequest("2026-11-04T00:00:00Z")] })],
        }),
      );
      expect(result).toMatchObject({
        kind: "summary",
        summary: { costPerMergedPullRequest: { thisWeek: { usd: 1, unknownCost: 1 } } },
      });
    });
  });

  describe("cost per Spec", () => {
    it("averages, over the Specs that left design in the week, their Triage and Design records", () => {
      const result = weeklySummary(
        input({
          records: [
            aRunRecord({ issue: 3, role: "triage", pullRequest: null, endedAt: "2026-10-27T00:00:00Z", totalCostUsd: 0.5 }),
            aRunRecord({ issue: 3, role: "design", pullRequest: null, endedAt: "2026-10-28T00:00:00Z", totalCostUsd: 1 }),
            aRunRecord({ issue: 3, role: "design", pullRequest: null, endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1.5 }),
            aRunRecord({ issue: 4, role: "design", pullRequest: null, endedAt: "2026-11-04T00:00:00Z", totalCostUsd: 1 }),
            aRunRecord({ issue: 5, role: "design", pullRequest: null, endedAt: "2026-11-04T00:00:00Z", totalCostUsd: 100 }), // still in design
          ],
          facts: [
            factsOf({
              specs: [
                aSpec([aLabelAdded("ready-for-agent", "2026-11-03T06:00:00Z")], { number: 3, tickets: [] }),
                aSpec([aLabelAdded("ready-for-human", "2026-11-05T00:00:00Z")], { number: 4, tickets: [] }),
                aSpec([aLabelAdded("needs-design", "2026-11-03T00:00:00Z")], { number: 5, tickets: [] }),
              ],
            }),
          ],
        }),
      );
      // Spec 3: $3, Spec 4: $1.
      expect(result).toMatchObject({
        kind: "summary",
        summary: { costPerSpec: { thisWeek: { usd: 2, unknownCost: 0 }, lastWeek: { usd: null, unknownCost: 0 } } },
      });
    });

    it("counts Design turns on its Tickets sent back to design, but not their build runs", () => {
      const result = weeklySummary(
        input({
          records: [
            aRunRecord({ issue: 3, role: "design", pullRequest: null, endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1 }),
            aRunRecord({ issue: 7, role: "implement", endedAt: "2026-11-03T06:00:00Z", totalCostUsd: 10 }),
            aRunRecord({ issue: 7, role: "design", pullRequest: null, endedAt: "2026-11-04T00:00:00Z", totalCostUsd: 0.75 }),
          ],
          facts: [factsOf({ specs: [aSpec([aLabelAdded("ready-for-agent", "2026-11-05T00:00:00Z")], { number: 3, tickets: [7] })] })],
        }),
      );
      expect(result).toMatchObject({ kind: "summary", summary: { costPerSpec: { thisWeek: { usd: 1.75 } } } });
    });

    it("counts a prototype turn on the Spec or on a Ticket sent back to design as the Design-session turn it is", () => {
      const result = weeklySummary(
        input({
          records: [
            aRunRecord({ issue: 3, role: "design", pullRequest: null, endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1 }),
            aRunRecord({ issue: 3, role: "design", prototype: true, pullRequest: null, endedAt: "2026-11-03T06:00:00Z", totalCostUsd: 4 }),
            aRunRecord({ issue: 7, role: "design", prototype: true, pullRequest: null, endedAt: "2026-11-04T00:00:00Z", totalCostUsd: 2 }),
          ],
          facts: [factsOf({ specs: [aSpec([aLabelAdded("ready-for-agent", "2026-11-05T00:00:00Z")], { number: 3, tickets: [7] })] })],
        }),
      );
      expect(result).toMatchObject({ kind: "summary", summary: { cost: { thisWeek: 7 }, costPerSpec: { thisWeek: { usd: 7 } } } });
    });

    it("never counts the record of a judge run that scored a run on one of its Tickets", () => {
      const result = weeklySummary(
        input({
          records: [
            aRunRecord({ issue: 3, role: "design", pullRequest: null, endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1 }),
            aRunRecord({ issue: 7, role: "score", baseSha: null, endedAt: "2026-11-04T00:00:00Z", totalCostUsd: 0.25 }),
          ],
          facts: [factsOf({ specs: [aSpec([aLabelAdded("ready-for-agent", "2026-11-05T00:00:00Z")], { number: 3, tickets: [7] })] })],
        }),
      );
      expect(result).toMatchObject({ kind: "summary", summary: { cost: { thisWeek: 1.25 }, costPerSpec: { thisWeek: { usd: 1 } } } });
    });

    it("counts only a Spec the App moved out of design, not one the Operator labelled", () => {
      const result = weeklySummary(
        input({
          records: [aRunRecord({ issue: 3, role: "design", pullRequest: null, endedAt: "2026-11-03T00:00:00Z" })],
          facts: [
            factsOf({ specs: [aSpec([aLabelAdded("ready-for-agent", "2026-11-04T00:00:00Z", { actor: "operator" })], { number: 3 })] }),
          ],
        }),
      );
      expect(result).toMatchObject({ kind: "summary", summary: { costPerSpec: { thisWeek: { usd: null } } } });
    });

    it("counts only a Spec the Fabrik App moved out of design, not one another App labelled", () => {
      const result = weeklySummary(
        input({
          records: [aRunRecord({ issue: 3, role: "design", pullRequest: null, endedAt: "2026-11-03T00:00:00Z" })],
          facts: [
            factsOf({ specs: [aSpec([aLabelAdded("ready-for-agent", "2026-11-04T00:00:00Z", { actor: "other-app[bot]" })], { number: 3 })] }),
          ],
        }),
      );
      expect(result).toMatchObject({ kind: "summary", summary: { costPerSpec: { thisWeek: { usd: null } } } });
    });

    it("leaves a run whose cost basis is unknown out of the sum, and counts it", () => {
      const result = weeklySummary(
        input({
          records: [
            aRunRecord({ issue: 3, role: "triage", pullRequest: null, endedAt: "2026-11-03T00:00:00Z", ...UNKNOWN_COST_BASIS }),
            aRunRecord({ issue: 3, role: "design", pullRequest: null, endedAt: "2026-11-04T00:00:00Z", totalCostUsd: 2 }),
          ],
          facts: [factsOf({ specs: [aSpec([aLabelAdded("ready-for-agent", "2026-11-05T00:00:00Z")], { number: 3 })] })],
        }),
      );
      expect(result).toMatchObject({ kind: "summary", summary: { costPerSpec: { thisWeek: { usd: 2, unknownCost: 1 } } } });
    });
  });

  describe("spend that never merged", () => {
    it("sums the build runs on Tickets closed in the week without a merged PR", () => {
      const result = weeklySummary(
        input({
          records: [
            aRunRecord({ issue: 7, endedAt: "2026-10-28T00:00:00Z", totalCostUsd: 2 }), // last week, closed this week
            aRunRecord({ issue: 7, endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1, role: "review" }),
            aRunRecord({ issue: 7, endedAt: "2026-11-03T06:00:00Z", totalCostUsd: 5, role: "design", pullRequest: null }), // the Spec's
            aRunRecord({ issue: 8, endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 100 }), // closed by its merged PR
            aRunRecord({ issue: 9, endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 100 }), // still open
            aRunRecord({ issue: 10, endedAt: "2026-10-27T00:00:00Z", totalCostUsd: 0.5 }), // closed last week
          ],
          facts: [
            factsOf({
              pullRequests: [
                aMergedPullRequest("2026-11-04T00:00:00Z", { number: 50, ticket: 7, mergedAt: null }), // closed unmerged
                aMergedPullRequest("2026-11-04T00:00:00Z", { number: 51, ticket: 8 }),
              ],
              tickets: [
                aTicketTimeline([], { number: 7, closedAt: "2026-11-04T00:00:00Z" }),
                aTicketTimeline([], { number: 8, closedAt: "2026-11-04T00:00:00Z" }),
                aTicketTimeline([], { number: 9 }),
                aTicketTimeline([], { number: 10, closedAt: "2026-10-29T00:00:00Z" }),
              ],
            }),
          ],
        }),
      );
      expect(result).toMatchObject({
        kind: "summary",
        summary: { spendNeverMerged: { thisWeek: { usd: 3, unknownCost: 0 }, lastWeek: { usd: 0.5, unknownCost: 0 } } },
      });
    });

    it("leaves a run whose cost basis is unknown out of the sum, and counts it", () => {
      const result = weeklySummary(
        input({
          records: [
            aRunRecord({ endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1 }),
            aRunRecord({ endedAt: "2026-11-03T06:00:00Z", ...UNKNOWN_COST_BASIS }),
          ],
          facts: [factsOf({ tickets: [aTicketTimeline([], { closedAt: "2026-11-04T00:00:00Z" })] })],
        }),
      );
      expect(result).toMatchObject({ kind: "summary", summary: { spendNeverMerged: { thisWeek: { usd: 1, unknownCost: 1 } } } });
    });

    it("never counts the record of a judge run that scored a run on the Ticket", () => {
      const result = weeklySummary(
        input({
          records: [
            aRunRecord({ endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1 }),
            aRunRecord({ endedAt: "2026-11-03T00:05:00Z", totalCostUsd: 0.25, role: "score", baseSha: null }),
          ],
          facts: [factsOf({ tickets: [aTicketTimeline([], { closedAt: "2026-11-04T00:00:00Z" })] })],
        }),
      );
      expect(result).toMatchObject({ kind: "summary", summary: { cost: { thisWeek: 1.25 }, spendNeverMerged: { thisWeek: { usd: 1 } } } });
    });
  });

  describe("rendered", () => {
    const week = input({
      records: [
        aRunRecord({ endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1.5, retry: 1 }),
        aRunRecord({
          endedAt: "2026-11-05T00:00:00Z",
          ...UNKNOWN_COST_BASIS,
          stepUp: true,
          stepUpReason: "retry",
          // Friday 13 November 2026, 10:00 in Sydney.
          rateLimit: { status: "allowed", rateLimitType: "seven_day", utilization: 0.62, resetsAt: 1_794_524_400 },
        }),
        aRunRecord({ endedAt: "2026-10-28T00:00:00Z", totalCostUsd: 2.25 }),
      ],
      facts: [
        factsOf({
          pullRequests: [
            // Dispatched 24 hours before its merge, one Request changes, passed 6 hours before it.
            aMergedPullRequest("2026-11-04T00:00:00Z", {
              reviews: [aReview("2026-11-03T12:00:00Z")],
              comments: [aVerdictComment("pass", "a".repeat(40), "2026-11-03T18:00:00Z")],
            }),
            // Last week's: 24 hours, no touch, no passing Verdict, reverted this week.
            aMergedPullRequest("2026-10-29T00:00:00Z", { number: 49, ticket: 6, mergeSha: "9".repeat(40) }),
          ],
          tickets: [
            aTicketTimeline([aLabelAdded("agent:implement", "2026-11-03T00:00:00Z")]),
            aTicketTimeline([aLabelAdded("agent:implement", "2026-10-28T00:00:00Z")], { number: 6 }),
          ],
          defaultBranchCommits: [{ message: `This reverts commit ${"9".repeat(40)}.`, at: "2026-11-04T00:00:00Z" }],
        }),
      ],
    });
    const rendered = () => {
      const result = weeklySummary(week);
      if (result.kind !== "summary") throw new Error("expected a summary");
      return result;
    };

    it("is titled by the week's Monday", () => {
      expect(rendered().title).toBe("Weekly summary: week of 2026-11-02");
    });

    it("shows each figure this week and last week, with the change", () => {
      const { body } = rendered();
      expect(body).toContain("| API-equivalent cost | $1.50 | $2.25 | -$0.75 |");
      expect(body).toContain("| Merged agent PRs | 1 | 1 | 0 |");
      expect(body).toContain("| Tickets dispatched | 1 | 1 | 0 |");
      expect(body).toContain("| Human touches per merged PR | 1.0 | 0.0 | +1.0 |");
      expect(body).toContain("| Cycle time (median) | 24.0h | 24.0h | 0.0h |");
      expect(body).toContain("| Operator wait (median) | 6.0h | – | – |");
      expect(body).toContain("| Revert rate (30 days) | 50% (1 of 2) | 0% (0 of 1) | +50 pts |");
      expect(body).toContain("| Retries | 1 | 0 | +1 |");
      expect(body).toContain("| Step-ups | 1 | 0 | +1 |");
      expect(body).toContain("| · for a Retry | 1 | 0 | +1 |");
      expect(body).not.toContain("| · marked |");
    });

    it("says how many runs the cost leaves out and how close the Subscription came to its weekly limit", () => {
      const { body } = rendered();
      expect(body).toContain("1 run with an unknown cost basis is left out of the cost.");
      expect(body).toContain("Subscription usage: 62% of the weekly limit, resetting 2026-11-13 10:00 (Australia/Sydney).");
    });

    it("shows each cost figure this week and last week, with the change, and a dash where there's nothing to average", () => {
      const result = weeklySummary(
        input({
          records: [
            aRunRecord({ issue: 7, endedAt: "2026-10-28T00:00:00Z", totalCostUsd: 2 }),
            aRunRecord({ issue: 7, endedAt: "2026-11-03T00:00:00Z", ...UNKNOWN_COST_BASIS, retry: 1 }),
            aRunRecord({ issue: 8, endedAt: "2026-10-27T00:00:00Z", totalCostUsd: 1.5 }),
            aRunRecord({ issue: 9, endedAt: "2026-11-04T00:00:00Z", totalCostUsd: 0.25 }),
            aRunRecord({ issue: 3, role: "design", pullRequest: null, endedAt: "2026-10-26T00:00:00Z", ...UNKNOWN_COST_BASIS }),
            aRunRecord({ issue: 3, role: "design", pullRequest: null, endedAt: "2026-10-27T00:00:00Z", totalCostUsd: 1 }),
          ],
          facts: [
            factsOf({
              // Ticket 7 merged this week; Ticket 8 merged last week.
              pullRequests: [
                aMergedPullRequest("2026-11-05T00:00:00Z", { number: 50, ticket: 7 }),
                aMergedPullRequest("2026-10-29T00:00:00Z", { number: 51, ticket: 8 }),
              ],
              // Ticket 9 closed this week, unmerged.
              tickets: [aTicketTimeline([], { number: 9, closedAt: "2026-11-05T00:00:00Z" })],
              // Spec 3 left design last week.
              specs: [aSpec([aLabelAdded("ready-for-agent", "2026-10-28T00:00:00Z")], { number: 3 })],
            }),
          ],
        }),
      );
      if (result.kind !== "summary") throw new Error("expected a summary");
      expect(result.body).toContain("| Cost per merged PR | $2.00 | $1.50 | +$0.50 |");
      expect(result.body).toContain("| Cost per Spec | – | $1.00 | – |");
      expect(result.body).toContain("| Spend that never merged | $0.25 | $0.00 | +$0.25 |");
      expect(result.body).toContain("1 run with an unknown cost basis is left out of cost per merged PR.");
      expect(result.body).not.toContain("left out of cost per Spec");
      expect(result.body).not.toContain("left out of spend that never merged");
    });

    it("ends with exactly one mention of the Operator", () => {
      const { body } = rendered();
      expect(body.match(/@operator\b/g)).toHaveLength(1);
      expect(body.trimEnd().endsWith("@operator")).toBe(true);
    });

    it("has no section for a feature that hasn't shipped, not even an empty one", () => {
      const { body } = rendered();
      expect(body.match(/^#+ .*$/gm)).toEqual(["## Metrics", "## owner/product", "### Waiting on you"]);
      expect(body).not.toMatch(/Held|Retro|Map|Monitor/i);
    });

    it("shows the architectural escape rate and its Strengths in a week with no escapes, and no escapes list", () => {
      const { body } = rendered();
      expect(body).toContain("| Architectural escape rate (90 days) | 0 of 2 (0%) | 0 of 1 (0%) | 0 pts |");
      expect(body).toContain("Architectural escapes by Strength (90 days): 0 Strong, 0 Worth exploring, 0 Speculative.");
      expect(body).not.toMatch(/Audit|escapes this week/);
    });
  });

  describe("rendered per repo", () => {
    const HOUR = 60 * 60 * 1000;
    const hoursAgo = (hours: number) => new Date(Date.parse(NOW) - hours * HOUR).toISOString();
    const head = "h".repeat(40);
    const bodyOf = (...facts: ReturnType<typeof factsOf>[]) => {
      const result = weeklySummary(input({ records: [aRunRecord()], facts }));
      if (result.kind !== "summary") throw new Error("expected a summary");
      return result.body;
    };
    const readyForHuman = (number: number, hours: number) =>
      anOpenIssue({ number, title: `Operator work ${number}`, labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", hoursAgo(hours))] });

    it("escapes an item's title, so it can't mention anyone but the Operator or break its link", () => {
      const body = bodyOf(
        factsOf({ openIssues: [anOpenIssue({ number: 13, title: "Ask @someone about [x] and <b>", labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", hoursAgo(30))] })] }),
      );
      expect(body).toContain("- [#13](https://github.com/owner/product/issues/13) Ask @&#8203;someone about \\[x\\] and \\<b\\>: ready-for-human for 30 hours");
      expect(body.match(/@(?!&#8203;)\w/g)).toEqual(["@o"]);
    });

    it("says a Monitor issue in needs-info waits on the Operator's answer (#425)", () => {
      const body = bodyOf(
        factsOf({
          openIssues: [
            anOpenIssue({ number: 15, title: "TypeError in checkout", author: "fabrik-app[bot]", labels: ["needs-info"], labelEvents: [aLabelAdded("needs-info", hoursAgo(30))] }),
          ],
        }),
      );
      expect(body).toContain("- [#15](https://github.com/owner/product/issues/15) TypeError in checkout: Monitor issue's question unanswered for 30 hours");
    });

    it("gives each repo a section listing what waits on the Operator, with its age and any Operator wait", () => {
      const body = bodyOf(
        factsOf({
          openIssues: [
            anOpenIssue({ number: 12, title: "Design the thing", comments: [aDesignRound(2, hoursAgo(72))] }),
            readyForHuman(13, 30),
          ],
          openPullRequests: [anOpenPullRequest({ draft: false, comments: [aVerdictComment("pass", head, hoursAgo(5))] })],
        }),
        factsOf({ repo: "owner/other" }),
      );
      expect(body).toContain(
        [
          "## owner/product",
          "",
          "### Waiting on you",
          "",
          "- [#12](https://github.com/owner/product/issues/12) Design the thing: Design round unanswered for 3 days",
          "- [#13](https://github.com/owner/product/issues/13) Operator work 13: ready-for-human for 30 hours",
          "- [#50](https://github.com/owner/product/pull/50) Build the thing: at the Merge gate, Operator wait 5 hours",
          "",
        ].join("\n"),
      );
      expect(body).toContain(["## owner/other", "", "### Waiting on you", "", "Nothing waiting on you.", ""].join("\n"));
    });

    it("lists an open Audit with how long it has been open", () => {
      const facts = factsOf({ openIssues: [readyForHuman(13, 30)], openAudits: [anOpenAudit({ title: "Audit: week of 2026-11-02", createdAt: hoursAgo(50) })] });
      const summary = weeklySummary(input({ records: [aRunRecord()], facts: [facts] }));
      expect(summary).toMatchObject({
        body: expect.stringContaining(
          [
            "### Waiting on you",
            "",
            "- [#90](https://github.com/owner/product/issues/90) Audit: week of 2026-11-02: Audit open for 2 days",
            "- [#13](https://github.com/owner/product/issues/13) Operator work 13: ready-for-human for 30 hours",
            "",
          ].join("\n"),
        ),
      });
    });

    it("lists a Replay whose results are in with how long they have waited", () => {
      const facts = factsOf({ openIssues: [readyForHuman(13, 30)], openReplays: [anOpenReplay({ title: "Replay review.effort: high", lastEditedAt: hoursAgo(50) })] });
      expect(bodyOf(facts)).toContain(
        [
          "### Waiting on you",
          "",
          "- [#140](https://github.com/owner/product/issues/140) Replay review.effort: high: Replay results in for 2 days",
          "- [#13](https://github.com/owner/product/issues/13) Operator work 13: ready-for-human for 30 hours",
          "",
        ].join("\n"),
      );
    });

    it("lists an open Retro with how long it has been open", () => {
      const facts = factsOf({ openIssues: [readyForHuman(13, 30)], openRetros: [anOpenRetro({ title: "Retro: week of 2026-11-02", createdAt: hoursAgo(44) })] });
      const summary = weeklySummary(input({ records: [aRunRecord()], facts: [facts] }));
      expect(summary).toMatchObject({
        body: expect.stringContaining(
          [
            "### Waiting on you",
            "",
            "- [#120](https://github.com/owner/product/issues/120) Retro: week of 2026-11-02: Retro open for 44 hours",
            "- [#13](https://github.com/owner/product/issues/13) Operator work 13: ready-for-human for 30 hours",
            "",
          ].join("\n"),
        ),
      });
    });

    it("names no score beside the open Retro: a low score reaches the Operator only through the Retro's proposals", () => {
      const result = weeklySummary(
        input({
          records: [aRunRecord({ runId: 1, endedAt: hoursAgo(30) })],
          scoreFiles: [aScoreFile({ runId: 1, entries: [aScoreEntry({ score: 0.1, pass: false, label: "dead-end-loop", rationale: "Looped on one failing test." })] })],
          facts: [factsOf({ openIssues: [anOpenIssue({ number: 7, title: "Build the thing" })], openRetros: [anOpenRetro({ createdAt: hoursAgo(44) })] })],
        }),
      );
      if (result.kind !== "summary") throw new Error("expected a summary");
      expect(result.summary.repos).toMatchObject([{ waitingOnYou: [{ kind: "retro", number: 120 }], stuck: [] }]);
      expect(result.body).toContain(
        ["### Waiting on you", "", "- [#120](https://github.com/owner/product/issues/120) Retro: week of 2026-11-02: Retro open for 44 hours", ""].join("\n"),
      );
      expect(result.body).not.toMatch(/dead-end-loop|Looped|runs\/|scores\/|#7\b/);
    });

    describe("with Maps", () => {
      it("lists each open Map with how many of its Decisions wait on the Operator, and each failed research Decision, with their ages", () => {
        const body = bodyOf(
          factsOf({
            openIssues: [
              anOpenIssue({
                number: 30,
                title: "Let patients book group classes",
                labels: ["wayfinder:map"],
                labelEvents: [aLabelAdded("wayfinder:map", hoursAgo(100))],
                subIssues: [31, 32, 33],
              }),
              anOpenIssue({
                number: 31,
                title: "Which booking providers take group payments?",
                labels: ["wayfinder:research"],
                comments: [aComment(`${RESEARCH_RUN_FAILED_MARKER}\n@operator The Research run on #31 failed: it timed out.`, hoursAgo(30))],
              }),
              anOpenIssue({ number: 32, labels: ["wayfinder:grilling"] }),
              anOpenIssue({ number: 33, labels: ["wayfinder:prototype"] }),
              anOpenIssue({ number: 40, title: "Move intake online", labels: ["wayfinder:map"], createdAt: hoursAgo(20), subIssues: [41] }),
              anOpenIssue({ number: 41, labels: ["wayfinder:task"] }),
              anOpenIssue({ number: 50, title: "Pick a CRM", labels: ["wayfinder:map"], createdAt: hoursAgo(10) }),
            ],
            openMaps: [30, 40, 50],
          }),
        );
        expect(body).toContain(
          [
            "### Waiting on you",
            "",
            "- [#30](https://github.com/owner/product/issues/30) Let patients book group classes: Map open for 4 days, 2 Decisions waiting on you",
            "- [#31](https://github.com/owner/product/issues/31) Which booking providers take group payments?: research run failed 30 hours ago, waiting for you to re-add agent:research",
            "- [#40](https://github.com/owner/product/issues/40) Move intake online: Map open for 20 hours, 1 Decision waiting on you",
            "- [#50](https://github.com/owner/product/issues/50) Pick a CRM: Map open for 10 hours, no Decisions waiting on you",
            "",
          ].join("\n"),
        );
        expect(body.match(/@operator\b/g)).toHaveLength(1);
      });
    });

    it("collapses the 11th item onward in a repo into details", () => {
      const body = bodyOf(factsOf({ openIssues: Array.from({ length: 12 }, (_, i) => readyForHuman(100 + i, 100 - i)) }));
      const shown = body.slice(0, body.indexOf("<details>"));
      expect(shown).toContain("#109");
      expect(shown).not.toContain("#110");
      expect(body).toContain(
        [
          "<details><summary>2 more</summary>",
          "",
          "- [#110](https://github.com/owner/product/issues/110) Operator work 110: ready-for-human for 3 days",
          "- [#111](https://github.com/owner/product/issues/111) Operator work 111: ready-for-human for 3 days",
          "",
          "</details>",
        ].join("\n"),
      );
    });

    it("lists the repo's Stuck work, and leaves Stuck out when nothing is", () => {
      const stuckBody = bodyOf(
        factsOf({
          openIssues: [
            anOpenIssue({
              number: 20,
              title: "It crashes",
              labels: ["needs-info"],
              labelEvents: [aLabelAdded("needs-info", hoursAgo(50))],
              comments: [aComment("Version 2.", hoursAgo(26), { author: "someone", byBot: false })],
            }),
            anOpenIssue({ number: 7, title: "Build the other thing" }),
          ],
          openPullRequests: [anOpenPullRequest({ number: 51, title: "Build it", createdAt: hoursAgo(25) })],
        }),
      );
      expect(stuckBody).toContain(
        [
          "### Stuck",
          "",
          "- [#20](https://github.com/owner/product/issues/20) It crashes: needs-info answered 26 hours ago, not picked up",
          "- [#51](https://github.com/owner/product/pull/51) Build it: a draft with no activity for 25 hours",
          "",
        ].join("\n"),
      );
      const failedBody = weeklySummary(
        input({
          records: [aRunRecord({ endedAt: hoursAgo(49), jobResult: "cancelled", infrastructureFailure: "timeout" })],
          facts: [factsOf({ openIssues: [anOpenIssue({ number: 7, title: "Build the thing" })] })],
        }),
      );
      expect(failedBody).toMatchObject({
        body: expect.stringContaining("- [#7](https://github.com/owner/product/issues/7) Build the thing: last run ended in an Infrastructure failure (timeout) 2 days ago"),
      });
      const unreadBody = weeklySummary(
        input({
          records: [aRunRecord({ endedAt: hoursAgo(49), jobResult: "failure", infrastructureFailure: "unread-inputs" })],
          facts: [factsOf({ openIssues: [anOpenIssue({ number: 7, title: "Build the thing" })] })],
        }),
      );
      expect(unreadBody).toMatchObject({
        body: expect.stringContaining("Build the thing: last run ended in an Infrastructure failure (unread-inputs) 2 days ago"),
      });
      expect(bodyOf(factsOf())).not.toContain("Stuck");
    });

    it("links each repo's live searches for ready-for-human issues, open agent PRs and needs-design issues", () => {
      expect(bodyOf(factsOf())).toContain(
        "Live: [ready-for-human](https://github.com/owner/product/issues?q=is%3Aissue%20is%3Aopen%20label%3Aready-for-human)" +
          " · [open agent PRs](https://github.com/owner/product/pulls?q=is%3Apr%20is%3Aopen%20head%3Afabrik%2Fticket-)" +
          " · [needs-design](https://github.com/owner/product/issues?q=is%3Aissue%20is%3Aopen%20label%3Aneeds-design)",
      );
    });

    it("keeps the Operator's one mention last, after every repo", () => {
      const body = bodyOf(factsOf({ openIssues: [readyForHuman(13, 30)] }), factsOf({ repo: "owner/other" }));
      expect(body.match(/@operator\b/g)).toHaveLength(1);
      expect(body.trimEnd().endsWith("@operator")).toBe(true);
    });
  });

  describe("Held", () => {
    const HOUR = 60 * 60 * 1000;
    const hoursAgo = (hours: number) => new Date(Date.parse(NOW) - hours * HOUR).toISOString();
    const summaryOf = (...facts: GitHubFacts[]) => {
      const result = weeklySummary(input({ records: [aRunRecord()], facts }));
      if (result.kind !== "summary") throw new Error("expected a summary");
      return result;
    };

    it("counts a repo's needs-design issues waiting for a Design session slot, aged from when the oldest got needs-design", () => {
      const result = summaryOf(
        factsOf({
          designQueue: {
            issues: [
              aDesignQueueIssue({ number: 21, neededDesignAt: hoursAgo(30) }),
              aDesignQueueIssue({ number: 22, neededDesignAt: hoursAgo(80) }),
            ],
            designTurnsInProgress: [],
          },
        }),
      );
      expect(result.summary.repos[0]?.held).toEqual({ designSessions: { waiting: 2, oldestSince: hoursAgo(80), oldestAge: 80 * HOUR }, monitor: null, maps: null });
      expect(result.body).toContain(["## Held", "", "- owner/product: 2 needs-design issues waiting for a Design session slot, the oldest for 3 days", ""].join("\n"));
    });

    it("never counts an issue holding a slot: a round posted, a turn failed or in progress, or agent:design given", () => {
      const result = summaryOf(
        factsOf({
          designQueue: {
            issues: [
              aDesignQueueIssue({ number: 21, neededDesignAt: hoursAgo(200), designRounds: 1 }),
              aDesignQueueIssue({ number: 22, neededDesignAt: hoursAgo(190), turnFailed: true }),
              aDesignQueueIssue({ number: 23, neededDesignAt: hoursAgo(180) }),
              aDesignQueueIssue({ number: 24, neededDesignAt: hoursAgo(170), labels: ["needs-design", "agent:design"] }),
              aDesignQueueIssue({ number: 25, neededDesignAt: hoursAgo(5) }),
            ],
            designTurnsInProgress: [23],
          },
        }),
      );
      expect(result.summary.repos[0]?.held).toEqual({ designSessions: { waiting: 1, oldestSince: hoursAgo(5), oldestAge: 5 * HOUR }, monitor: null, maps: null });
      expect(result.body).toContain("- owner/product: 1 needs-design issue waiting for a Design session slot, for 5 hours");
    });

    it("leaves out a repo with nothing held", () => {
      const result = summaryOf(
        factsOf({ repo: "owner/quiet", designQueue: { issues: [aDesignQueueIssue({ designRounds: 2 })], designTurnsInProgress: [] } }),
        factsOf({ repo: "owner/busy", designQueue: { issues: [aDesignQueueIssue({ neededDesignAt: hoursAgo(30) })], designTurnsInProgress: [] } }),
      );
      expect(result.summary.repos.map(({ repo, held }) => [repo, held])).toEqual([
        ["owner/quiet", null],
        ["owner/busy", { designSessions: { waiting: 1, oldestSince: hoursAgo(30), oldestAge: 30 * HOUR }, monitor: null, maps: null }],
      ]);
      expect(result.body).toContain(["## Held", "", "- owner/busy: 1 needs-design issue waiting for a Design session slot, for 30 hours", ""].join("\n"));
      expect(result.body).not.toContain("- owner/quiet:");
    });

    it("has no Held section when no repo has anything held", () => {
      const { body } = summaryOf(
        factsOf({ designQueue: { issues: [aDesignQueueIssue({ designRounds: 1 })], designTurnsInProgress: [] } }),
        factsOf({ repo: "owner/other" }),
      );
      expect(body).not.toContain("Held");
    });

    it("sits between the Subscription usage and the first repo's section", () => {
      const { body } = summaryOf(factsOf({ designQueue: { issues: [aDesignQueueIssue()], designTurnsInProgress: [] } }));
      expect(body.match(/^#+ .*$/gm)).toEqual(["## Metrics", "## Held", "## owner/product", "### Waiting on you"]);
      expect(body.indexOf("Subscription usage")).toBeLessThan(body.indexOf("## Held"));
    });

    /** A Monitor error issue's body whose stats block ends with this held line, as the Monitor writes one. */
    const heldBody = (heldLine: string) => aMonitorIssueBody([...AGROUP_STATS, heldLine]);
    const HELD_3 = "- Held: 3 error groups waiting for a slot under the cap of 5 open error issues";

    it("counts the error groups the Monitor holds from the held line in its newest open error issue's stats block, linking that issue", () => {
      const result = summaryOf(factsOf({ monitorIssues: [anOpenMonitorIssue({ number: 41, body: heldBody(HELD_3) })] }));
      expect(result.summary.repos[0]?.held).toEqual({ designSessions: null, monitor: { groups: 3, issue: 41 }, maps: null });
      expect(result.body).toContain(
        ["## Held", "", "- owner/product: 3 error groups waiting for a Monitor issue slot, counted in [#41](https://github.com/owner/product/issues/41)", ""].join("\n"),
      );
    });

    it.each([
      ["whose newest open error issue's stats block has no held line", [anOpenMonitorIssue()]],
      ["with no open Monitor issue", []],
    ])("gives a repo %s no Monitor line", (_, monitorIssues) => {
      const result = summaryOf(
        factsOf({ repo: "owner/quiet", monitorIssues }),
        factsOf({ repo: "owner/busy", monitorIssues: [anOpenMonitorIssue({ body: heldBody(HELD_3) })] }),
      );
      expect(result.summary.repos.map(({ repo, held }) => [repo, held])).toEqual([
        ["owner/quiet", null],
        ["owner/busy", { designSessions: null, monitor: { groups: 3, issue: 41 }, maps: null }],
      ]);
      expect(result.body).not.toContain("- owner/quiet:");
    });

    it("ignores a held line in an issue the Fabrik App didn't file, however new, so quoting one fakes nothing", () => {
      const quoted = anOpenMonitorIssue({ number: 50, author: "someone", body: heldBody("- Held: 9 error groups waiting for a slot under the cap of 5 open error issues") });
      expect(summaryOf(factsOf({ monitorIssues: [quoted] })).summary.repos[0]?.held).toBeNull();
      expect(summaryOf(factsOf({ monitorIssues: [anOpenMonitorIssue({ number: 41, body: heldBody(HELD_3) }), quoted] })).summary.repos[0]?.held).toEqual({
        designSessions: null,
        monitor: { groups: 3, issue: 41 },
        maps: null,
      });
    });

    it("reads only the newest open error issue, so an older one's stale held line counts for nothing", () => {
      const result = summaryOf(
        factsOf({
          monitorIssues: [
            anOpenMonitorIssue({ number: 45, body: heldBody("- Held: 2 error groups waiting for a slot under the cap of 5 open error issues") }),
            anOpenMonitorIssue({ number: 41, body: heldBody(HELD_3) }),
          ],
        }),
      );
      expect(result.summary.repos[0]?.held).toEqual({ designSessions: null, monitor: { groups: 2, issue: 45 }, maps: null });
      expect(summaryOf(factsOf({ monitorIssues: [anOpenMonitorIssue({ number: 41, body: heldBody(HELD_3) }), anOpenMonitorIssue({ number: 45 })] })).summary.repos[0]?.held).toBeNull();
    });

    it("passes over an open issue with no stats block, such as a Spec that kept its marker, as the Monitor does", () => {
      const spec = anOpenMonitorIssue({ number: 60, body: "<!-- fabrik:monitor sentry:4504 -->\n## Problem Statement\n\nBookings fail." });
      const result = summaryOf(factsOf({ monitorIssues: [anOpenMonitorIssue({ number: 41, body: heldBody(HELD_3) }), spec] }));
      expect(result.summary.repos[0]?.held).toEqual({ designSessions: null, monitor: { groups: 3, issue: 41 }, maps: null });
    });

    it("never reads red main's issue, which takes no slot under the cap", () => {
      const redMain = anOpenMonitorIssue({ number: 60, body: heldBody(HELD_3).replace("<!-- fabrik:monitor sentry:4504 -->", "<!-- fabrik:monitor red-main -->") });
      expect(summaryOf(factsOf({ monitorIssues: [anOpenMonitorIssue({ number: 41 }), redMain] })).summary.repos[0]?.held).toBeNull();
    });

    it("says 1 error group for one held", () => {
      const { body } = summaryOf(
        factsOf({ monitorIssues: [anOpenMonitorIssue({ body: heldBody("- Held: 1 error group waiting for a slot under the cap of 5 open error issues") })] }),
      );
      expect(body).toContain("- owner/product: 1 error group waiting for a Monitor issue slot, counted in [#41](https://github.com/owner/product/issues/41)");
    });

    it("gives a repo holding both Design work and error groups a line for each", () => {
      const { body } = summaryOf(
        factsOf({
          designQueue: { issues: [aDesignQueueIssue({ neededDesignAt: hoursAgo(30) })], designTurnsInProgress: [] },
          monitorIssues: [anOpenMonitorIssue({ body: heldBody(HELD_3) })],
        }),
      );
      expect(body).toContain(
        [
          "## Held",
          "",
          "- owner/product: 1 needs-design issue waiting for a Design session slot, for 30 hours",
          "- owner/product: 3 error groups waiting for a Monitor issue slot, counted in [#41](https://github.com/owner/product/issues/41)",
          "",
        ].join("\n"),
      );
    });

    it.each([
      ["Design work", factsOf({ designQueue: { issues: [aDesignQueueIssue()], designTurnsInProgress: [] } })],
      ["error groups", factsOf({ monitorIssues: [anOpenMonitorIssue({ body: heldBody(HELD_3) })] })],
      ["a full Map cap", factsOf({ openMaps: [30] })],
    ])("keeps a week with no records but held %s from being skipped", (_, facts) => {
      const result = weeklySummary(input({ facts: [facts] }));
      expect(result.kind).toBe("summary");
    });

    describe("the Map cap", () => {
      const summaryOf = (...facts: GitHubFacts[]) => {
        const result = weeklySummary(input({ records: [aRunRecord()], facts }));
        if (result.kind !== "summary") throw new Error("expected a summary");
        return result;
      };

      it("names the open Map when open Maps fill caps.maps, so the Operator knows why no Map was offered", () => {
        const result = summaryOf(factsOf({ openMaps: [30] }));
        expect(result.summary.repos[0]?.held).toEqual({ designSessions: null, monitor: null, maps: { open: [30] } });
        expect(result.body).toContain(
          ["## Held", "", "- owner/product: the Map cap is full with [#30](https://github.com/owner/product/issues/30) open, so Design sessions offer no new Map", ""].join(
            "\n",
          ),
        );
      });

      it("names every open Map, lowest number first, one charted by hand beyond the cap among them", () => {
        const result = summaryOf(factsOf({ openMaps: [40, 30] }));
        expect(result.summary.repos[0]?.held).toEqual({ designSessions: null, monitor: null, maps: { open: [30, 40] } });
        expect(result.body).toContain(
          "- owner/product: the Map cap is full with [#30](https://github.com/owner/product/issues/30) and [#40](https://github.com/owner/product/issues/40) open, so Design sessions offer no new Map",
        );
      });

      it("gives a repo whose Map cap has room no Maps line", () => {
        const result = summaryOf(
          factsOf({ repo: "owner/quiet", openIssues: [anOpenIssue({ number: 31, labels: ["wayfinder:grilling"] })] }),
          factsOf({ repo: "owner/busy", openMaps: [30] }),
        );
        expect(result.summary.repos.map(({ repo, held }) => [repo, held])).toEqual([
          ["owner/quiet", null],
          ["owner/busy", { designSessions: null, monitor: null, maps: { open: [30] } }],
        ]);
        expect(result.body).not.toContain("- owner/quiet:");
      });
    });
  });

  describe("Scores", () => {
    it("gives each rubric its runs scored, median score and share passing, from the score files of the week's runs", () => {
      const result = weeklySummary(
        input({
          records: [
            aRunRecord({ runId: 1, endedAt: "2026-11-03T00:00:00Z" }),
            aRunRecord({ runId: 2, endedAt: "2026-11-04T00:00:00Z" }),
            aRunRecord({ runId: 3, endedAt: "2026-11-05T00:00:00Z" }),
          ],
          scoreFiles: [
            aScoreFile({ runId: 1, entries: [aScoreEntry({ score: 0.9 })] }),
            aScoreFile({ runId: 2, entries: [aScoreEntry({ score: 0.6, pass: false })] }),
            aScoreFile({ runId: 3, entries: [aScoreEntry({ score: 0.75 })] }),
          ],
        }),
      );
      expect(result).toMatchObject({
        kind: "summary",
        summary: { scores: { thisWeek: { rubrics: [{ scorer: "efficiency", version: 1, runsScored: 3, medianScore: 0.75, passing: 2 / 3 }] } } },
      });
    });

    it("keeps each rubric version apart, so scores from different versions never mix, listing them in the Kit's order", () => {
      const result = weeklySummary(
        input({
          records: [aRunRecord({ runId: 1 }), aRunRecord({ runId: 2 })],
          scoreFiles: [
            aScoreFile({
              runId: 1,
              entries: [
                aScoreEntry({ scorer: "skill-use", score: 0.5, pass: false }),
                aScoreEntry({ scorer: "efficiency", version: 2, score: 0.9 }),
              ],
            }),
            aScoreFile({
              runId: 2,
              entries: [aScoreEntry({ scorer: "efficiency", score: 0.4, pass: false }), aScoreEntry({ scorer: "ticket-compliance", score: 1 })],
            }),
          ],
        }),
      );
      if (result.kind !== "summary") throw new Error("expected a summary");
      expect(result.summary.scores.thisWeek.rubrics).toEqual([
        { scorer: "efficiency", version: 1, runsScored: 1, medianScore: 0.4, passing: 0 },
        { scorer: "efficiency", version: 2, runsScored: 1, medianScore: 0.9, passing: 1 },
        { scorer: "ticket-compliance", version: 1, runsScored: 1, medianScore: 1, passing: 1 },
        { scorer: "skill-use", version: 1, runsScored: 1, medianScore: 0.5, passing: 0 },
      ]);
    });

    it("counts the runs picked for scoring that were skipped, by reason", () => {
      const nearLimit = { status: "allowed", rateLimitType: "seven_day", utilization: 0.8, resetsAt: 1_794_000_000 };
      const result = weeklySummary(
        input({
          records: [1, 2, 3, 4].map((runId) => aRunRecord({ runId })).concat(aRunRecord({ runId: 5, endedAt: "2026-10-28T00:00:00Z" })),
          scoreFiles: [
            aSkippedScoreFile({ reason: "weekly-limit", rateLimit: nearLimit }, { runId: 1 }),
            aSkippedScoreFile({ reason: "weekly-limit", rateLimit: nearLimit }, { runId: 2 }),
            aSkippedScoreFile({ reason: "judge-output-invalid" }, { runId: 3 }),
            aScoreFile({ runId: 4 }),
            aSkippedScoreFile({ reason: "no-transcript" }, { runId: 5 }), // last week's
          ],
        }),
      );
      if (result.kind !== "summary") throw new Error("expected a summary");
      expect(result.summary.scores.thisWeek.skips).toEqual({
        "weekly-limit": 2,
        "no-transcript": 0,
        "infrastructure-failure": 0,
        "judge-failed": 0,
        "judge-output-invalid": 1,
      });
      expect(result.summary.scores.lastWeek.skips).toMatchObject({ "no-transcript": 1, "weekly-limit": 0 });
    });

    it("gives scoring's cost, the judge runs' summed cost, as a share of the week's, leaving out and counting a judge run of unknown cost", () => {
      const result = weeklySummary(
        input({
          records: [
            aRunRecord({ totalCostUsd: 9.5 }),
            aRunRecord({ role: "score", baseSha: null, totalCostUsd: 0.25 }),
            aRunRecord({ role: "score", baseSha: null, totalCostUsd: 0.25 }),
            aRunRecord({ role: "score", baseSha: null, ...UNKNOWN_COST_BASIS }),
            aRunRecord({ role: "score", baseSha: null, endedAt: "2026-10-28T00:00:00Z", totalCostUsd: 0.4 }), // last week's
          ],
          scoreFiles: [aScoreFile()],
        }),
      );
      expect(result).toMatchObject({
        kind: "summary",
        summary: {
          cost: { thisWeek: 10, lastWeek: 0.4 },
          scoringCost: { thisWeek: { usd: 0.5, share: 0.05, unknownCost: 1 }, lastWeek: { usd: 0.4, share: 1, unknownCost: 0 } },
        },
      });
    });

    it("gives scoring no share of the cost in a week that cost nothing", () => {
      const result = weeklySummary(input({ records: [aRunRecord({ totalCostUsd: 0 })], scoreFiles: [aScoreFile()] }));
      expect(result).toMatchObject({ kind: "summary", summary: { scoringCost: { thisWeek: { usd: 0, share: null }, lastWeek: { usd: 0, share: null } } } });
    });

    describe("rendered", () => {
      const judgeRun = (overrides: Parameters<typeof aRunRecord>[0]) => aRunRecord({ role: "score", baseSha: null, ...overrides });
      const scoredWeek = input({
        records: [
          aRunRecord({ runId: 1, endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 9.5 }),
          ...[2, 4, 5, 6].map((runId) => aRunRecord({ runId, endedAt: "2026-11-04T00:00:00Z", totalCostUsd: 0 })),
          judgeRun({ runId: 1, endedAt: "2026-11-03T00:05:00Z", totalCostUsd: 0.25 }),
          judgeRun({ runId: 2, endedAt: "2026-11-04T00:05:00Z", totalCostUsd: 0.25 }),
          judgeRun({ runId: 5, endedAt: "2026-11-04T00:05:00Z", ...UNKNOWN_COST_BASIS }),
          aRunRecord({ runId: 3, endedAt: "2026-10-28T00:00:00Z", totalCostUsd: 2.25 }),
          judgeRun({ runId: 3, endedAt: "2026-10-28T00:05:00Z", totalCostUsd: 0.25 }),
        ],
        scoreFiles: [
          aScoreFile({
            runId: 1,
            entries: [aScoreEntry({ score: 0.9 }), aScoreEntry({ scorer: "ticket-compliance", threshold: 0.8, score: 0.6, pass: false })],
          }),
          aScoreFile({
            runId: 2,
            entries: [aScoreEntry({ score: 0.6, pass: false }), aScoreEntry({ scorer: "ticket-compliance", threshold: 0.8, score: 0.8 })],
          }),
          aSkippedScoreFile({ reason: "weekly-limit", rateLimit: { status: "rejected", rateLimitType: "seven_day", utilization: 1, resetsAt: null } }, { runId: 4 }),
          aSkippedScoreFile({ reason: "judge-failed" }, { runId: 5 }),
          aSkippedScoreFile({ reason: "no-transcript" }, { runId: 6 }),
          aScoreFile({ runId: 3, entries: [aScoreEntry({ score: 0.5, pass: false })] }),
        ],
      });
      const bodyOf = (week: WeeklySummaryInput) => {
        const result = weeklySummary(week);
        if (result.kind !== "summary") throw new Error("expected a summary");
        return result.body;
      };

      it("shows each rubric version's runs scored, median score and share passing, this week and last week, with the change", () => {
        expect(bodyOf(scoredWeek)).toContain(
          [
            "## Scores",
            "",
            "| | This week | Last week | Change |",
            "| --- | ---: | ---: | ---: |",
            "| Efficiency v1: runs scored | 2 | 1 | +1 |",
            "| Efficiency v1: median score | 0.75 | 0.50 | +0.25 |",
            "| Efficiency v1: passing | 50% | 0% | +50 pts |",
            "| Ticket compliance v1: runs scored | 2 | 0 | +2 |",
            "| Ticket compliance v1: median score | 0.70 | – | – |",
            "| Ticket compliance v1: passing | 50% | – | – |",
          ].join("\n"),
        );
      });

      it("shows what scoring cost and its share of the cost, this week and last week, and how many judge runs it leaves out", () => {
        const body = bodyOf(scoredWeek);
        // This week $0.50 of $10.00, last week $0.25 of $2.50.
        expect(body).toContain(["| Scoring cost | $0.50 | $0.25 | +$0.25 |", "| Scoring's share of the cost | 5% | 10% | -5 pts |", ""].join("\n"));
        expect(body).toContain("1 run with an unknown cost basis is left out of the scoring cost.");
        expect(body).toContain("| API-equivalent cost | $10.00 | $2.50 | +$7.50 |");
      });

      it("says how many runs picked for scoring were skipped this week, and why, and says nothing of skips in a week with none", () => {
        expect(bodyOf(scoredWeek)).toContain("3 runs picked for scoring were skipped: 1 weekly-limit, 1 no-transcript, 1 judge-failed.");
        const oneSkip = bodyOf(input({ records: [aRunRecord()], scoreFiles: [aSkippedScoreFile({ reason: "infrastructure-failure" })] }));
        expect(oneSkip).toContain("1 run picked for scoring was skipped: 1 infrastructure-failure.");
        expect(bodyOf(input({ records: [aRunRecord()], scoreFiles: [aScoreFile()] }))).not.toContain("skipped");
      });

      it("sits after the Subscription usage, before Held and the first repo's section", () => {
        const body = bodyOf({ ...scoredWeek, facts: [factsOf({ designQueue: { issues: [aDesignQueueIssue()], designTurnsInProgress: [] } })] });
        expect(body.match(/^#+ .*$/gm)).toEqual(["## Metrics", "## Scores", "## Held", "## owner/product", "### Waiting on you"]);
        expect(body.indexOf("Subscription usage")).toBeLessThan(body.indexOf("## Scores"));
      });

      it("is left out of a week with no score files, even one with judge runs or with score files last week", () => {
        const body = bodyOf(
          input({
            records: [aRunRecord(), judgeRun({ totalCostUsd: 0.25 }), aRunRecord({ runId: 3, endedAt: "2026-10-28T00:00:00Z" })],
            scoreFiles: [aScoreFile({ runId: 3 })],
          }),
        );
        expect(body).not.toMatch(/Scor/);
      });

      it("never shows a run's own scores, and never puts a low score or a skip in Waiting on you or Stuck", () => {
        const HOUR = 60 * 60 * 1000;
        const longAgo = new Date(Date.parse(NOW) - 30 * HOUR).toISOString();
        const result = weeklySummary(
          input({
            records: [aRunRecord({ runId: 1, endedAt: longAgo }), aRunRecord({ runId: 2, endedAt: longAgo })],
            scoreFiles: [
              aScoreFile({ runId: 1, entries: [aScoreEntry({ score: 0.1, pass: false, label: "dead-end-loop", rationale: "Looped on one failing test." })] }),
              aSkippedScoreFile({ reason: "judge-output-invalid" }, { runId: 2 }),
            ],
            facts: [factsOf({ openIssues: [anOpenIssue({ number: 7, title: "Build the thing" })] })],
          }),
        );
        if (result.kind !== "summary") throw new Error("expected a summary");
        expect(result.summary.repos).toMatchObject([{ waitingOnYou: [], stuck: [] }]);
        expect(result.body).not.toMatch(/dead-end-loop|Looped|runs\/|scores\/|#7\b|\b[12]-1-implement\b/);
      });
    });

    it("places a score file in the week its scored run ended, even when scoring ended after the week turned", () => {
      const result = weeklySummary(
        input({
          records: [
            aRunRecord({ runId: 1, endedAt: "2026-11-01T12:58:00Z" }), // Sunday 23:58 in Sydney: last week
            aRunRecord({ runId: 1, role: "score", baseSha: null, endedAt: "2026-11-01T13:03:00Z" }), // its judge run, this week
          ],
          scoreFiles: [aScoreFile({ runId: 1, scoredAt: "2026-11-01T13:04:00Z", entries: [aScoreEntry()] })],
        }),
      );
      expect(result).toMatchObject({
        kind: "summary",
        summary: { scores: { thisWeek: { rubrics: [] }, lastWeek: { rubrics: [{ scorer: "efficiency", runsScored: 1 }] } } },
      });
    });

    it("keeps a week with only score files from being skipped, placing one whose record isn't in the store by when it was scored", () => {
      const result = weeklySummary(input({ scoreFiles: [aScoreFile({ scoredAt: "2026-11-04T12:05:00Z", entries: [aScoreEntry()] })] }));
      expect(result).toMatchObject({ kind: "summary", summary: { scores: { thisWeek: { rubrics: [{ scorer: "efficiency", runsScored: 1 }] } } } });
    });
  });

  describe("Replay runs", () => {
    const summaryOf = (week: WeeklySummaryInput) => {
      const result = weeklySummary(week);
      if (result.kind !== "summary") throw new Error("expected a summary");
      return result;
    };

    const weeklyReading = (utilization: number) => ({ status: "allowed", rateLimitType: "seven_day", utilization, resetsAt: null }) as const;
    const judgeRun = (overrides: Partial<RunRecord>) => aRunRecord({ role: "score", baseSha: null, ...overrides });
    const variant = { ...A_REPLAY, arm: "variant" } as const;
    // A live week: Ticket 7 built, scored, reviewed and merged as PR 50, which an escape opened this week names.
    const live = input({
      records: [
        aRunRecord({ runId: 1000, endedAt: "2026-11-02T00:00:00Z", totalCostUsd: 1, rateLimit: weeklyReading(0.4) }),
        judgeRun({ runId: 1000, endedAt: "2026-11-02T00:05:00Z", totalCostUsd: 0.25 }),
        aRunRecord({ runId: 1001, role: "review", verdict: "pass", endedAt: "2026-11-02T06:00:00Z", totalCostUsd: 0.5, transcript: "transcripts/1001-1-review.jsonl.gz" }),
      ],
      scoreFiles: [aScoreFile({ runId: 1000 })],
      facts: [
        factsOf({
          pullRequests: [aMergedPullRequest("2026-11-03T00:00:00Z")],
          tickets: [aTicketTimeline([aLabelAdded("agent:implement", "2026-11-01T20:00:00Z")], { closedAt: "2026-11-03T00:00:00Z" })],
          escapeMarkerIssues: [anEscapeMarkerIssue("From audit #70\n<!-- fabrik:escape strong #50 -->", { createdAt: "2026-11-05T00:00:00Z" })],
        }),
      ],
    });
    // Replay 140 re-running Ticket 7 later in the week, on another Subscription:
    // each arm's Implement and Review, the judge's runs scoring them, and their score files.
    const replayRecords = [
      aReplayRunRecord({ endedAt: "2026-11-06T00:00:00Z", totalCostUsd: 2, subscription: "Claude token 2", rateLimit: weeklyReading(0.9) }),
      judgeRun({ runId: 2000, replay: A_REPLAY, subscription: "Claude token 2", endedAt: "2026-11-06T00:05:00Z", totalCostUsd: 0.5 }),
      aReplayRunRecord({ replay: variant, subscription: "Claude token 2", endedAt: "2026-11-06T00:30:00Z", ...UNKNOWN_COST_BASIS }),
      aReplayRunRecord({
        role: "review",
        verdict: "pass",
        subscription: "Claude token 2",
        endedAt: "2026-11-06T01:00:00Z",
        totalCostUsd: 0.75,
        transcript: "transcripts/2000-1-review-replay-baseline.jsonl.gz",
      }),
      aReplayRunRecord({ replay: variant, role: "review", verdict: "execution-flaw", subscription: "Claude token 2", endedAt: "2026-11-06T02:00:00Z" }),
    ];
    const replayScoreFiles = [
      aScoreFile({ runId: 2000, replay: A_REPLAY, entries: [aScoreEntry({ score: 0.1, pass: false })] }),
      aSkippedScoreFile({ reason: "judge-failed" }, { runId: 2000, replay: variant }),
    ];
    const withReplays = { ...live, records: [...live.records, ...replayRecords], scoreFiles: [...live.scoreFiles, ...replayScoreFiles] };

    it("leaves them out of every figure, count and cost, so a week with them reads as the same week without them but for its replay spend", () => {
      const { summary, body } = summaryOf(withReplays);
      const without = summaryOf(live);
      expect({ ...summary, replaySpend: without.summary.replaySpend }).toEqual(without.summary);
      const replayLines = /^(\| Replay spend \|.*|.* left out of replay spend\.\n)\n/gm;
      expect(body.replace(replayLines, "")).toBe(without.body);
    });

    it("shows what the week's replays cost, their Implement, Review and judge runs summed, on its own line under the cost", () => {
      const lastWeeks = aReplayRunRecord({ runId: 1900, endedAt: "2026-10-28T00:00:00Z", totalCostUsd: 1.25 });
      const { summary, body } = summaryOf({ ...withReplays, records: [...withReplays.records, lastWeeks] });
      expect(summary.replaySpend).toEqual({ thisWeek: { usd: 4.25, unknownCost: 1 }, lastWeek: { usd: 1.25, unknownCost: 0 } });
      expect(body).toContain("| API-equivalent cost | $1.75 | $0.00 | +$1.75 |\n| Replay spend | $4.25 | $1.25 | +$3.00 |\n");
    });

    it("says how many replay runs the replay spend leaves out, their cost basis being unknown, and none the cost leaves out", () => {
      const { body } = summaryOf(withReplays);
      expect(body).toContain("1 run with an unknown cost basis is left out of replay spend.");
      expect(body).not.toContain("left out of the cost.");
    });

    it("keeps a week whose only runs were replays from being skipped, so what they cost is still shown", () => {
      const { summary, body } = summaryOf(input({ records: [aReplayRunRecord({ totalCostUsd: 3 })] }));
      expect(summary.cost.thisWeek).toBe(0);
      expect(body).toContain("| Replay spend | $3.00 | – | – |");
    });

    it("has no replay spend line in a week with no replay records, showing a dash for a last week with none", () => {
      const { summary, body } = summaryOf(live);
      expect(summary.replaySpend).toEqual({ thisWeek: null, lastWeek: null });
      expect(body).not.toContain("Replay spend");
      const lastWeeks = aReplayRunRecord({ endedAt: "2026-10-28T00:00:00Z", totalCostUsd: 1.25 });
      expect(summaryOf({ ...live, records: [...live.records, lastWeeks] }).body).not.toContain("Replay spend");
      expect(summaryOf(withReplays).body).toContain("| Replay spend | $4.25 | – | – |");
    });

    it("scores the week's live runs only, leaving a replay's score files out of the Scores section", () => {
      const { summary } = summaryOf(
        input({
          records: [aRunRecord(), aReplayRunRecord()],
          scoreFiles: [
            aScoreFile({ entries: [aScoreEntry({ score: 0.8 })] }),
            aScoreFile({ runId: 2000, replay: A_REPLAY, entries: [aScoreEntry({ score: 0.2, pass: false })] }),
            aSkippedScoreFile({ reason: "judge-failed" }, { runId: 2000, replay: variant }),
          ],
        }),
      );
      expect(summary.scores.thisWeek).toEqual({
        scoreFiles: 1,
        rubrics: [{ scorer: "efficiency", version: 1, runsScored: 1, medianScore: 0.8, passing: 1 }],
        skips: { "weekly-limit": 0, "no-transcript": 0, "infrastructure-failure": 0, "judge-failed": 0, "judge-output-invalid": 0 },
      });
    });

    it("has no Scores section in a week whose only score files are replays'", () => {
      const { body } = summaryOf(input({ records: [aRunRecord(), aReplayRunRecord()], scoreFiles: [aScoreFile({ runId: 2000, replay: A_REPLAY })] }));
      expect(body).not.toContain("## Scores");
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

describe("Request changes in the Weekly summary (#369)", () => {
  // This week runs from 2026-11-01T13:00Z to 2026-11-08T13:00Z; last week the seven days before.
  const MISS = { reviewMiss: true, amendsTicket: false };
  const AMENDS = { reviewMiss: false, amendsTicket: true };
  const summaryOf = (facts: GitHubFacts[], records: RunRecord[] = [aRunRecord()]) => {
    const result = weeklySummary(input({ records, facts }));
    if (result.kind !== "summary") throw new Error("expected a summary");
    return result;
  };

  it("counts the Request changes submitted in each week with a Review miss, amending the Ticket, and unanswered", () => {
    const { summary } = summaryOf([
      factsOf({
        pullRequests: [
          aMergedPullRequest("2026-11-06T00:00:00Z", {
            reviews: [
              aReview("2026-10-30T00:00:00Z", { id: 800 }), // last week's, answered this week
              aReview("2026-11-03T00:00:00Z", { id: 901 }),
              aReview("2026-11-04T00:00:00Z", { id: 903 }), // from before the answers, such as the Pilot's #59 and #60
            ],
            comments: [
              anAnswersComment(800, { reviewMiss: true, amendsTicket: true }, "2026-11-02T00:00:00Z"),
              anAnswersComment(901, MISS, "2026-11-03T02:00:00Z"),
              aComment("<!-- fabrik:request-changes-run -->\nThe Implementer pushed the Operator's requested changes.", "2026-11-04T02:00:00Z"),
            ],
          }),
        ],
        openPullRequests: [
          anOpenPullRequest({ number: 52, reviews: [aReview("2026-11-05T00:00:00Z", { id: 902 })], comments: [anAnswersComment(902, AMENDS, "2026-11-05T02:00:00Z")] }),
        ],
      }),
    ]);

    expect(summary.requestChanges).toEqual({
      thisWeek: { reviewMiss: 1, amendsTicket: 1, unanswered: 1 },
      lastWeek: { reviewMiss: 1, amendsTicket: 1, unanswered: 0 },
    });
  });

  it("attributes each answer to the review its run was started for, so a review with no run of its own is unanswered", () => {
    const { summary } = summaryOf([
      factsOf({
        openPullRequests: [
          anOpenPullRequest({
            reviews: [aReview("2026-11-03T00:00:00Z", { id: 901 }), aReview("2026-11-03T01:00:00Z", { id: 902 })],
            // One run, started for the later review, which read the earlier one as an amendment.
            comments: [anAnswersComment(902, MISS, "2026-11-03T03:00:00Z")],
          }),
        ],
      }),
    ]);

    expect(summary.requestChanges.thisWeek).toEqual({ reviewMiss: 1, amendsTicket: 0, unanswered: 1 });
  });

  it.each([
    ["someone but the Operator", aReview("2026-11-03T00:00:00Z", { id: 901, author: "someone-else" }), anAnswersComment(901, MISS, "2026-11-03T02:00:00Z")],
    ["an approval", aReview("2026-11-03T00:00:00Z", { id: 901, state: "approved" }), anAnswersComment(901, MISS, "2026-11-03T02:00:00Z")],
  ])("counts no review by %s", (_, review, answer) => {
    const { summary } = summaryOf([factsOf({ openPullRequests: [anOpenPullRequest({ reviews: [review], comments: [answer] })] })]);

    expect(summary.requestChanges.thisWeek).toEqual({ reviewMiss: 0, amendsTicket: 0, unanswered: 0 });
  });

  it("reads an answer only from a bot's comment, so quoting a marker answers nothing", () => {
    const quoted = anAnswersComment(901, MISS, "2026-11-03T02:00:00Z", { byBot: false, author: "operator" });
    const { summary } = summaryOf([
      factsOf({ openPullRequests: [anOpenPullRequest({ reviews: [aReview("2026-11-03T00:00:00Z", { id: 901 })], comments: [quoted] })] }),
    ]);

    expect(summary.requestChanges.thisWeek).toEqual({ reviewMiss: 0, amendsTicket: 0, unanswered: 1 });
  });

  it("shows the two rows and the unanswered count in the table, each week over week", () => {
    const { body } = summaryOf([
      factsOf({
        openPullRequests: [
          anOpenPullRequest({
            reviews: [aReview("2026-10-30T00:00:00Z", { id: 800 }), aReview("2026-11-03T00:00:00Z", { id: 901 }), aReview("2026-11-04T00:00:00Z", { id: 902 })],
            comments: [anAnswersComment(800, AMENDS, "2026-10-30T02:00:00Z"), anAnswersComment(901, MISS, "2026-11-03T02:00:00Z")],
          }),
        ],
      }),
    ]);

    expect(body).toContain(
      [
        "| Request changes with a Review miss | 1 | 0 | +1 |",
        "| Request changes amending the Ticket | 0 | 1 | -1 |",
        "| Request changes unanswered | 1 | 0 | +1 |",
      ].join("\n"),
    );
  });

  it("lists each Review miss this week with links to the review, the answer's comment and the Review run whose pass it followed", () => {
    const { summary, body } = summaryOf(
      [
        factsOf({
          pullRequests: [
            aMergedPullRequest("2026-11-06T00:00:00Z", {
              reviews: [aReview("2026-11-03T00:00:00Z", { id: 901 }), aReview("2026-11-04T00:00:00Z", { id: 902 })],
              comments: [anAnswersComment(901, MISS, "2026-11-03T02:00:00Z"), anAnswersComment(902, AMENDS, "2026-11-04T02:00:00Z")],
            }),
          ],
          openPullRequests: [
            anOpenPullRequest({ number: 52, reviews: [aReview("2026-11-05T00:00:00Z", { id: 903 })], comments: [anAnswersComment(903, MISS, "2026-11-05T02:00:00Z")] }),
          ],
        }),
      ],
      [
        aRunRecord({ runId: 1001, role: "review", verdict: "pass", endedAt: "2026-11-02T18:00:00Z" }),
        aRunRecord({ runId: 1002, role: "review", verdict: "pass", endedAt: "2026-11-02T20:00:00Z" }), // the pass the review followed
        aRunRecord({ runId: 1003, role: "review", verdict: "pass", endedAt: "2026-11-03T05:00:00Z" }), // after it
      ],
    );

    expect(summary.reviewMissesThisWeek).toHaveLength(2);
    expect(body).toContain(
      [
        "### Review misses this week",
        "",
        "- [#50](https://github.com/owner/product/pull/50): [Request changes](https://github.com/owner/product/pull/50#pullrequestreview-901), [answered here](https://github.com/owner/product/pull/50#issuecomment-9011), after the pass of [Review run](https://github.com/owner/product/actions/runs/1002/attempts/1)",
        "- [#52](https://github.com/owner/product/pull/52): [Request changes](https://github.com/owner/product/pull/50#pullrequestreview-903), [answered here](https://github.com/owner/product/pull/50#issuecomment-9031), after no passing Review run on record",
        "",
      ].join("\n"),
    );
  });

  it("leaves the Review misses list out of a week with none", () => {
    const { body } = summaryOf([
      factsOf({
        openPullRequests: [anOpenPullRequest({ reviews: [aReview("2026-11-03T00:00:00Z", { id: 901 })], comments: [anAnswersComment(901, AMENDS, "2026-11-03T02:00:00Z")] })],
      }),
    ]);

    expect(body).toContain("| Request changes amending the Ticket | 1 | 0 | +1 |");
    expect(body).not.toContain("Review misses this week");
  });
});
