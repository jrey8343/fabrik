import { describe, expect, it } from "vitest";
import {
  aCommit,
  aLabelAdded,
  aMergedPullRequest,
  aReview,
  aRunRecord,
  aSpec,
  aTicketTimeline,
  aVerdictComment,
  factsOf,
} from "../__fixtures__/weeklySummary.ts";
import { type AgentPullRequestFacts, type GitHubFacts, type TicketFacts, type WeeklySummaryInput, weeklySummary } from "./weeklySummary.ts";

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
              { author: "operator", byApp: false, body: "Looks good, merging.", at: "2026-11-05T00:00:00Z" },
              { author: "operator", byApp: false, body: "Answering round 2: yes.", at: "2026-11-05T01:00:00Z" },
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
      const verdict = aVerdictComment;
      const summary = summaryOf(
        factsOf({
          pullRequests: [
            aMergedPullRequest("2026-11-04T00:00:00Z", {
              number: 50,
              comments: [
                verdict("pass", "2026-11-03T00:00:00Z"),
                verdict("execution-flaw", "2026-11-03T06:00:00Z"),
                verdict("pass", "2026-11-03T12:00:00Z"), // the last pass: 12 hours
                verdict("pass", "2026-11-03T20:00:00Z", { byApp: false, author: "operator" }), // quoting a marker fakes nothing
                { author: "operator", byApp: false, body: "Merging.", at: "2026-11-03T22:00:00Z" },
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
            aRunRecord({ endedAt: "2026-11-03T06:00:00Z", totalCostUsd: null, retry: 1 }),
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

    it("leaves a run whose cost basis is unknown out of the sum, and counts it", () => {
      const result = weeklySummary(
        input({
          records: [
            aRunRecord({ issue: 3, role: "triage", pullRequest: null, endedAt: "2026-11-03T00:00:00Z", totalCostUsd: null }),
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
            aRunRecord({ endedAt: "2026-11-03T06:00:00Z", totalCostUsd: null }),
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
          totalCostUsd: null,
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
              comments: [aVerdictComment("pass", "2026-11-03T18:00:00Z")],
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
            aRunRecord({ issue: 7, endedAt: "2026-11-03T00:00:00Z", totalCostUsd: null, retry: 1 }),
            aRunRecord({ issue: 8, endedAt: "2026-10-27T00:00:00Z", totalCostUsd: 1.5 }),
            aRunRecord({ issue: 9, endedAt: "2026-11-04T00:00:00Z", totalCostUsd: 0.25 }),
            aRunRecord({ issue: 3, role: "design", pullRequest: null, endedAt: "2026-10-26T00:00:00Z", totalCostUsd: null }),
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
