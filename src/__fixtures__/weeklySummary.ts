// Small builders for the Weekly summary's tests, matching anIssue, aPullRequest
// and snapshotOf (./snapshots.ts): say only what a test cares about.
import type { RunRecord } from "../kit/runRecord.ts";
import type {
  AgentPullRequestFacts,
  CommentFacts,
  CommitFacts,
  GitHubFacts,
  LabelEvent,
  OpenIssueFacts,
  OpenPullRequestFacts,
  ReviewFacts,
  SpecFacts,
  TicketFacts,
} from "../kit/weeklySummary.ts";
import { designRoundMarker, verdictMarker } from "../loop/markers.ts";
import type { Verdict } from "../loop/types.ts";

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

/** A run's cost fields when one of its models has an unknown cost basis: no figure for it, and no total. */
export const UNKNOWN_COST_BASIS: Pick<RunRecord, "totalCostUsd" | "modelUsage"> = {
  totalCostUsd: null,
  modelUsage: {
    "claude-unpriced": { inputTokens: 10, outputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: null, costBasis: "unknown" },
  },
};

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

/** Ticket 7, still open, with this label timeline, blocked by nothing. */
export function aTicketTimeline(labelEvents: readonly LabelEvent[], overrides: Partial<TicketFacts> = {}): TicketFacts {
  return { number: 7, labelEvents, closedAt: null, blockedBy: [], ...overrides };
}

/** Spec 3, the parent of Ticket 7, with this label timeline. */
export function aSpec(labelEvents: readonly LabelEvent[], overrides: Partial<SpecFacts> = {}): SpecFacts {
  return { number: 3, labelEvents, tickets: [7], ...overrides };
}

/** The GitHub facts of `owner/product`, with nothing in them unless a test says so. */
export function factsOf(overrides: Partial<GitHubFacts> = {}): GitHubFacts {
  return {
    repo: "owner/product",
    pullRequests: [],
    tickets: [],
    specs: [],
    defaultBranchCommits: [],
    mergedPullRequestTitles: [],
    openIssues: [],
    openPullRequests: [],
    designQueue: { issues: [], designTurnsInProgress: [] },
    ...overrides,
  };
}

/** The Fabrik App's comment `body` at `at`; a person's with `{ author, byBot: false }`. */
export function aComment(body: string, at: string, overrides: Partial<CommentFacts> = {}): CommentFacts {
  return { author: "fabrik-app[bot]", byBot: true, body, at, ...overrides };
}

/** The Fabrik App's Design round `round` at `at`. */
export function aDesignRound(round: number, at: string): CommentFacts {
  return aComment(`${designRoundMarker(round)}\nWhich of these should it do?`, at);
}

/** The Fabrik App's Verdict comment on `headSha` at `at`. */
export function aVerdictComment(verdict: Verdict, headSha: string, at: string, overrides: Partial<CommentFacts> = {}): CommentFacts {
  return aComment(`${verdictMarker({ verdict, source: "reviewer", requestChanges: false, headSha })}\nVerdict: ${verdict}`, at, overrides);
}

/** Open issue 12, opened on 2026-10-01, with no labels, comments or label events unless a test says so. */
export function anOpenIssue(overrides: Partial<OpenIssueFacts> = {}): OpenIssueFacts {
  return { number: 12, title: "An open issue", labels: [], createdAt: "2026-10-01T00:00:00Z", comments: [], labelEvents: [], ...overrides };
}

/** Open agent PR 50, a draft at head `h…h` opened on 2026-10-01, with nothing on it unless a test says so. */
export function anOpenPullRequest(overrides: Partial<OpenPullRequestFacts> = {}): OpenPullRequestFacts {
  return {
    number: 50,
    title: "Build the thing",
    draft: true,
    headSha: "h".repeat(40),
    createdAt: "2026-10-01T00:00:00Z",
    commits: [],
    comments: [],
    labelEvents: [],
    ...overrides,
  };
}
