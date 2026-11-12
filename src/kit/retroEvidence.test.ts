import { describe, expect, it } from "vitest";
import {
  aPastRetro,
  aRecordWithTranscript,
  aRetroEvidenceInput,
  aTranscript,
  aVerdictWithFollowUps,
  theRetroBeingFilled,
  transcriptsOf,
} from "../__fixtures__/retroEvidence.ts";
import { retroBody } from "../__fixtures__/snapshots.ts";
import {
  A_REPLAY,
  aComment,
  aCommit,
  aFollowUpIssue,
  aLabelAdded,
  aMergedPullRequest,
  anAnswersComment,
  anEscapeMarkerIssue,
  anOpenPullRequest,
  aReplayRunRecord,
  aReview,
  aRunRecord,
  aTicketTimeline,
  aVerdictComment,
  factsOf,
} from "../read/builders.ts";
import { aScoreEntry, aScoreFile, aSkippedScoreFile } from "../__fixtures__/weeklySummary.ts";
import { fromRetroLine } from "../loop/markers.ts";
import type { Verdict } from "../loop/types.ts";
import {
  type AgentPullRequestFacts,
  type CommentFacts,
  EVIDENCE_BUDGET,
  type EvidenceBundle,
  escapesIn,
  evidenceBundle,
  evidenceReachOf,
  evidenceTicketsOf,
  mergedAgentPullRequestsIn,
  refsOf,
  type RetroIssueFacts,
  verdictsOn,
} from "./retroEvidence.ts";
import { judgePrompt } from "./scorerPrompt.ts";

/** The digest of `transcript` that the judge reads in its prompt: the body of the prompt's one fenced transcript block. */
function theJudgesDigestOf(transcript: readonly string[]): string {
  const { prompt } = judgePrompt({ transcript, ticket: { title: "A Ticket", body: "" }, run: { kind: "first", retry: 0, timedOut: false }, brief: null, rubrics: [] });
  const [block] = [...prompt.matchAll(/^(`{3,})text\n([\s\S]*?)\n\1$/gm)];
  if (block?.[2] === undefined) throw new Error("The judge prompt holds no transcript block");
  return block[2];
}

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

describe("the evidence bundle", () => {
  describe("the window", () => {
    it("runs from the last Retro's window end to this one's", () => {
      const { window } = evidenceBundle(
        aRetroEvidenceInput({
          windowEnd: "2026-11-07T10:00:00Z",
          retros: [aPastRetro({ number: 100, body: retroBody("2026-11-01T09:30:00.000Z") }), theRetroBeingFilled("2026-11-07T10:00:00.000Z")],
        }),
      );
      expect(window).toEqual({ start: "2026-11-01T09:30:00.000Z", end: "2026-11-07T10:00:00.000Z" });
    });

    it("never takes the Retro being filled, or a failed one, for the last Retro", () => {
      const { window } = evidenceBundle(
        aRetroEvidenceInput({
          retros: [
            aPastRetro({ number: 99, createdAt: "2026-10-24T00:00:04Z", body: retroBody("2026-10-24T00:00:00.000Z") }),
            aPastRetro({ number: 100, createdAt: "2026-10-31T00:00:04Z", stateReason: "not_planned", body: retroBody("2026-10-31T00:00:00.000Z", "failed") }),
            theRetroBeingFilled("2026-11-07T00:00:00.000Z"),
          ],
        }),
      );
      expect(window.start).toBe("2026-10-24T00:00:00.000Z");
    });

    it("covers the 7 days before this one's end on a first run", () => {
      const { window } = evidenceBundle(aRetroEvidenceInput({ windowEnd: "2026-11-07T10:00:00Z", retros: [theRetroBeingFilled("2026-11-07T10:00:00.000Z")] }));
      expect(window).toEqual({ start: "2026-10-31T10:00:00.000Z", end: "2026-11-07T10:00:00.000Z" });
    });
  });

  // The window, unless a test says otherwise: Saturday 2026-10-31 00:00 UTC to Saturday 2026-11-07.

  describe("Architectural escapes", () => {
    it("holds each escape the Operator opened in the window, with its body and the agent PRs merged in the 90 days to it that it names", () => {
      const { escapes } = evidenceBundle(
        aRetroEvidenceInput({
          facts: factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-02T00:00:00Z", { number: 50, ticket: 7, title: "Build the cart" }),
              aMergedPullRequest("2026-09-01T00:00:00Z", { number: 51, ticket: 8, title: "Build the till" }), // 63 days before #80
              aMergedPullRequest("2026-08-01T00:00:00Z", { number: 52, ticket: 9 }), // 94 days before it
              aMergedPullRequest("2026-08-06T00:00:00Z", { number: 53, ticket: 10, title: "Build the shelf" }), // 89 days before it, 93 before the window's end
            ],
            escapeMarkerIssues: [
              anEscapeMarkerIssue("The cart leaks its rules.\n\n<!-- fabrik:escape strong #50 #51 #52 #53 -->", { number: 80, createdAt: "2026-11-03T00:00:00Z" }),
              anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->", { number: 81, createdAt: "2026-10-30T23:59:59Z" }), // the last Retro's
              anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->", { number: 82, createdAt: "2026-11-07T00:00:00Z" }), // the next Retro's
            ],
          }),
        }),
      );
      expect(escapes.map(({ ref, number, title, body, strength, pullRequests }) => ({ ref, number, title, body, strength, pullRequests: pullRequests.map((pr) => [pr.ref, pr.title]) }))).toEqual([
        {
          ref: "#80",
          number: 80,
          title: "Make the cart module deeper",
          body: "The cart leaks its rules.\n\n<!-- fabrik:escape strong #50 #51 #52 #53 -->",
          strength: "strong",
          pullRequests: [
            ["#50", "Build the cart"],
            ["#51", "Build the till"],
            ["#53", "Build the shelf"],
          ],
        },
      ]);
    });

    // A Retro held back for weeks reads a window longer than the 90 days escapes count PRs over.
    it("holds each escape opened in a window longer than 90 days, even one opened before its last 90 days, counted against the agent PRs merged in the 90 days to it", () => {
      const { window, escapes } = evidenceBundle(
        aRetroEvidenceInput({
          retros: [aPastRetro({ number: 100, body: retroBody("2026-06-01T00:00:00.000Z") }), theRetroBeingFilled("2026-11-07T00:00:00.000Z")],
          facts: factsOf({
            pullRequests: [
              aMergedPullRequest("2026-05-20T00:00:00Z", { number: 40, ticket: 5 }), // 21 days before #70, before the window
              aMergedPullRequest("2026-02-01T00:00:00Z", { number: 41, ticket: 6 }), // 129 days before #70
              aMergedPullRequest("2026-10-01T00:00:00Z", { number: 50, ticket: 7 }),
            ],
            escapeMarkerIssues: [
              anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->", { number: 80, createdAt: "2026-11-03T00:00:00Z" }),
              anEscapeMarkerIssue("<!-- fabrik:escape strong #40 #41 -->", { number: 70, createdAt: "2026-06-10T00:00:00Z" }),
            ],
          }),
        }),
      );
      expect(window.start).toBe("2026-06-01T00:00:00.000Z");
      expect(escapes.map(({ number, pullRequests }) => [number, pullRequests.map((pr) => pr.number)])).toEqual([
        [80, [50]],
        [70, [40]],
      ]);
    });

    it("counts an escape in the last 90 days of a longer window against an agent PR merged in the 90 days to it, before those last 90 days", () => {
      const { escapes } = evidenceBundle(
        aRetroEvidenceInput({
          retros: [aPastRetro({ number: 100, body: retroBody("2026-06-01T00:00:00.000Z") }), theRetroBeingFilled("2026-11-07T00:00:00.000Z")],
          facts: factsOf({
            pullRequests: [aMergedPullRequest("2026-07-20T00:00:00Z", { number: 45, ticket: 5 })], // 110 days before the window's end
            escapeMarkerIssues: [
              anEscapeMarkerIssue("<!-- fabrik:escape strong #45 -->", { number: 91, createdAt: "2026-08-08T00:00:00Z" }), // 91 days before the window's end
              anEscapeMarkerIssue("<!-- fabrik:escape strong #45 -->", { number: 90, createdAt: "2026-08-15T00:00:00Z" }), // 84 days before it, 26 after #45
            ],
          }),
        }),
      );
      expect(escapes.map(({ number, pullRequests }) => [number, pullRequests.map((pr) => pr.number)])).toEqual([
        [91, [45]],
        [90, [45]],
      ]);
    });

    it("reads facts from 90 days before its window starts, so an escape opened at the start is counted against every PR it may name", () => {
      const input = aRetroEvidenceInput({
        retros: [aPastRetro({ number: 100, body: retroBody("2026-06-01T00:00:00.000Z") }), theRetroBeingFilled("2026-11-07T00:00:00.000Z")],
      });

      expect(new Date(evidenceReachOf(input)).toISOString()).toBe("2026-03-03T00:00:00.000Z");
    });

    it("counts no marker that names only people's PRs, and no marker in an issue anyone but the Operator opened", () => {
      const { escapes } = evidenceBundle(
        aRetroEvidenceInput({
          facts: factsOf({
            // #60 is a person's PR: the facts hold agent PRs alone.
            pullRequests: [aMergedPullRequest("2026-11-02T00:00:00Z", { number: 50 })],
            escapeMarkerIssues: [
              anEscapeMarkerIssue("<!-- fabrik:escape strong #60 -->", { number: 80 }),
              anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->", { number: 81, author: "someone" }),
              anEscapeMarkerIssue("<!-- fabrik:escape strong #50 #60 -->", { number: 82 }),
            ],
          }),
        }),
      );
      expect(escapes.map(({ number, pullRequests }) => [number, pullRequests.map((pr) => pr.number)])).toEqual([[82, [50]]]);
    });

    it("carries each PR's Ticket with its title and body, the Run records on it and the last passing Review record on the PR, each by its record path", () => {
      const implement = aRunRecord({ runId: 1000, endedAt: "2026-10-30T12:00:00Z" });
      const firstPass = aRunRecord({ runId: 1001, role: "review", verdict: "pass", endedAt: "2026-10-31T06:00:00Z" });
      const retry = aRunRecord({ runId: 1002, retry: 1, endedAt: "2026-11-01T00:00:00Z" });
      const lastPass = aRunRecord({ runId: 1003, role: "review", verdict: "pass", endedAt: "2026-11-01T06:00:00Z" });
      const { escapes } = evidenceBundle(
        aRetroEvidenceInput({
          records: [lastPass, retry, firstPass, implement],
          facts: factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-02T00:00:00Z", { number: 50, ticket: 7 }),
              aMergedPullRequest("2026-11-02T00:00:00Z", { number: 51, ticket: null }),
            ],
            escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #50 #51 -->")],
          }),
          tickets: [{ number: 7, title: "Build the cart", body: "## What to build\n\nA cart that totals its lines." }],
        }),
      );
      expect(escapes[0]?.pullRequests).toEqual([
        {
          ref: "#50",
          number: 50,
          title: "Build the thing",
          ticket: { ref: "#7", number: 7, title: "Build the cart", body: "## What to build\n\nA cart that totals its lines." },
          records: [
            { ref: "runs/owner/product/2026-10/1000-1-implement.json", record: implement },
            { ref: "runs/owner/product/2026-10/1001-1-review.json", record: firstPass },
            { ref: "runs/owner/product/2026-11/1002-1-implement.json", record: retry },
            { ref: "runs/owner/product/2026-11/1003-1-review.json", record: lastPass },
          ],
          lastPassingReview: { ref: "runs/owner/product/2026-11/1003-1-review.json", record: lastPass, digest: null },
        },
        { ref: "#51", number: 51, title: "Build the thing", ticket: null, records: [], lastPassingReview: null },
      ]);
    });

    it("carries a Ticket GitHub no longer has, as the evidence job found it, by its number alone", () => {
      const { escapes } = evidenceBundle(
        aRetroEvidenceInput({
          facts: factsOf({
            pullRequests: [aMergedPullRequest("2026-11-02T00:00:00Z", { number: 50, ticket: 7 })],
            escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->")],
          }),
        }),
      );
      expect(escapes[0]?.pullRequests[0]?.ticket).toEqual({ ref: "#7", number: 7, title: null, body: null });
    });

    it("names the Tickets the evidence job reads for it: each escaped PR's and each sampled PR's, once each", () => {
      // #12 and #28 are in the sample, and #13 isn't.
      const input = aRetroEvidenceInput({
        facts: factsOf({
          pullRequests: [
            aMergedPullRequest("2026-11-03T00:00:00Z", { number: 50, ticket: 7 }),
            aMergedPullRequest("2026-11-03T00:00:00Z", { number: 51, ticket: null }),
            aMergedPullRequest("2026-11-03T00:00:00Z", { number: 12, ticket: 7 }),
            aMergedPullRequest("2026-11-03T00:00:00Z", { number: 13, ticket: 9 }),
            aMergedPullRequest("2026-11-03T00:00:00Z", { number: 28, ticket: 10 }),
          ],
          escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #50 #51 -->")],
        }),
      });
      const { escapes, sample } = evidenceBundle(input);

      expect(sample.map(({ number }) => number)).toEqual([12, 28]);
      expect(escapes.flatMap(({ pullRequests }) => pullRequests.map(({ number }) => number))).toEqual([50, 51]);
      expect(evidenceTicketsOf(input).toSorted((a, b) => a - b)).toEqual([7, 10]);
    });

    it("carries the last passing Review record's transcript digest, the one the judge reads, or none when the store has no transcript", () => {
      const transcript = aTranscript({ "src/cart.ts": "export const cart = [];" });
      const review = aRecordWithTranscript({ runId: 1001, role: "review", pullRequest: 50, verdict: "pass", endedAt: "2026-11-01T00:00:00Z" });
      const untranscribed = aRunRecord({ runId: 1002, role: "review", pullRequest: 51, verdict: "pass", endedAt: "2026-11-01T00:00:00Z" });
      const lost = aRecordWithTranscript({ runId: 1003, role: "review", pullRequest: 52, verdict: "pass", endedAt: "2026-11-01T00:00:00Z" });
      const { escapes } = evidenceBundle(
        aRetroEvidenceInput({
          records: [review, untranscribed, lost],
          readTranscript: transcriptsOf([review, transcript]),
          facts: factsOf({
            pullRequests: [50, 51, 52].map((number) => aMergedPullRequest("2026-11-02T00:00:00Z", { number })),
            escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #50 #51 #52 -->")],
          }),
        }),
      );
      const [withDigest, withNone, withLost] = escapes[0]?.pullRequests ?? [];
      expect(withDigest?.lastPassingReview?.digest).toBe(theJudgesDigestOf(transcript));
      expect(withDigest?.lastPassingReview?.digest).toContain('#1 Read {"file_path":"src/cart.ts"}\n#1 result: export const cart = [];');
      expect(withNone?.lastPassingReview?.digest).toBeNull();
      expect(withLost?.lastPassingReview?.digest).toBeNull();
    });

    it("never holds another repo's Run records, though they name the same Ticket and PR", () => {
      const ours = aRunRecord({ runId: 1001, role: "review", verdict: "pass", endedAt: "2026-11-01T00:00:00Z" });
      const theirs = (runId: number, role: "implement" | "review") =>
        aRunRecord({ repo: "owner/other", runId, role, verdict: role === "review" ? "pass" : null, endedAt: "2026-11-01T06:00:00Z" });
      const { escapes } = evidenceBundle(
        aRetroEvidenceInput({
          records: [ours, theirs(2000, "implement"), theirs(2001, "review")],
          facts: factsOf({
            pullRequests: [aMergedPullRequest("2026-11-02T00:00:00Z", { number: 50, ticket: 7 })],
            escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->")],
          }),
        }),
      );
      expect(escapes[0]?.pullRequests[0]).toMatchObject({
        records: [{ ref: "runs/owner/product/2026-11/1001-1-review.json", record: ours }],
        lastPassingReview: { ref: "runs/owner/product/2026-11/1001-1-review.json", record: ours },
      });
    });

    // A Replay re-runs a merged Ticket, so its records name that Ticket and PR, but no Replay run let the PR through.
    it("never holds a Replay's runs on the Ticket, nor takes a Replay's passing Review for the last one that let the PR through", () => {
      const live = aRunRecord({ runId: 1001, role: "review", verdict: "pass", endedAt: "2026-11-01T00:00:00Z" });
      const replayed = [
        aReplayRunRecord({ runId: 2000, role: "implement", endedAt: "2026-11-05T00:00:00Z" }),
        aReplayRunRecord({ runId: 2000, role: "review", verdict: "pass", endedAt: "2026-11-05T01:00:00Z" }),
      ];
      const { escapes, streakTable } = evidenceBundle(
        aRetroEvidenceInput({
          records: [live, ...replayed],
          facts: factsOf({
            pullRequests: [aMergedPullRequest("2026-11-02T00:00:00Z", { number: 50, ticket: 7 })],
            escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->")],
          }),
        }),
      );
      expect(escapes[0]?.pullRequests[0]).toMatchObject({
        records: [{ ref: "runs/owner/product/2026-11/1001-1-review.json", record: live }],
        lastPassingReview: { ref: "runs/owner/product/2026-11/1001-1-review.json", record: live },
      });
      expect(streakTable.map(({ number }) => number)).toEqual([50]);
    });
  });

  describe("the Operator's feedback on agent PRs", () => {
    it("holds each Request changes the Operator gave in the window, with its body and inline comments", () => {
      const inline = [
        { path: "src/cart.ts", line: 12, body: "This belongs in the pricing module." },
        { path: "src/cart.test.ts", line: null, body: "Test through the cart, not its helper." },
      ];
      const { feedback } = evidenceBundle(
        aRetroEvidenceInput({
          facts: factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-04T00:00:00Z", {
                number: 50,
                title: "Build the cart",
                reviews: [
                  aReview("2026-11-02T00:00:00Z", { body: "Keep pricing out of the cart.", comments: inline }),
                  aReview("2026-10-30T00:00:00Z", { body: "Read by the last Retro." }), // before the window
                  aReview("2026-11-03T00:00:00Z", { author: "someone", body: "Not the Operator's." }),
                ],
              }),
            ],
          }),
        }),
      );
      expect(feedback).toEqual([
        {
          ref: "#50",
          number: 50,
          title: "Build the cart",
          state: "merged",
          // A review from before the answers is unanswered, never guessed.
          items: [{ kind: "request-changes", at: "2026-11-02T00:00:00Z", body: "Keep pricing out of the cart.", inline, reviewMiss: null, amendsTicket: null }],
        },
      ]);
    });

    it("carries each Request changes' two answers, from its own run's comment, or null for each when it has none (#369)", () => {
      const { feedback } = evidenceBundle(
        aRetroEvidenceInput({
          facts: factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-05T00:00:00Z", {
                reviews: [
                  aReview("2026-11-02T00:00:00Z", { id: 901, body: "Send the confirmation email the Ticket asks for." }),
                  aReview("2026-11-03T00:00:00Z", { id: 902, body: "Rebase onto main." }),
                  aReview("2026-11-03T01:00:00Z", { id: 903, body: "Its run failed." }),
                ],
                comments: [
                  anAnswersComment(901, { reviewMiss: true, amendsTicket: false }, "2026-11-02T02:00:00Z"),
                  anAnswersComment(902, { reviewMiss: false, amendsTicket: false }, "2026-11-03T02:00:00Z"),
                ],
              }),
            ],
          }),
        }),
      );

      expect(feedback[0]?.items.map((item) => (item.kind === "request-changes" ? [item.body, item.reviewMiss, item.amendsTicket] : null))).toEqual([
        ["Send the confirmation email the Ticket asks for.", true, false],
        ["Rebase onto main.", false, false],
        ["Its run failed.", null, null],
      ]);
    });

    it("holds each run of the Operator's commits in the window as one push, with their messages and patches", () => {
      const patch = (path: string) => `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-old\n+new`;
      const commit = (sha: string, at: string, message: string) => aCommit(at, { sha: sha.repeat(40), message, patch: patch(`src/${sha}.ts`) });
      const { feedback } = evidenceBundle(
        aRetroEvidenceInput({
          facts: factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-05T00:00:00Z", {
                commits: [
                  commit("0", "2026-10-30T00:00:00Z", "Read by the last Retro"),
                  aCommit("2026-11-01T00:00:00Z", { byApp: true }),
                  commit("1", "2026-11-02T01:00:00Z", "Move pricing out of the cart"),
                  commit("2", "2026-11-02T01:05:00Z", "Rename total to subtotal"),
                  aCommit("2026-11-03T00:00:00Z", { byApp: true }),
                  commit("3", "2026-11-04T00:00:00Z", "Test through the cart"),
                  aCommit("2026-11-04T01:00:00Z", { author: "someone", message: "Not the Operator's" }),
                  commit("5", "2026-11-04T02:00:00Z", "Tidy up"),
                ],
              }),
            ],
          }),
        }),
      );
      expect(feedback[0]?.items).toEqual([
        {
          kind: "push",
          at: "2026-11-02T01:05:00Z",
          commits: [
            { sha: "1".repeat(40), message: "Move pricing out of the cart", at: "2026-11-02T01:00:00Z" },
            { sha: "2".repeat(40), message: "Rename total to subtotal", at: "2026-11-02T01:05:00Z" },
          ],
          patch: `${patch("src/1.ts")}\n${patch("src/2.ts")}`,
        },
        {
          kind: "push",
          at: "2026-11-04T00:00:00Z",
          commits: [{ sha: "3".repeat(40), message: "Test through the cart", at: "2026-11-04T00:00:00Z" }],
          patch: patch("src/3.ts"),
        },
        {
          kind: "push",
          at: "2026-11-04T02:00:00Z",
          commits: [{ sha: "5".repeat(40), message: "Tidy up", at: "2026-11-04T02:00:00Z" }],
          patch: patch("src/5.ts"),
        },
      ]);
    });

    it("holds each comment the Operator left in the window, and each review of theirs that isn't a Request changes, though neither is a Human touch", () => {
      const inline = [{ path: "src/cart.ts", line: 3, body: "Nice and small." }];
      const { feedback } = evidenceBundle(
        aRetroEvidenceInput({
          facts: factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-05T00:00:00Z", {
                comments: [
                  aVerdictComment("pass", "a".repeat(40), "2026-11-02T00:00:00Z"), // the App's
                  aComment("I'd have named it subtotal.", "2026-11-03T00:00:00Z", { author: "operator", byBot: false }),
                  aComment("+1", "2026-11-03T01:00:00Z", { author: "someone", byBot: false }),
                  aComment("Read by the last Retro.", "2026-10-30T00:00:00Z", { author: "operator", byBot: false }),
                ],
                reviews: [
                  aReview("2026-11-04T00:00:00Z", { state: "commented", body: "", comments: inline }),
                  aReview("2026-11-04T01:00:00Z", { state: "approved" }), // says nothing
                  aReview("2026-11-04T02:00:00Z", { state: "approved", author: "someone", body: "Looks fine to me." }),
                ],
              }),
            ],
          }),
        }),
      );
      expect(feedback[0]?.items).toEqual([
        { kind: "comment", at: "2026-11-03T00:00:00Z", body: "I'd have named it subtotal.", inline: [] },
        { kind: "comment", at: "2026-11-04T00:00:00Z", body: "", inline },
      ]);
    });

    it("covers agent PRs closed unmerged or still open as well as merged ones, and leaves out a PR with no feedback in the window", () => {
      const operatorSays = (body: string, at: string) => aComment(body, at, { author: "operator", byBot: false });
      const { feedback } = evidenceBundle(
        aRetroEvidenceInput({
          facts: factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-03T00:00:00Z", {
                number: 50,
                commits: [aCommit("2026-11-02T00:00:00Z", { byApp: true })],
                comments: [aVerdictComment("pass", "a".repeat(40), "2026-11-02T01:00:00Z")],
              }),
              aMergedPullRequest("2026-11-04T00:00:00Z", { number: 51, mergedAt: null, mergeSha: null, comments: [operatorSays("Not this way.", "2026-11-03T00:00:00Z")] }),
            ],
            openPullRequests: [
              anOpenPullRequest({ number: 52, title: "Build the till", reviews: [aReview("2026-11-05T00:00:00Z", { body: "Split this up." })] }),
              anOpenPullRequest({ number: 53, commits: [{ at: "2026-11-05T00:00:00Z" }] }),
            ],
          }),
        }),
      );
      expect(feedback.map(({ ref, title, state, items }) => [ref, title, state, items.map((item) => item.kind)])).toEqual([
        ["#51", "Build the thing", "closed", ["comment"]],
        ["#52", "Build the till", "open", ["request-changes"]],
        ["#53", "Build the thing", "open", ["push"]],
      ]);
    });
  });

  describe("Follow-ups", () => {
    it("holds each Follow-up on a pass Verdict of an agent PR merged in the window, with the issue the Operator opened it as", () => {
      const money = { title: "Extract the money type", body: "The cart and the till both round prices." };
      const tax = { title: "Cache the tax table", body: "" };
      const { followUps } = evidenceBundle(
        aRetroEvidenceInput({
          facts: factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-03T00:00:00Z", { number: 50, comments: [aVerdictWithFollowUps("pass", [money, tax], "2026-11-02T00:00:00Z", 50)] }),
              aMergedPullRequest("2026-10-30T00:00:00Z", { number: 51, comments: [aVerdictWithFollowUps("pass", [money], "2026-10-29T00:00:00Z", 51)] }), // the last Retro's
            ],
            followUpIssues: [
              aFollowUpIssue(50, "Extract the money type", { number: 90 }),
              aFollowUpIssue(50, "Cache the tax table", { number: 91, author: "someone" }),
              aFollowUpIssue(49, "Cache the tax table", { number: 92 }),
            ],
          }),
        }),
      );
      expect(followUps).toEqual([
        { ref: "#50", pullRequest: 50, title: "Extract the money type", body: "The cart and the till both round prices.", openedAs: 90 },
        { ref: "#50", pullRequest: 50, title: "Cache the tax table", body: "", openedAs: null },
      ]);
    });

    it("reads them from the Fabrik App's pass Verdicts alone, never a flaw's or a person's quote of one", () => {
      const followUp = { title: "Extract the money type", body: "Rounding repeats." };
      const { followUps } = evidenceBundle(
        aRetroEvidenceInput({
          facts: factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-03T00:00:00Z", {
                comments: [
                  aVerdictWithFollowUps("execution-flaw", [followUp], "2026-11-01T00:00:00Z", 50),
                  aVerdictWithFollowUps("pass", [followUp], "2026-11-02T00:00:00Z", 50, { author: "operator", byBot: false }),
                ],
              }),
            ],
          }),
        }),
      );
      expect(followUps).toEqual([]);
    });
  });

  describe("low scores", () => {
    const failing = aScoreEntry({ score: 0.4, pass: false, label: "re-reads", rationale: "Read src/cart.ts four times (#2, #5, #9, #12)." });
    const passing = aScoreEntry({ scorer: "ticket-compliance", threshold: 0.8, score: 0.9, label: "compliant", rationale: "Built what was asked." });

    it("holds each score file whose run ended in the window with a failing entry, by its score path, with every entry and the run's transcript digest", () => {
      const transcript = aTranscript({ "src/cart.ts": "export const cart = [];" });
      const flailed = aRecordWithTranscript({ runId: 1000, endedAt: "2026-11-03T00:00:00Z" });
      const clean = aRecordWithTranscript({ runId: 1001, endedAt: "2026-11-03T00:00:00Z" });
      const lastWeeks = aRecordWithTranscript({ runId: 1002, endedAt: "2026-10-30T23:00:00Z" });
      const skipped = aRecordWithTranscript({ runId: 1003, endedAt: "2026-11-03T00:00:00Z" });
      const theirs = aRecordWithTranscript({ repo: "owner/other", runId: 1004, endedAt: "2026-11-03T00:00:00Z" });
      const { lowScores } = evidenceBundle(
        aRetroEvidenceInput({
          records: [flailed, clean, lastWeeks, skipped, theirs],
          readTranscript: transcriptsOf([flailed, transcript], [clean, transcript], [lastWeeks, transcript], [skipped, transcript], [theirs, transcript]),
          scoreFiles: {
            "scores/owner/product/2026-11/1000-1-implement-a1b2c3.json": aScoreFile({ runId: 1000, entries: [failing, passing] }),
            "scores/owner/product/2026-11/1001-1-implement-a1b2c3.json": aScoreFile({ runId: 1001, entries: [passing] }),
            // Scored the morning after it ended, inside the window: it's the run's end that counts.
            "scores/owner/product/2026-10/1002-1-implement-a1b2c3.json": aScoreFile({ runId: 1002, scoredAt: "2026-10-31T09:00:00Z", entries: [failing] }),
            "scores/owner/product/2026-11/1003-1-implement-a1b2c3.json": aSkippedScoreFile({ reason: "judge-failed" }, { runId: 1003 }),
            "scores/owner/other/2026-11/1004-1-implement-a1b2c3.json": aScoreFile({ repo: "owner/other", runId: 1004, entries: [failing] }),
          },
        }),
      );
      expect(lowScores).toEqual([
        {
          ref: "scores/owner/product/2026-11/1000-1-implement-a1b2c3.json",
          run: { ref: "runs/owner/product/2026-11/1000-1-implement.json", record: flailed, digest: theJudgesDigestOf(transcript) },
          entries: [
            { scorer: "efficiency", score: 0.4, pass: false, label: "re-reads", rationale: "Read src/cart.ts four times (#2, #5, #9, #12)." },
            { scorer: "ticket-compliance", score: 0.9, pass: true, label: "compliant", rationale: "Built what was asked." },
          ],
        },
      ]);
    });

    it("goes by when a run was scored when the store holds no record of it, and gives it no digest", () => {
      const { lowScores } = evidenceBundle(
        aRetroEvidenceInput({
          scoreFiles: {
            "scores/owner/product/2026-11/1000-1-implement-a1b2c3.json": aScoreFile({ runId: 1000, scoredAt: "2026-11-03T00:05:00Z", entries: [failing] }),
            "scores/owner/product/2026-10/1001-1-implement-a1b2c3.json": aScoreFile({ runId: 1001, scoredAt: "2026-10-30T00:05:00Z", entries: [failing] }),
          },
        }),
      );
      expect(lowScores.map(({ ref, run }) => ({ ref, run }))).toEqual([{ ref: "scores/owner/product/2026-11/1000-1-implement-a1b2c3.json", run: null }]);
    });

    it("leaves out a Replay arm's score file, however low it scored: live scores are about live work", () => {
      const arm = aReplayRunRecord({ endedAt: "2026-11-03T00:00:00Z" });
      const { lowScores } = evidenceBundle(
        aRetroEvidenceInput({
          records: [arm],
          scoreFiles: {
            "scores/owner/product/2026-11/2000-1-implement-replay-baseline-a1b2c3.json": aScoreFile({ runId: 2000, replay: A_REPLAY, entries: [failing] }),
            "scores/owner/product/2026-11/1000-1-implement-a1b2c3.json": aScoreFile({ runId: 1000, scoredAt: "2026-11-03T00:05:00Z", entries: [failing] }),
          },
        }),
      );
      expect(lowScores.map(({ ref }) => ref)).toEqual(["scores/owner/product/2026-11/1000-1-implement-a1b2c3.json"]);
    });

    it("holds none when the repo has no score files", () => {
      const run = aRecordWithTranscript({ runId: 1000, endedAt: "2026-11-03T00:00:00Z" });
      const { lowScores } = evidenceBundle(aRetroEvidenceInput({ records: [run], readTranscript: transcriptsOf([run, aTranscript()]), scoreFiles: {} }));
      expect(lowScores).toEqual([]);
    });
  });

  describe("the sample", () => {
    // Of owner/product's PRs 1 to 110, the SHA-256 of `owner/product#<n>` falls in the lowest tenth of the range for 12, 28, 33, 40, 68, 81 and 102 alone.
    const merged = (numbers: readonly number[], mergedAt = "2026-11-03T00:00:00Z") =>
      numbers.map((number) => aMergedPullRequest(mergedAt, { number, ticket: number + 1000, title: `Build thing ${number}` }));
    const sampleOf = (pullRequests: readonly AgentPullRequestFacts[]) =>
      evidenceBundle(aRetroEvidenceInput({ facts: factsOf({ pullRequests }) })).sample.map(({ number }) => number);
    const upTo = (last: number) => Array.from({ length: last }, (_, i) => i + 1);

    it("holds the agent PRs merged in the window whose SHA-256 of owner/repo#n falls in the lowest tenth of the range", () => {
      const pullRequests = [
        ...merged(upTo(60)),
        ...merged([68], "2026-10-30T23:59:59Z"), // before the window
        ...merged([81], "2026-11-07T00:00:00Z"), // at its end: after it
        aMergedPullRequest("2026-11-03T00:00:00Z", { number: 102, mergedAt: null, mergeSha: null }), // closed unmerged
      ];
      expect(sampleOf(pullRequests)).toEqual([12, 28, 33, 40]);
    });

    it("samples the same PRs however often it's computed, in whatever order the facts come, whatever else merged", () => {
      const first = sampleOf(merged(upTo(200)));
      expect(sampleOf(merged(upTo(200)))).toEqual(first);
      expect(sampleOf(merged(upTo(400).toReversed())).filter((number) => number <= 200)).toEqual(first);
    });

    it("samples about one in ten over a large set", () => {
      const sampled = sampleOf(merged(upTo(2000))).length;
      expect(sampled).toBeGreaterThan(150);
      expect(sampled).toBeLessThan(250);
    });

    it("carries each sampled PR's Ticket with its title and body, its Verdicts as the Fabrik App posted them, and the agent runs on its Ticket with their transcripts' digests", () => {
      const transcript = aTranscript({ "src/cart.ts": "export const cart = [];" });
      const implement = aRecordWithTranscript({ runId: 1000, issue: 7, pullRequest: 12, endedAt: "2026-11-01T00:00:00Z" });
      const review = aRecordWithTranscript({ runId: 1001, role: "review", issue: 7, pullRequest: 12, verdict: "pass", endedAt: "2026-11-02T00:00:00Z" });
      const judge = aRecordWithTranscript({ runId: 1000, role: "score", issue: 7, pullRequest: 12, endedAt: "2026-11-01T00:05:00Z" });
      const untranscribed = aRunRecord({ runId: 999, issue: 7, pullRequest: 12, endedAt: "2026-10-31T12:00:00Z" });
      const verdict = aVerdictComment("pass", "a".repeat(40), "2026-11-02T00:00:00Z");
      const { sample } = evidenceBundle(
        aRetroEvidenceInput({
          records: [review, judge, implement, untranscribed, aRunRecord({ runId: 1002, issue: 8, pullRequest: 13 })],
          readTranscript: transcriptsOf([implement, transcript], [review, transcript], [judge, transcript]),
          facts: factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-03T00:00:00Z", {
                number: 12,
                ticket: 7,
                title: "Build the cart",
                comments: [
                  verdict,
                  aVerdictComment("design-flaw", "a".repeat(40), "2026-11-02T01:00:00Z", { author: "operator", byBot: false }), // a person's quote of one
                  aComment("Please rename this.", "2026-11-02T02:00:00Z", { author: "operator", byBot: false }),
                ],
              }),
            ],
          }),
          tickets: [{ number: 7, title: "Build the cart", body: "A cart that totals its lines." }],
        }),
      );
      expect(sample).toEqual([
        {
          ref: "#12",
          number: 12,
          title: "Build the cart",
          mergedAt: "2026-11-03T00:00:00Z",
          ticket: { ref: "#7", number: 7, title: "Build the cart", body: "A cart that totals its lines." },
          verdicts: [{ verdict: "pass", source: "reviewer", at: "2026-11-02T00:00:00Z", body: verdict.body }],
          records: [
            { ref: "runs/owner/product/2026-10/999-1-implement.json", record: untranscribed, digest: null },
            { ref: "runs/owner/product/2026-11/1000-1-implement.json", record: implement, digest: theJudgesDigestOf(transcript) },
            { ref: "runs/owner/product/2026-11/1001-1-review.json", record: review, digest: theJudgesDigestOf(transcript) },
          ],
        },
      ]);
    });
  });

  it("marks a sampled PR's Verdict counted back for a Flaky check, and no other (#462)", () => {
    const flaw = aVerdictComment("execution-flaw", "a".repeat(40), "2026-11-01T00:00:00Z", {
      body: `<!-- fabrik:verdict {"verdict":"execution-flaw","source":"ci","requestChanges":false,"checks":["e2e"],"headSha":"${"a".repeat(40)}"} -->\nRed.`,
    });
    const pass = aVerdictComment("pass", "b".repeat(40), "2026-11-02T00:00:00Z");
    const countedBack = aComment(`<!-- fabrik:flaky-check {"headSha":"${"a".repeat(40)}","checks":["e2e"],"countedBack":true} -->\nFlaky.`, "2026-11-01T05:00:00Z");
    const { sample } = evidenceBundle(
      aRetroEvidenceInput({
        facts: factsOf({ pullRequests: [aMergedPullRequest("2026-11-03T00:00:00Z", { number: 12, ticket: 7, comments: [flaw, countedBack, pass] })] }),
        tickets: [{ number: 7, title: "Build the cart", body: "A cart." }],
      }),
    );

    expect(sample[0]?.verdicts).toEqual([
      { verdict: "execution-flaw", source: "ci", at: "2026-11-01T00:00:00Z", body: flaw.body, flaky: true },
      { verdict: "pass", source: "reviewer", at: "2026-11-02T00:00:00Z", body: pass.body },
    ]);
  });

  describe("the streak table", () => {
    it("lists every agent PR merged in the 90 days to the window's end, oldest first, with the paths it changed", () => {
      const { streakTable } = evidenceBundle(
        aRetroEvidenceInput({
          facts: factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-06T00:00:00Z", { number: 53, title: "Build the till", changedPaths: ["src/till.ts"] }),
              aMergedPullRequest("2026-08-09T00:00:00Z", { number: 50, title: "Build the cart", changedPaths: ["src/cart.ts", "src/cart.test.ts"] }), // 90 days before
              aMergedPullRequest("2026-08-08T23:59:59Z", { number: 49 }),
              aMergedPullRequest("2026-11-07T00:00:00Z", { number: 54 }), // the next Retro's
              aMergedPullRequest("2026-11-01T00:00:00Z", { number: 52, mergedAt: null, mergeSha: null }), // closed unmerged
            ],
          }),
        }),
      );
      expect(streakTable).toEqual([
        {
          ref: "#50",
          number: 50,
          title: "Build the cart",
          mergedAt: "2026-08-09T00:00:00Z",
          paths: ["src/cart.ts", "src/cart.test.ts"],
          escaped: false,
          reverted: false,
          requestChanges: false,
        },
        { ref: "#53", number: 53, title: "Build the till", mergedAt: "2026-11-06T00:00:00Z", paths: ["src/till.ts"], escaped: false, reverted: false, requestChanges: false },
      ]);
    });

    it("flags each one an Operator's escape named, a revert reverted or the Operator sent a Request changes", () => {
      const merged = (number: number, overrides: Partial<AgentPullRequestFacts> = {}) =>
        aMergedPullRequest("2026-09-01T00:00:00Z", { number, title: `Build thing ${number}`, mergeSha: String(number).repeat(20), ...overrides });
      const { streakTable } = evidenceBundle(
        aRetroEvidenceInput({
          facts: factsOf({
            pullRequests: [
              merged(50),
              merged(51),
              merged(52),
              merged(53),
              merged(54, { reviews: [aReview("2026-08-31T00:00:00Z")] }),
              merged(55, { reviews: [aReview("2026-08-31T00:00:00Z", { author: "someone" }), aReview("2026-08-31T01:00:00Z", { state: "approved" })] }),
              merged(56),
            ],
            escapeMarkerIssues: [
              anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->", { number: 80, createdAt: "2026-10-01T00:00:00Z" }),
              anEscapeMarkerIssue("<!-- fabrik:escape strong #51 -->", { number: 81, createdAt: "2026-10-01T00:00:00Z", author: "someone" }),
            ],
            defaultBranchCommits: [{ message: `Revert "Build thing 52"\n\nThis reverts commit ${"52".repeat(20)}.`, at: "2026-09-10T00:00:00Z" }],
            mergedPullRequestTitles: [{ title: 'Revert "Build thing 53"', mergedAt: "2026-09-12T00:00:00Z" }],
          }),
        }),
      );
      expect(streakTable.map(({ number, escaped, reverted, requestChanges }) => [number, { escaped, reverted, requestChanges }])).toEqual([
        [50, { escaped: true, reverted: false, requestChanges: false }],
        [51, { escaped: false, reverted: false, requestChanges: false }],
        [52, { escaped: false, reverted: true, requestChanges: false }],
        [53, { escaped: false, reverted: true, requestChanges: false }],
        [54, { escaped: false, reverted: false, requestChanges: true }],
        [55, { escaped: false, reverted: false, requestChanges: false }],
        [56, { escaped: false, reverted: false, requestChanges: false }],
      ]);
    });
  });

  describe("history", () => {
    it("holds the last 3 closed Retros whose run didn't fail, newest first, with the Operator's comments on them", () => {
      const retro = (number: number, windowEnd: string, overrides: Partial<RetroIssueFacts> = {}) =>
        aPastRetro({ number, title: `Retro ${number}`, createdAt: windowEnd, body: retroBody(windowEnd), ...overrides });
      const { history } = evidenceBundle(
        aRetroEvidenceInput({
          retros: [
            retro(95, "2026-10-03T00:00:00.000Z"),
            retro(96, "2026-10-10T00:00:00.000Z", {
              stateReason: "not_planned",
              comments: [
                aComment("No: we lint that already.", "2026-10-11T00:00:00Z", { author: "operator", byBot: false }),
                aComment("Agreed.", "2026-10-11T01:00:00Z", { author: "someone", byBot: false }),
                aComment("A bot's note.", "2026-10-11T02:00:00Z"),
              ],
            }),
            retro(97, "2026-10-17T00:00:00.000Z", { stateReason: "not_planned", body: retroBody("2026-10-17T00:00:00.000Z", "failed") }),
            retro(98, "2026-10-24T00:00:00.000Z"),
            retro(99, "2026-10-26T00:00:00.000Z", { byApp: false }), // a person's
            retro(100, "2026-10-31T00:00:00.000Z"),
            theRetroBeingFilled("2026-11-07T00:00:00.000Z"),
          ],
        }),
      );
      expect(history.retros).toEqual([
        { ref: "#100", number: 100, title: "Retro 100", closedAs: "completed", body: retroBody("2026-10-31T00:00:00.000Z"), operatorComments: [] },
        { ref: "#98", number: 98, title: "Retro 98", closedAs: "completed", body: retroBody("2026-10-24T00:00:00.000Z"), operatorComments: [] },
        {
          ref: "#96",
          number: 96,
          title: "Retro 96",
          closedAs: "not_planned",
          body: retroBody("2026-10-10T00:00:00.000Z"),
          operatorComments: [{ at: "2026-10-11T00:00:00Z", body: "No: we lint that already." }],
        },
      ]);
    });

    it("leaves out a Retro the Operator hasn't closed yet", () => {
      const { history } = evidenceBundle(aRetroEvidenceInput({ retros: [aPastRetro({ number: 100, open: true, stateReason: null }), theRetroBeingFilled("2026-11-07T00:00:00.000Z")] }));
      expect(history.retros).toEqual([]);
    });

    it("holds the open issues filed from a Retro's proposal, by their From retro #n line, with their titles and bodies", () => {
      const filed = `Add a lint rule for floating promises.\n\n${fromRetroLine(100)}`;
      const { history } = evidenceBundle(
        aRetroEvidenceInput({
          fromRetroIssues: [
            { number: 130, title: "Lint floating promises", body: filed },
            { number: 131, title: "Quoted", body: `\`\`\`\n${fromRetroLine(100)}\n\`\`\`` },
            { number: 132, title: "Unrelated", body: "From the Operator's own list." },
          ],
        }),
      );
      expect(history.filed).toEqual([{ ref: "#130", number: 130, title: "Lint floating promises", body: filed, retro: 100 }]);
    });

    // The Kit's repo and a Skills source get the trailer naming the Product repo, as a bare #n there would link to their own issue.
    it("holds those open on another repo whose From retro line names this Product repo, each by its repo-qualified ref, and only those", () => {
      const kit = `Read #140 first.\n\n${fromRetroLine(100, "owner/product")}`;
      const { history } = evidenceBundle(
        aRetroEvidenceInput({
          fromRetroIssues: [
            { repo: "jrey8343/fabrik", number: 230, title: "Check route imports in review", body: kit },
            { repo: "jrey8343/fabrik", number: 231, title: "Another Product repo's", body: fromRetroLine(100, "owner/other") },
            { repo: "jrey8343/fabrik", number: 232, title: "A bare trailer, naming the Kit's own Retro", body: fromRetroLine(100) },
            { repo: "Owner/Skills", number: 12, title: "Route handlers skill", body: fromRetroLine(99, "Owner/Product") },
            { number: 133, title: "Filed here, naming this repo", body: fromRetroLine(98, "owner/product") },
          ],
        }),
      );
      expect(history.filed).toEqual([
        { ref: "jrey8343/fabrik#230", number: 230, title: "Check route imports in review", body: kit, retro: 100 },
        { ref: "Owner/Skills#12", number: 12, title: "Route handlers skill", body: fromRetroLine(99, "Owner/Product"), retro: 99 },
        { ref: "#133", number: 133, title: "Filed here, naming this repo", body: fromRetroLine(98, "owner/product"), retro: 98 },
      ]);
      expect(refsOf(evidenceBundle(aRetroEvidenceInput({ fromRetroIssues: [{ repo: "jrey8343/fabrik", number: 230, title: "", body: kit }] })))).toContainEqual({
        ref: "jrey8343/fabrik#230",
        kind: "issue",
      });
    });
  });

  describe("the budget", () => {
    // Four things the budget may cut, each 60,000 characters long: a sampled PR's run's transcript, a low-scoring run's,
    // an Operator push's patch and an escape's passing Review run's. A Request changes body, which it never cuts, makes the rest.
    const bulk = (char: string) => char.repeat(60_000);
    const sampled = aRecordWithTranscript({ runId: 1000, issue: 7, pullRequest: 12, endedAt: "2026-11-01T00:00:00Z" });
    const lowScoring = aRecordWithTranscript({ runId: 2000, issue: 9, pullRequest: 13, endedAt: "2026-11-01T00:00:00Z" });
    const passingReview = aRecordWithTranscript({ runId: 3000, role: "review", issue: 10, pullRequest: 14, verdict: "pass", endedAt: "2026-11-01T00:00:00Z" });
    const patch = `diff --git a/src/cart.ts b/src/cart.ts\n${bulk("p")}`;
    const inline = [{ path: "src/cart.ts", line: 12, body: "This belongs in the pricing module." }];
    const verdict = aVerdictComment("pass", "a".repeat(40), "2026-11-02T00:00:00Z");

    const transcripts = transcriptsOf(
      [sampled, aTranscript({ "src/sampled.ts": bulk("s") })],
      [lowScoring, aTranscript({ "src/low.ts": bulk("l") })],
      [passingReview, aTranscript({ "src/escaped.ts": bulk("e") })],
    );

    function evidenceWith(requestChanges: string, readTranscript = transcripts): EvidenceBundle {
      return evidenceBundle(
        aRetroEvidenceInput({
          records: [sampled, lowScoring, passingReview],
          readTranscript,
          scoreFiles: { "scores/owner/product/2026-11/2000-1-implement-a1b2c3.json": aScoreFile({ runId: 2000, entries: [aScoreEntry({ score: 0.2, pass: false })] }) },
          facts: factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-03T00:00:00Z", { number: 12, ticket: 7, comments: [verdict] }), // in the sample
              aMergedPullRequest("2026-11-03T00:00:00Z", {
                number: 13,
                ticket: 9,
                commits: [aCommit("2026-11-02T00:00:00Z", { message: "Move pricing out of the cart", patch })],
                reviews: [aReview("2026-11-02T01:00:00Z", { body: requestChanges, comments: inline })],
              }),
              aMergedPullRequest("2026-11-03T00:00:00Z", { number: 14, ticket: 10 }),
            ],
            escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #14 -->", { number: 81 })],
          }),
        }),
      );
    }

    // The bundle whole, as JSON, `over` characters over the budget.
    const whole = evidenceWith("");
    const overBy = (over: number) => evidenceWith("r".repeat(EVIDENCE_BUDGET - JSON.stringify(whole).length + over));

    const CUT = /\[… \d+ characters cut …\]/;
    const GONE = /^\[… \d+ characters cut …\]$/;
    type Left = "whole" | "cut" | "gone" | "missing";
    const leftOfDigest = (digest: string | null | undefined): Left =>
      digest == null ? "missing" : GONE.test(digest) ? "gone" : CUT.test(digest) ? (digest.includes('#1 Read {"file_path":') ? "cut" : "gone") : "whole";
    const leftOfPatch = (cut: string | undefined): Left => (cut === patch ? "whole" : cut !== undefined && GONE.test(cut) ? "gone" : "cut");
    function leftIn(bundle: EvidenceBundle) {
      const push = bundle.feedback.flatMap(({ items }) => items).find((item) => item.kind === "push");
      return {
        sample: leftOfDigest(bundle.sample[0]?.records[0]?.digest),
        lowScores: leftOfDigest(bundle.lowScores[0]?.run?.digest),
        patches: leftOfPatch(push?.kind === "push" ? push.patch : undefined),
        escapes: leftOfDigest(bundle.escapes[0]?.pullRequests[0]?.lastPassingReview?.digest),
      };
    }

    it("gives the bundle whole when it's within the budget, and says it wasn't trimmed", () => {
      const bundle = overBy(0);
      expect(JSON.stringify(bundle).length).toBe(EVIDENCE_BUDGET);
      expect(leftIn(bundle)).toEqual({ sample: "whole", lowScores: "whole", patches: "whole", escapes: "whole" });
      expect(bundle.trimmed).toBe(false);
    });

    it.each([
      { over: 30_000, left: { sample: "cut", lowScores: "whole", patches: "whole", escapes: "whole" } },
      { over: 90_000, left: { sample: "gone", lowScores: "cut", patches: "whole", escapes: "whole" } },
      { over: 150_000, left: { sample: "gone", lowScores: "gone", patches: "cut", escapes: "whole" } },
      { over: 210_000, left: { sample: "gone", lowScores: "gone", patches: "gone", escapes: "cut" } },
    ])("$over characters over, cuts the sample's transcripts first and escapes' last, each cut marked in place, until it fits", ({ over, left }) => {
      const bundle = overBy(over);
      expect(leftIn(bundle)).toEqual(left);
      expect(JSON.stringify(bundle).length).toBeLessThanOrEqual(EVIDENCE_BUDGET);
      expect(bundle.trimmed).toBe(true);
    });

    it("reads each run's transcript from the store once, however often it digests it again to fit", () => {
      const reads: string[] = [];
      const counting = (path: string) => {
        reads.push(path);
        return transcripts(path);
      };

      const bundle = evidenceWith("r".repeat(EVIDENCE_BUDGET - JSON.stringify(whole).length + 150_000), counting);

      expect(bundle.trimmed).toBe(true);
      expect(reads.toSorted()).toEqual([sampled, lowScoring, passingReview].map(({ transcript }) => transcript).toSorted());
    });

    it("keeps a cut transcript's tool calls, as the judge's digest does, until it has to cut the transcript whole", () => {
      const digest = overBy(30_000).sample[0]?.records[0]?.digest ?? "";
      expect(digest).toMatch(/^#1 Read \{"file_path":"src\/sampled.ts"\}\n#1 result: s+\[… \d+ characters cut …\]s+$/m);
    });

    it("never cuts refs, Verdicts, review comments or the streak table, however far over it is", () => {
      const requestChanges = "r".repeat(EVIDENCE_BUDGET);
      const bundle = evidenceWith(requestChanges);
      expect(leftIn(bundle)).toEqual({ sample: "gone", lowScores: "gone", patches: "gone", escapes: "gone" });
      expect(bundle.trimmed).toBe(true);
      expect(refsOf(bundle)).toEqual(refsOf(whole));
      expect(bundle.sample[0]?.verdicts).toEqual([{ verdict: "pass", source: "reviewer", at: "2026-11-02T00:00:00Z", body: verdict.body }]);
      expect(bundle.feedback[0]?.items).toContainEqual({
        kind: "request-changes",
        at: "2026-11-02T01:00:00Z",
        body: requestChanges,
        inline,
        reviewMiss: null,
        amendsTicket: null,
      });
      expect(bundle.streakTable).toEqual(whole.streakTable);
      expect(bundle.streakTable.map(({ number }) => number)).toEqual([12, 13, 14]);
    });

    it("says it was trimmed only when it cut something: over the budget with nothing it may cut, it isn't", () => {
      const requestChanges = "r".repeat(EVIDENCE_BUDGET);
      const bundle = evidenceBundle(
        aRetroEvidenceInput({ facts: factsOf({ pullRequests: [aMergedPullRequest("2026-11-03T00:00:00Z", { number: 13, reviews: [aReview("2026-11-02T01:00:00Z", { body: requestChanges })] })] }) }),
      );
      expect(JSON.stringify(bundle).length).toBeGreaterThan(EVIDENCE_BUDGET);
      expect(bundle.feedback[0]?.items[0]).toMatchObject({ body: requestChanges });
      expect(bundle.trimmed).toBe(false);
    });
  });

  describe("refs", () => {
    it("lists every ref the bundle's items carry, once each, by what it cites", () => {
      const review = aRunRecord({ runId: 1001, role: "review", verdict: "pass", endedAt: "2026-11-01T00:00:00Z" });
      const bundle = evidenceBundle(
        aRetroEvidenceInput({
          records: [review],
          facts: factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-02T00:00:00Z", {
                number: 50,
                ticket: 7,
                comments: [aVerdictWithFollowUps("pass", [{ title: "Extract the money type", body: "" }], "2026-11-01T00:00:00Z", 50)],
              }),
              aMergedPullRequest("2026-11-03T00:00:00Z", { number: 51, mergedAt: null, mergeSha: null, reviews: [aReview("2026-11-02T00:00:00Z")] }),
            ],
            escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #50 -->", { number: 80 })],
            followUpIssues: [aFollowUpIssue(50, "Extract the money type", { number: 90 })],
          }),
          retros: [aPastRetro({ number: 100, body: retroBody("2026-10-31T00:00:00.000Z") }), theRetroBeingFilled("2026-11-07T00:00:00.000Z")],
          fromRetroIssues: [{ number: 130, title: "Lint floating promises", body: fromRetroLine(100) }],
        }),
      );
      expect(refsOf(bundle)).toEqual([
        { ref: "#80", kind: "escape" },
        { ref: "#50", kind: "pull-request" },
        { ref: "#7", kind: "issue" },
        { ref: "runs/owner/product/2026-11/1001-1-review.json", kind: "record" },
        { ref: "#51", kind: "pull-request" },
        { ref: "#90", kind: "issue" },
        { ref: "#100", kind: "issue" },
        { ref: "#130", kind: "issue" },
      ]);
    });

    it("lists each low score by its score path, with its run's record, and each sampled PR with its Ticket and records", () => {
      const implement = aRunRecord({ runId: 1000, issue: 7, pullRequest: 12, endedAt: "2026-11-01T00:00:00Z" });
      const review = aRunRecord({ runId: 1001, role: "review", issue: 7, pullRequest: 12, verdict: "pass", endedAt: "2026-11-02T00:00:00Z" });
      const bundle = evidenceBundle(
        aRetroEvidenceInput({
          records: [implement, review],
          scoreFiles: { "scores/owner/product/2026-11/1000-1-implement-a1b2c3.json": aScoreFile({ runId: 1000, entries: [aScoreEntry({ score: 0.2, pass: false })] }) },
          // #12 is in the sample.
          facts: factsOf({ pullRequests: [aMergedPullRequest("2026-11-03T00:00:00Z", { number: 12, ticket: 7 })] }),
        }),
      );
      expect(refsOf(bundle)).toEqual([
        { ref: "scores/owner/product/2026-11/1000-1-implement-a1b2c3.json", kind: "score" },
        { ref: "runs/owner/product/2026-11/1000-1-implement.json", kind: "record" },
        { ref: "#12", kind: "pull-request" },
        { ref: "#7", kind: "issue" },
        { ref: "runs/owner/product/2026-11/1001-1-review.json", kind: "record" },
        { ref: "#80", kind: "issue" }, // the last Retro
      ]);
    });
  });
});
