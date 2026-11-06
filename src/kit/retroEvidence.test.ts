import { describe, expect, it } from "vitest";
import {
  aComment,
  aCommit,
  anEscapeMarkerIssue,
  aLabelAdded,
  aMergedPullRequest,
  aReview,
  aRunRecord,
  aTicketTimeline,
  aVerdictComment,
  factsOf,
} from "../__fixtures__/weeklySummary.ts";
import type { Verdict } from "../loop/types.ts";
import { type CommentFacts, escapesIn, mergedAgentPullRequestsIn, verdictsOn } from "./retroEvidence.ts";

// A week in UTC: Monday 2 November 2026 00:00 to Monday 9 November 00:00.
const WINDOW = { start: Date.parse("2026-11-02T00:00:00Z"), end: Date.parse("2026-11-09T00:00:00Z") };

describe("the metrics", () => {
  describe("agent PRs merged in a window", () => {
    it("reads each agent PR merged in the window, across every Product repo, with its Ticket and when that was dispatched", () => {
      const merged = mergedAgentPullRequestsIn(WINDOW, {
        facts: [
          factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-03T00:00:00Z", { number: 50, ticket: 7 }),
              aMergedPullRequest("2026-11-01T23:59:59Z", { number: 51, ticket: 8 }), // before the window
              aMergedPullRequest("2026-11-09T00:00:00Z", { number: 52, ticket: 9 }), // at its end: after it
              aMergedPullRequest("2026-11-04T00:00:00Z", { number: 53, mergedAt: null, mergeSha: null }), // closed unmerged
            ],
            // Dispatch is the first agent:implement; a Retry adds it again.
            tickets: [
              aTicketTimeline([aLabelAdded("agent:implement", "2026-11-02T09:00:00Z"), aLabelAdded("agent:implement", "2026-11-02T05:00:00Z")]),
            ],
          }),
          // Its Ticket isn't among the repo's facts.
          factsOf({ repo: "owner/other", pullRequests: [aMergedPullRequest("2026-11-05T00:00:00Z", { number: 60, ticket: 3 })] }),
        ],
        operator: "operator",
      });
      const read = merged.map(({ repo, pullRequest, mergedAt, ticket, dispatch }) => ({
        repo,
        number: pullRequest.number,
        mergedAt,
        ticket: ticket?.number ?? null,
        dispatch,
      }));
      expect(read).toEqual([
        { repo: "owner/product", number: 50, mergedAt: "2026-11-03T00:00:00Z", ticket: 7, dispatch: "2026-11-02T05:00:00Z" },
        { repo: "owner/other", number: 60, mergedAt: "2026-11-05T00:00:00Z", ticket: null, dispatch: null },
      ]);
    });

    it("reads each one's Human touches between Dispatch and the merge, never an Operator comment", () => {
      const [merged] = mergedAgentPullRequestsIn(WINDOW, {
        facts: [
          factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-06T00:00:00Z", {
                commits: [
                  aCommit("2026-11-03T01:00:00Z", { byApp: true }),
                  aCommit("2026-11-03T02:00:00Z"), // the Operator's push of two commits: one touch
                  aCommit("2026-11-03T02:01:00Z"),
                  aCommit("2026-11-06T00:00:01Z"), // after the merge
                ],
                reviews: [
                  aReview("2026-11-04T00:00:00Z"), // the Operator's Request changes: one touch
                  aReview("2026-11-04T01:00:00Z", { author: "someone-else" }),
                  aReview("2026-11-02T23:00:00Z"), // before Dispatch
                ],
                labelEvents: [aLabelAdded("agent:review", "2026-11-05T00:00:00Z", { actor: "operator" })], // the Operator adding agent:review: one touch
                comments: [aComment("Please rename this.", "2026-11-05T00:00:00Z", { author: "operator", byBot: false })],
              }),
            ],
            tickets: [aTicketTimeline([aLabelAdded("agent:implement", "2026-11-03T00:00:00Z")])],
          }),
        ],
        operator: "operator",
      });
      expect(merged?.humanTouches).toBe(3);
    });

    it("reads when each one's last passing Verdict before the merge was given, from bots' Verdict markers alone", () => {
      const verdict = (v: Verdict, at: string, overrides: Partial<CommentFacts> = {}) => aVerdictComment(v, "a".repeat(40), at, overrides);
      const merged = mergedAgentPullRequestsIn(WINDOW, {
        facts: [
          factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-04T00:00:00Z", {
                number: 50,
                comments: [
                  verdict("pass", "2026-11-03T00:00:00Z"),
                  verdict("pass", "2026-11-03T12:00:00Z"), // the last pass
                  verdict("execution-flaw", "2026-11-03T18:00:00Z"),
                  verdict("pass", "2026-11-03T20:00:00Z", { author: "operator", byBot: false }), // quoting a marker fakes nothing
                  verdict("pass", "2026-11-04T00:00:01Z"), // after the merge
                ],
              }),
              aMergedPullRequest("2026-11-05T00:00:00Z", { number: 51, comments: [verdict("design-flaw", "2026-11-04T00:00:00Z")] }),
            ],
          }),
        ],
        operator: "operator",
      });
      expect(merged.map(({ pullRequest, lastPass }) => ({ number: pullRequest.number, lastPass }))).toEqual([
        { number: 50, lastPass: "2026-11-03T12:00:00Z" },
        { number: 51, lastPass: null },
      ]);
    });

    it("reads whether a revert in the window reverted each one, by its merge sha's trailer or a merged Revert PR of its title", () => {
      const sha = (n: number) => String(n).repeat(40);
      const pullRequest = (number: number) =>
        aMergedPullRequest("2026-11-03T00:00:00Z", { number, mergeSha: sha(number), title: `Build thing ${number}` });
      const merged = mergedAgentPullRequestsIn(WINDOW, {
        facts: [
          factsOf({
            pullRequests: [pullRequest(1), pullRequest(2), pullRequest(3), pullRequest(4)],
            defaultBranchCommits: [
              { message: `Revert "Build thing 1"\n\nThis reverts commit ${sha(1)}.`, at: "2026-11-04T00:00:00Z" },
              { message: `This reverts commit ${sha(3)}.`, at: "2026-11-09T00:00:00Z" }, // after the window
            ],
            mergedPullRequestTitles: [
              { title: 'Revert "Build thing 2"', mergedAt: "2026-11-05T00:00:00Z" },
              { title: 'Revert "Build thing 4"', mergedAt: "2026-11-01T00:00:00Z" }, // before the window
            ],
          }),
        ],
        operator: "operator",
      });
      expect(merged.map(({ pullRequest, reverted }) => ({ number: pullRequest.number, reverted }))).toEqual([
        { number: 1, reverted: true },
        { number: 2, reverted: true },
        { number: 3, reverted: false },
        { number: 4, reverted: false },
      ]);
    });
  });

  describe("the Verdicts on a PR", () => {
    it("reads each Verdict from a bot's marker, in the order the comments came, with when it was posted, and never a person's quote of one", () => {
      const verdicts = verdictsOn([
        aVerdictComment("execution-flaw", "a".repeat(40), "2026-11-03T00:00:00Z"),
        aVerdictComment("pass", "a".repeat(40), "2026-11-03T01:00:00Z", { author: "operator", byBot: false }),
        aComment("Starting the review.", "2026-11-03T02:00:00Z"),
        aVerdictComment("pass", "b".repeat(40), "2026-11-03T03:00:00Z"),
      ]);
      expect(verdicts).toEqual([
        { record: { verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: "a".repeat(40) }, at: "2026-11-03T00:00:00Z" },
        { record: { verdict: "pass", source: "reviewer", requestChanges: false, headSha: "b".repeat(40) }, at: "2026-11-03T03:00:00Z" },
      ]);
    });
  });

  describe("Architectural escapes opened in a window", () => {
    it("reads each Operator's issue opened in the window whose escape marker names agent PRs merged in it, counted against those alone", () => {
      const escapes = escapesIn(WINDOW, {
        facts: [
          factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-03T00:00:00Z", { number: 50 }),
              aMergedPullRequest("2026-11-01T00:00:00Z", { number: 51 }), // merged before the window
              aMergedPullRequest("2026-11-03T00:00:00Z", { number: 52, mergedAt: null, mergeSha: null }), // closed unmerged
            ],
            escapeMarkerIssues: [
              anEscapeMarkerIssue("<!-- fabrik:escape strong #50 #51 #52 #60 -->", { number: 80 }), // #60 is no agent PR
              anEscapeMarkerIssue("<!-- fabrik:escape strong #51 #52 -->", { number: 81 }), // names none merged in the window: no escape
              anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->", { number: 82, author: "someone" }),
              anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->", { number: 83, createdAt: "2026-11-01T00:00:00Z" }), // before the window
              anEscapeMarkerIssue("<!-- fabrik:escape sure #50 -->", { number: 84 }), // a Strength the Auditor doesn't give
              anEscapeMarkerIssue("No marker here, #50.", { number: 85 }),
            ],
          }),
          factsOf({
            repo: "owner/other",
            pullRequests: [aMergedPullRequest("2026-11-04T00:00:00Z", { number: 50 })],
            escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape speculative #50 -->", { number: 86 })],
          }),
        ],
        records: [],
        operator: "operator",
      });
      expect(escapes.map(({ repo, issue, strength, pullRequests }) => [repo, issue.number, strength, pullRequests.map(({ pullRequest }) => pullRequest.number)])).toEqual([
        ["owner/product", 80, "strong", [50]],
        ["owner/product", 84, null, [50]],
        ["owner/other", 86, "speculative", [50]],
      ]);
    });

    it("names what let each PR through: the Run records on its Ticket, oldest first, its last passing Review record, and whether anyone but the App pushed to it", () => {
      const review = (runId: number, endedAt: string, verdict: Verdict) => aRunRecord({ runId, role: "review", endedAt, verdict });
      const implement = aRunRecord({ runId: 1000, endedAt: "2026-11-02T00:00:00Z" });
      const firstPass = review(1001, "2026-11-02T06:00:00Z", "pass");
      const retry = aRunRecord({ runId: 1002, endedAt: "2026-11-02T12:00:00Z", retry: 1 });
      const lastPass = review(1003, "2026-11-02T18:00:00Z", "pass");
      const flaw = review(1004, "2026-11-02T20:00:00Z", "execution-flaw"); // after the Operator pushed; merged anyway
      const otherFlaw = aRunRecord({ runId: 1005, issue: 8, pullRequest: 51, role: "review", verdict: "design-flaw", endedAt: "2026-11-03T06:00:00Z" });
      const [escape] = escapesIn(WINDOW, {
        facts: [
          factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-03T00:00:00Z", {
                number: 50,
                ticket: 7,
                commits: [aCommit("2026-11-02T00:00:00Z", { byApp: true }), aCommit("2026-11-02T19:00:00Z")],
              }),
              aMergedPullRequest("2026-11-04T00:00:00Z", { number: 51, ticket: 8, commits: [aCommit("2026-11-03T00:00:00Z", { byApp: true })] }),
            ],
            escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #50 #51 -->", { createdAt: "2026-11-05T00:00:00Z" })],
          }),
        ],
        records: [
          lastPass,
          implement,
          flaw,
          otherFlaw,
          firstPass,
          retry,
          aRunRecord({ runId: 1006, repo: "owner/other", role: "review", verdict: "pass", endedAt: "2026-11-02T22:00:00Z" }), // another repo's #50
        ],
        operator: "operator",
      });
      expect(
        escape?.pullRequests.map(({ pullRequest, records, lastPassingReview, operatorPushes }) => ({
          number: pullRequest.number,
          records,
          lastPassingReview,
          operatorPushes,
        })),
      ).toEqual([
        { number: 50, records: [implement, firstPass, retry, lastPass, flaw], lastPassingReview: lastPass, operatorPushes: true },
        { number: 51, records: [otherFlaw], lastPassingReview: null, operatorPushes: false },
      ]);
    });
  });
});
