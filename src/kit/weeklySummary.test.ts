import { describe, expect, it } from "vitest";
import {
  aComment,
  aCommit,
  aDesignRound,
  aLabelAdded,
  aMergedPullRequest,
  anOpenIssue,
  anOpenPullRequest,
  aReview,
  aRunRecord,
  aSpec,
  aTicketTimeline,
  aVerdictComment,
  factsOf,
  UNKNOWN_COST_BASIS,
} from "../__fixtures__/weeklySummary.ts";
import type { Verdict } from "../loop/types.ts";
import { type AgentPullRequestFacts, type CommentFacts, type GitHubFacts, type TicketFacts, type WeeklySummaryInput, weeklySummary } from "./weeklySummary.ts";

// The filing: Monday 9 November 2026, 07:00 in Sydney (AEDT, UTC+11). The
// week it covers runs from Monday 2 November 00:00 to Monday 9 November 00:00
// Sydney time, that is 2026-11-01T13:00Z to 2026-11-08T13:00Z.
const NOW = "2026-11-08T20:00:00Z";

function input(overrides: Partial<WeeklySummaryInput> = {}): WeeklySummaryInput {
  return { records: [], facts: [factsOf()], operator: "operator", appLogin: "fabrik-app[bot]", timeZone: "Australia/Sydney", now: NOW, ...overrides };
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
              { author: "operator", byBot: false, body: "Looks good, merging.", at: "2026-11-05T00:00:00Z" },
              { author: "operator", byBot: false, body: "Answering round 2: yes.", at: "2026-11-05T01:00:00Z" },
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
                { author: "operator", byBot: false, body: "Merging.", at: "2026-11-03T22:00:00Z" },
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
  });

  describe("rendered", () => {
    const week = input({
      records: [
        aRunRecord({ endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 1.5, retry: 1 }),
        aRunRecord({
          endedAt: "2026-11-05T00:00:00Z",
          ...UNKNOWN_COST_BASIS,
          stepUp: true,
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
      expect(body).not.toMatch(/Held|Retro|Audit|Map|Monitor|escape|score/i);
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
