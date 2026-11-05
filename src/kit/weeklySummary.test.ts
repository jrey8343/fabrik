import { describe, expect, it } from "vitest";
import {
  aComment,
  aDesignRound,
  aLabelAdded,
  aMergedPullRequest,
  anOpenIssue,
  anOpenPullRequest,
  aRunRecord,
  aTicketTimeline,
  aVerdictComment,
  factsOf,
} from "../__fixtures__/weeklySummary.ts";
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
  });

  describe("rendered", () => {
    const week = input({
      records: [
        aRunRecord({ endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1.5, retry: 1 }),
        aRunRecord({
          endedAt: "2026-11-05T00:00:00Z",
          totalCostUsd: null,
          stepUp: true,
          // Friday 13 November 2026, 10:00 in Sydney.
          rateLimit: { status: "allowed", rateLimitType: "seven_day", utilization: 0.62, resetsAt: 1_794_524_400 },
        }),
        aRunRecord({ endedAt: "2026-10-28T00:00:00Z", totalCostUsd: 2.25 }),
      ],
      facts: [factsOf({ pullRequests: [aMergedPullRequest("2026-11-04T00:00:00Z")] })],
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
      expect(body).toContain("| Merged agent PRs | 1 | 0 | +1 |");
      expect(body).toContain("| Tickets dispatched | 0 | 0 | 0 |");
      expect(body).toContain("| Retries | 1 | 0 | +1 |");
      expect(body).toContain("| Step-ups | 1 | 0 | +1 |");
    });

    it("says how many runs the cost leaves out and how close the Subscription came to its weekly limit", () => {
      const { body } = rendered();
      expect(body).toContain("1 run with an unknown cost basis is left out of the cost.");
      expect(body).toContain("Subscription usage: 62% of the weekly limit, resetting 2026-11-13 10:00 (Australia/Sydney).");
    });

    it("ends with exactly one mention of the Operator", () => {
      const { body } = rendered();
      expect(body.match(/@operator\b/g)).toHaveLength(1);
      expect(body.trimEnd().endsWith("@operator")).toBe(true);
    });

    it("has no section for a feature that hasn't shipped, not even an empty one", () => {
      const { body } = rendered();
      expect(body.match(/^#+ .*$/gm)).toEqual(["## Metrics"]);
      expect(body).not.toMatch(/Held|Retro|Audit|Map|Monitor|escape|score/i);
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
