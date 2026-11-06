// The Retro evidence module (#151): the factory's metrics, promoted out of the
// Weekly summary so the summary (src/kit/weeklySummary.ts) and the Retro read
// them by one set of rules. From each Product repo's GitHub facts, as the facts
// adapter gathers them (src/github/facts.ts), and the store's Run records: the
// agent PRs merged in a window, each with its Ticket, Dispatch, Human touches,
// last passing Verdict and whether it was reverted; the Verdicts on a PR; and
// the Architectural escapes opened in a window, with what let each PR through.
// Pure, no I/O.
import { verdictsIn } from "../github/threads.ts";
import { DISPATCH_LABEL, READY_FOR_HUMAN, REVIEW_LABEL } from "../loop/labels.ts";
import { escapeMarkerIn } from "../loop/markers.ts";
import { STRENGTHS, type Strength, type VerdictRecord } from "../loop/types.ts";
import type { RunRecord } from "./runRecord.ts";

// The GitHub facts the metrics read of one Product repo.

/** A label added to or removed from an issue, by whom and when. */
export interface LabelEvent {
  readonly label: string;
  readonly action: "labeled" | "unlabeled";
  readonly actor: string;
  /** ISO 8601. */
  readonly at: string;
}

/** An issue a Ticket is blocked by. */
export interface BlockerFacts {
  readonly number: number;
  /** Its labels: an Operator step's include `ready-for-human`. */
  readonly labels: readonly string[];
}

/** A Ticket, its label timeline and what it's blocked by. */
export interface TicketFacts {
  readonly number: number;
  readonly labelEvents: readonly LabelEvent[];
  readonly blockedBy: readonly BlockerFacts[];
  /** ISO 8601, or null while it's open. */
  readonly closedAt: string | null;
}

/** A commit on an agent PR's branch. */
export interface CommitFacts {
  /** Whether the Fabrik App made it, as an agent run's push does. */
  readonly byApp: boolean;
  /** ISO 8601. */
  readonly at: string;
}

/** A review left on an agent PR. */
export interface ReviewFacts {
  readonly author: string;
  readonly state: "approved" | "changes-requested" | "commented" | "dismissed";
  /** ISO 8601. */
  readonly at: string;
}

/** A comment on an issue or a PR. */
export interface CommentFacts {
  readonly author: string;
  /** Whether a bot, such as the Fabrik App, wrote it: only a bot's markers count, so quoting one fakes nothing. */
  readonly byBot: boolean;
  readonly body: string;
  /** ISO 8601. */
  readonly at: string;
}

/** An agent PR merged or closed in the last 97 days. */
export interface AgentPullRequestFacts {
  readonly number: number;
  /** The Ticket its `Closes #n` names, or null. */
  readonly ticket: number | null;
  readonly title: string;
  /** ISO 8601, or null for a PR closed without merging. */
  readonly mergedAt: string | null;
  readonly mergeSha: string | null;
  /** Its commits, oldest first. */
  readonly commits: readonly CommitFacts[];
  readonly reviews: readonly ReviewFacts[];
  /** Its comments, oldest first. */
  readonly comments: readonly CommentFacts[];
  readonly labelEvents: readonly LabelEvent[];
}

/** A commit on the default branch. */
export interface DefaultBranchCommitFacts {
  readonly message: string;
  /** ISO 8601. */
  readonly at: string;
}

/** Any PR merged in the last 97 days, agent or not, by its title. */
export interface MergedTitleFacts {
  readonly title: string;
  /** ISO 8601. */
  readonly mergedAt: string;
}

/**
 * An issue the Operator opened whose body has a `fabrik:escape` marker, such
 * as an Audit candidate filed through its Open as issue link.
 */
export interface EscapeMarkerIssueFacts {
  readonly number: number;
  readonly title: string;
  /** Who opened it: only the Operator's issues count. */
  readonly author: string;
  /** ISO 8601. */
  readonly createdAt: string;
  readonly state: "open" | "closed";
  readonly body: string;
}

/** What the metrics read of one Product repo on GitHub. */
export interface MetricFacts {
  /** The Product repo, as `owner/name`. */
  readonly repo: string;
  readonly pullRequests: readonly AgentPullRequestFacts[];
  readonly tickets: readonly TicketFacts[];
  /** The default branch's commits in the last 30 days. */
  readonly defaultBranchCommits: readonly DefaultBranchCommitFacts[];
  readonly mergedPullRequestTitles: readonly MergedTitleFacts[];
  /** The issues the Operator opened in the last 97 days whose body has an escape marker. */
  readonly escapeMarkerIssues: readonly EscapeMarkerIssueFacts[];
}

/** What the metrics read: the store's Run records, each Product repo's GitHub facts, and the Operator's GitHub login. */
export interface MetricsInput {
  readonly records: readonly RunRecord[];
  readonly facts: readonly MetricFacts[];
  readonly operator: string;
}

// The metrics, each over a window its caller picks.

/** A span of time, from `start` (inclusive) to `end` (exclusive). */
export interface Window {
  readonly start: number;
  readonly end: number;
}

/** Whether `at`, ISO 8601, falls in the window. */
export function within({ start, end }: Window, at: string): boolean {
  const time = Date.parse(at);
  return time >= start && time < end;
}

/** An agent PR merged in a window, with what the metrics read of it. */
export interface MergedAgentPullRequest {
  /** `owner/name`. */
  readonly repo: string;
  readonly pullRequest: AgentPullRequestFacts;
  /** ISO 8601. */
  readonly mergedAt: string;
  /** The Ticket its `Closes #n` names, if it's among the repo's facts, or null. */
  readonly ticket: TicketFacts | null;
  /** When that Ticket was dispatched, ISO 8601, or null. */
  readonly dispatch: string | null;
  /** How many times the Operator stepped into its Ticket's path between Dispatch and the merge. */
  readonly humanTouches: number;
  /** When its last passing Verdict before the merge was given, ISO 8601, or null. */
  readonly lastPass: string | null;
  /** Whether a revert in the same window reverted it. */
  readonly reverted: boolean;
}

/** The agent PRs merged in the window, repo by repo in the order the facts came. */
export function mergedAgentPullRequestsIn(window: Window, { facts, operator }: Pick<MetricsInput, "facts" | "operator">): MergedAgentPullRequest[] {
  return facts.flatMap((repo) =>
    repo.pullRequests.flatMap((pullRequest) => {
      const { mergedAt } = pullRequest;
      if (mergedAt === null || !within(window, mergedAt)) return [];
      const ticket = repo.tickets.find((candidate) => candidate.number === pullRequest.ticket) ?? null;
      const dispatch = ticket === null ? null : dispatchOf(ticket);
      return [
        {
          repo: repo.repo,
          pullRequest,
          mergedAt,
          ticket,
          dispatch,
          humanTouches: humanTouchesOf({ pullRequest, mergedAt, ticket, dispatch }, operator),
          lastPass: lastPassOf(pullRequest, mergedAt),
          reverted: revertedIn(window, repo, pullRequest),
        },
      ];
    }),
  );
}

/**
 * The Operator's steps into a Ticket's path between Dispatch and merge (the
 * glossary's Human touch). The merge, Design-session answers and Operator
 * comments are never touches.
 */
function humanTouchesOf(
  { pullRequest, mergedAt, ticket, dispatch }: Pick<MergedAgentPullRequest, "pullRequest" | "mergedAt" | "ticket" | "dispatch">,
  operator: string,
): number {
  const before = (at: string) => Date.parse(at) <= Date.parse(mergedAt);
  const between = (at: string) => (dispatch === null || Date.parse(at) >= Date.parse(dispatch)) && before(at);
  // Dispatch itself adds the first agent:implement, so a label counts only after it.
  const after = (at: string) => (dispatch === null || Date.parse(at) > Date.parse(dispatch)) && before(at);
  // A push: a run of consecutive commits the App didn't make.
  const commits = pullRequest.commits.filter((commit) => between(commit.at));
  const pushes = commits.filter((commit, i) => !commit.byApp && (i === 0 || commits[i - 1]?.byApp === true)).length;
  const requestChanges = pullRequest.reviews.filter(
    (review) => review.author === operator && review.state === "changes-requested" && between(review.at),
  ).length;
  const added = [...(ticket?.labelEvents ?? []), ...pullRequest.labelEvents].filter((event) => event.action === "labeled" && after(event.at));
  // A Retry or Step-up the Operator asked for.
  const retriesAsked = added.filter((event) => event.actor === operator && (event.label === DISPATCH_LABEL || event.label === REVIEW_LABEL)).length;
  // A Pairing session on the Ticket.
  const pairing = ticket?.labelEvents.some((event) => event.label === READY_FOR_HUMAN && event.action === "labeled" && after(event.at)) ? 1 : 0;
  const operatorSteps = ticket?.blockedBy.filter((blocker) => blocker.labels.includes(READY_FOR_HUMAN)).length ?? 0;
  return pushes + requestChanges + retriesAsked + pairing + operatorSteps;
}

/**
 * Whether a revert in the window reverted the PR: a default-branch commit's
 * `This reverts commit <merge sha>` trailer, or a merged `Revert "<title>"` PR.
 */
function revertedIn(window: Window, repo: MetricFacts, { mergeSha, title }: AgentPullRequestFacts): boolean {
  const byCommit = repo.defaultBranchCommits.some(
    (commit) => mergeSha !== null && within(window, commit.at) && commit.message.includes(`This reverts commit ${mergeSha}`),
  );
  const byPullRequest = repo.mergedPullRequestTitles.some(
    (pullRequest) => within(window, pullRequest.mergedAt) && pullRequest.title === `Revert "${title}"`,
  );
  return byCommit || byPullRequest;
}

/** When the Ticket was dispatched: its first `agent:implement` (a Retry adds it again), or null. */
export function dispatchOf(ticket: TicketFacts): string | null {
  const added = ticket.labelEvents.filter((event) => event.label === DISPATCH_LABEL && event.action === "labeled");
  return added.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))[0]?.at ?? null;
}

/** When the PR's last passing Verdict before its merge was given, or null. */
function lastPassOf(pullRequest: AgentPullRequestFacts, mergedAt: string): string | null {
  const passes = verdictsOn(pullRequest.comments).filter(({ record, at }) => record.verdict === "pass" && Date.parse(at) <= Date.parse(mergedAt));
  return passes.at(-1)?.at ?? null;
}

/** A Verdict, and when the comment carrying its marker was posted. */
export interface PostedVerdict {
  readonly record: VerdictRecord;
  /** ISO 8601. */
  readonly at: string;
}

/**
 * The Verdicts on a PR, in the order its comments came, read through the
 * Verdict marker on its bots' comments alone: only a bot's markers count, so
 * nobody can fake a Verdict by quoting one.
 */
export function verdictsOn(comments: readonly CommentFacts[]): PostedVerdict[] {
  return comments.flatMap((comment) => (comment.byBot ? verdictsIn([comment.body]).map((record) => ({ record, at: comment.at })) : []));
}

/**
 * An Architectural escape: an issue whose escape marker names at least one
 * agent PR merged in the window. It counts against those PRs alone.
 */
export interface ArchitecturalEscape {
  /** `owner/name`. */
  readonly repo: string;
  readonly issue: EscapeMarkerIssueFacts;
  /** The marker's Strength as written, or null when it isn't one the Auditor gives. */
  readonly strength: Strength | null;
  /** The marker's PRs that are agent PRs merged in the window. */
  readonly pullRequests: readonly EscapedAgentPullRequest[];
}

/** An agent PR an escape counts against, and the evidence of how it got through. */
export interface EscapedAgentPullRequest {
  readonly pullRequest: AgentPullRequestFacts;
  /** Every Run record on its Ticket in its repo, whatever window it ran in, oldest first. */
  readonly records: readonly RunRecord[];
  /** The last Review record on the PR with a pass Verdict, the gate that missed the escape, or null when the store holds none. */
  readonly lastPassingReview: RunRecord | null;
  /** Whether anyone but the Fabrik App pushed to it, read from the commits Human touches count. */
  readonly operatorPushes: boolean;
}

/**
 * The Architectural escapes opened in the window, repo by repo, each counted
 * against the agent PRs merged in the window that its marker names. Only the
 * Operator's issues count, so someone else's issue body can't move the metric.
 */
export function escapesIn(window: Window, { records, facts, operator }: MetricsInput): ArchitecturalEscape[] {
  return facts.flatMap((repo) => {
    const merged = mergedIn(window, repo);
    const onRepo = records.filter((record) => record.repo === repo.repo).toSorted((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt));
    return repo.escapeMarkerIssues.flatMap((issue) => {
      const marker = escapeMarkerIn(issue.body);
      if (marker === null || issue.author !== operator || !within(window, issue.createdAt)) return [];
      const pullRequests = merged.filter((pullRequest) => marker.pullRequests.includes(pullRequest.number));
      if (pullRequests.length === 0) return [];
      const strength = STRENGTHS.find((known) => known === marker.strength) ?? null;
      return [{ repo: repo.repo, issue, strength, pullRequests: pullRequests.map((pullRequest) => escapedPullRequestOf(pullRequest, onRepo)) }];
    });
  });
}

/** What let an escaped PR through, from its repo's records, oldest first. */
function escapedPullRequestOf(pullRequest: AgentPullRequestFacts, onRepo: readonly RunRecord[]): EscapedAgentPullRequest {
  return {
    pullRequest,
    records: onRepo.filter((record) => pullRequest.ticket !== null && record.issue === pullRequest.ticket),
    lastPassingReview:
      onRepo.findLast((record) => record.role === "review" && record.pullRequest === pullRequest.number && record.verdict === "pass") ?? null,
    operatorPushes: pullRequest.commits.some((commit) => !commit.byApp),
  };
}

/** The repo's agent PRs merged in the window. */
function mergedIn(window: Window, { pullRequests }: MetricFacts): AgentPullRequestFacts[] {
  return pullRequests.filter((pullRequest) => pullRequest.mergedAt !== null && within(window, pullRequest.mergedAt));
}
