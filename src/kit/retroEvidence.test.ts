import { describe, expect, it } from "vitest";
import { aRetroEvidenceInput, aVerdictWithFollowUps } from "../__fixtures__/retroEvidence.ts";
import {
  aComment,
  aCommit,
  aFollowUpIssue,
  anEscapeMarkerIssue,
  aLabelAdded,
  aMergedPullRequest,
  anOpenPullRequest,
  aReview,
  aRunRecord,
  aTicketTimeline,
  aVerdictComment,
  factsOf,
} from "../__fixtures__/weeklySummary.ts";
import type { Verdict } from "../loop/types.ts";
import { type AgentPullRequestFacts, type CommentFacts, escapesIn, evidenceBundle, mergedAgentPullRequestsIn, verdictsOn } from "./retroEvidence.ts";

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
      const { window } = evidenceBundle(aRetroEvidenceInput({ lastWindowEnd: "2026-11-01T09:30:00Z", windowEnd: "2026-11-07T10:00:00Z" }));
      expect(window).toEqual({ start: "2026-11-01T09:30:00.000Z", end: "2026-11-07T10:00:00.000Z" });
    });

    it("covers the 7 days before this one's end on a first run", () => {
      const { window } = evidenceBundle(aRetroEvidenceInput({ lastWindowEnd: null, windowEnd: "2026-11-07T10:00:00Z" }));
      expect(window).toEqual({ start: "2026-10-31T10:00:00.000Z", end: "2026-11-07T10:00:00.000Z" });
    });
  });

  // The window, unless a test says otherwise: Saturday 2026-10-31 00:00 UTC to Saturday 2026-11-07.

  describe("Architectural escapes", () => {
    it("holds each escape the Operator opened in the window, with its body and the agent PRs merged in the 90 days to its end that it names", () => {
      const { escapes } = evidenceBundle(
        aRetroEvidenceInput({
          facts: factsOf({
            pullRequests: [
              aMergedPullRequest("2026-11-02T00:00:00Z", { number: 50, ticket: 7, title: "Build the cart" }),
              aMergedPullRequest("2026-09-01T00:00:00Z", { number: 51, ticket: 8, title: "Build the till" }), // 67 days before the window's end
              aMergedPullRequest("2026-08-01T00:00:00Z", { number: 52, ticket: 9 }), // 98 days before it
            ],
            escapeMarkerIssues: [
              anEscapeMarkerIssue("The cart leaks its rules.\n\n<!-- fabrik:escape strong #50 #51 #52 -->", { number: 80, createdAt: "2026-11-03T00:00:00Z" }),
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
          body: "The cart leaks its rules.\n\n<!-- fabrik:escape strong #50 #51 #52 -->",
          strength: "strong",
          pullRequests: [
            ["#50", "Build the cart"],
            ["#51", "Build the till"],
          ],
        },
      ]);
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

    it("carries each PR's Ticket, the Run records on it and the last passing Review record on the PR, each by its record path", () => {
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
        }),
      );
      expect(escapes[0]?.pullRequests).toEqual([
        {
          ref: "#50",
          number: 50,
          title: "Build the thing",
          ticket: 7,
          records: [
            { ref: "runs/owner/product/2026-10/1000-1-implement.json", record: implement },
            { ref: "runs/owner/product/2026-10/1001-1-review.json", record: firstPass },
            { ref: "runs/owner/product/2026-11/1002-1-implement.json", record: retry },
            { ref: "runs/owner/product/2026-11/1003-1-review.json", record: lastPass },
          ],
          lastPassingReview: { ref: "runs/owner/product/2026-11/1003-1-review.json", record: lastPass },
        },
        { ref: "#51", number: 51, title: "Build the thing", ticket: null, records: [], lastPassingReview: null },
      ]);
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
          items: [{ kind: "request-changes", at: "2026-11-02T00:00:00Z", body: "Keep pricing out of the cart.", inline }],
        },
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
});
