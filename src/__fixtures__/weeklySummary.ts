// Small builders for the Weekly summary's tests, matching anIssue, aPullRequest
// and snapshotOf (./snapshots.ts): say only what a test cares about.
import type { RunRecord } from "../kit/runRecord.ts";
import type { AgentPullRequestFacts, CommitFacts, GitHubFacts, LabelEvent, ReviewFacts, TicketFacts } from "../kit/weeklySummary.ts";

/** A passing first Implement run on Ticket 7 in `owner/product`, costing $1, ended at `endedAt`. */
export function aRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schema: 1,
    kitSha: "f".repeat(40),
    repo: "owner/product",
    runId: 1000,
    runAttempt: 1,
    role: "implement",
    issue: 7,
    pullRequest: 50,
    endedAt: "2026-11-04T12:00:00Z",
    model: "claude-opus-5-5",
    effort: null,
    retry: 0,
    stepUp: false,
    requestChanges: false,
    baseSha: "b".repeat(40),
    jobResult: "success",
    subtype: "success",
    isError: false,
    terminalReason: "completed",
    infrastructureFailure: null,
    verdict: null,
    durationMs: 90_000,
    apiDurationMs: 60_000,
    turns: 12,
    permissionDenials: 0,
    apiRetries: 0,
    totalCostUsd: 1,
    modelUsage: {},
    rateLimit: null,
    transcript: null,
    ...overrides,
  };
}

/** An agent PR the Fabrik App opened for Ticket 7, merged at `mergedAt`. */
export function aMergedPullRequest(mergedAt: string, overrides: Partial<AgentPullRequestFacts> = {}): AgentPullRequestFacts {
  return {
    number: 50,
    ticket: 7,
    title: "Build the thing",
    mergedAt,
    mergeSha: "c".repeat(40),
    commits: [],
    reviews: [],
    comments: [],
    labelEvents: [],
    ...overrides,
  };
}

/** The Operator requesting changes at `at`. */
export function aReview(at: string, overrides: Partial<ReviewFacts> = {}): ReviewFacts {
  return { author: "operator", state: "changes-requested", at, ...overrides };
}

/** A commit someone other than the Fabrik App made at `at`. */
export function aCommit(at: string, overrides: Partial<CommitFacts> = {}): CommitFacts {
  return { byApp: false, at, ...overrides };
}

/** The App adding `label` at `at`. */
export function aLabelAdded(label: string, at: string, overrides: Partial<LabelEvent> = {}): LabelEvent {
  return { label, action: "labeled", actor: "fabrik-app[bot]", at, ...overrides };
}

/** Ticket 7 with this label timeline, blocked by nothing. */
export function aTicketTimeline(labelEvents: readonly LabelEvent[], overrides: Partial<TicketFacts> = {}): TicketFacts {
  return { number: 7, labelEvents, blockedBy: [], ...overrides };
}

/** The GitHub facts of `owner/product`, with nothing in them unless a test says so. */
export function factsOf(overrides: Partial<GitHubFacts> = {}): GitHubFacts {
  return { repo: "owner/product", pullRequests: [], tickets: [], defaultBranchCommits: [], mergedPullRequestTitles: [], ...overrides };
}
