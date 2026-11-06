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
import { followUpsIn } from "../loop/followUps.ts";
import { escapeMarkerIn, fromPullRequestIn } from "../loop/markers.ts";
import { STRENGTHS, type Strength, type VerdictRecord } from "../loop/types.ts";
import { recordPathOf, type RunRecord } from "./runRecord.ts";

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
  readonly sha: string;
  /** Whether the Fabrik App made it, as an agent run's push does. */
  readonly byApp: boolean;
  /** Its author's GitHub login, or `ghost` when its email belongs to no account. */
  readonly author: string;
  readonly message: string;
  /**
   * What it changed, file by file as a diff, or null when it wasn't read: only
   * the Retro's facts read it, and only for a commit the App didn't make.
   */
  readonly patch: string | null;
  /** ISO 8601. */
  readonly at: string;
}

/** A review left on an agent PR. */
export interface ReviewFacts {
  readonly author: string;
  readonly state: "approved" | "changes-requested" | "commented" | "dismissed";
  /** What the review says, "" when it says nothing beyond its inline comments. */
  readonly body: string;
  /** Its inline comments, in the order GitHub lists them. */
  readonly comments: readonly InlineCommentFacts[];
  /** ISO 8601. */
  readonly at: string;
}

/** A review's comment on a line of an agent PR's diff. */
export interface InlineCommentFacts {
  readonly path: string;
  /** The line it's on, or null when the diff it was left on has moved on. */
  readonly line: number | null;
  readonly body: string;
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
  /** The paths of the files it changed, its first 100. */
  readonly changedPaths: readonly string[];
}

/** An open agent PR. */
export interface OpenPullRequestFacts {
  readonly number: number;
  readonly title: string;
  readonly draft: boolean;
  readonly headSha: string;
  /** ISO 8601. */
  readonly createdAt: string;
  /** Its latest 100 commits, oldest first. */
  readonly commits: readonly CommitFacts[];
  readonly reviews: readonly ReviewFacts[];
  /** Oldest first. */
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

/** An issue the Operator opened whose body says `From PR #n`: a Follow-up opened through its Open as issue link. */
export interface FollowUpIssueFacts {
  readonly number: number;
  readonly title: string;
  /** Who opened it: only the Operator's issues count. */
  readonly author: string;
  readonly body: string;
}

/** What the metrics read of one Product repo on GitHub. */
export interface MetricFacts {
  /** The Product repo, as `owner/name`. */
  readonly repo: string;
  readonly pullRequests: readonly AgentPullRequestFacts[];
  /** The repo's open agent PRs. */
  readonly openPullRequests: readonly OpenPullRequestFacts[];
  readonly tickets: readonly TicketFacts[];
  /** The default branch's commits in the last 97 days. */
  readonly defaultBranchCommits: readonly DefaultBranchCommitFacts[];
  readonly mergedPullRequestTitles: readonly MergedTitleFacts[];
  /** The issues the Operator opened in the last 97 days whose body has an escape marker. */
  readonly escapeMarkerIssues: readonly EscapeMarkerIssueFacts[];
  /** The issues the Operator opened in the last 97 days whose body says `From PR #n`. */
  readonly followUpIssues: readonly FollowUpIssueFacts[];
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

// The evidence bundle: what one Retro reads of one Product repo for its window.

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back a first Retro's window reaches, with no last Retro to start from. */
export const FIRST_RUN_WINDOW_MS = 7 * DAY_MS;

/** How far back an escape's PRs may have merged to count, as for the Weekly summary's escape rate: slow decay takes time to show. */
export const ESCAPE_WINDOW_MS = 90 * DAY_MS;

/** How far back the streak table reaches: long enough to count a streak a loosening can rest on. */
export const STREAK_WINDOW_MS = 90 * DAY_MS;

/** What a Retro reads of one Product repo, as the Retro evidence job gathers it. */
export interface RetroEvidenceInput {
  /** The store's Run records. */
  readonly records: readonly RunRecord[];
  /** The Product repo's GitHub facts. */
  readonly facts: MetricFacts;
  /** The Operator's GitHub login. */
  readonly operator: string;
  /** When the last Retro's window ended, as its marker says, ISO 8601; null on a first run. */
  readonly lastWindowEnd: string | null;
  /** When this Retro's window ends, as its marker says, ISO 8601: the tick that opened it. */
  readonly windowEnd: string;
}

/**
 * What a Retro reads. Every item in it carries the ref the Retro cites it by:
 * a Run record's path in the store, `#<pr>` or `#<issue>`.
 */
export interface EvidenceBundle {
  /** The span the Retro covers, from `start` (inclusive) to `end` (exclusive), ISO 8601. */
  readonly window: { readonly start: string; readonly end: string };
  /** The Architectural escapes the Operator opened in the window, as the Weekly summary counts them. */
  readonly escapes: readonly EscapeEvidence[];
  /** The Operator's feedback in the window, per agent PR it was given on, whether merged, closed or still open. */
  readonly feedback: readonly FeedbackEvidence[];
  /** The Follow-ups on the pass Verdicts of the agent PRs merged in the window, PR by PR. */
  readonly followUps: readonly FollowUpEvidence[];
  /** Every agent PR merged in the 90 days to the window's end, oldest first: the counts a loosening's streak rests on. */
  readonly streakTable: readonly StreakRow[];
}

/** A Run record, by its path in the store. */
export interface RecordEvidence {
  /** The record's path in the store. */
  readonly ref: string;
  readonly record: RunRecord;
}

/** An Architectural escape: the Operator's issue, and the agent PRs it counts against. */
export interface EscapeEvidence {
  /** `#<issue>`. */
  readonly ref: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  /** Its marker's Strength, or null when it isn't one the Auditor gives. */
  readonly strength: Strength | null;
  readonly pullRequests: readonly EscapedPullRequestEvidence[];
}

/** An agent PR an escape counts against, and what let it through. */
export interface EscapedPullRequestEvidence {
  /** `#<pr>`. */
  readonly ref: string;
  readonly number: number;
  readonly title: string;
  /** The Ticket its `Closes #n` names, or null. */
  readonly ticket: number | null;
  /** Every Run record on its Ticket, oldest first. */
  readonly records: readonly RecordEvidence[];
  /** The last Review record on the PR with a pass Verdict, the gate that missed the escape, or null when the store holds none. */
  readonly lastPassingReview: RecordEvidence | null;
}

/**
 * The Operator's feedback on one agent PR in the window, oldest first: what
 * the Retro learns review lessons from. The App's and other people's activity
 * on it is left out.
 */
export interface FeedbackEvidence {
  /** `#<pr>`. */
  readonly ref: string;
  readonly number: number;
  readonly title: string;
  readonly state: "merged" | "closed" | "open";
  readonly items: readonly OperatorFeedback[];
}

/** One piece of the Operator's feedback on an agent PR, each at an ISO 8601 time. */
export type OperatorFeedback =
  | {
      /** A Request changes review. */
      readonly kind: "request-changes";
      readonly at: string;
      readonly body: string;
      readonly inline: readonly InlineCommentFacts[];
    }
  | {
      /** A run of consecutive commits the Operator made, at the last one's time, with what they changed. */
      readonly kind: "push";
      readonly at: string;
      readonly commits: readonly { readonly sha: string; readonly message: string; readonly at: string }[];
      /** Each commit's patch in turn. */
      readonly patch: string;
    }
  | {
      /**
       * An Operator comment: one in the PR's conversation, which has no inline
       * comments, or a review that isn't a Request changes.
       */
      readonly kind: "comment";
      readonly at: string;
      readonly body: string;
      readonly inline: readonly InlineCommentFacts[];
    };

/** A Follow-up a pass Verdict named: work outside its Ticket's scope, left for the Operator to open as an issue or ignore. */
export interface FollowUpEvidence {
  /** `#<pr>`: the PR whose pass named it. */
  readonly ref: string;
  readonly pullRequest: number;
  readonly title: string;
  readonly body: string;
  /** The issue the Operator opened it as through its Open as issue link, still titled as the link prefilled it, or null. */
  readonly openedAs: number | null;
}

/** An agent PR in the streak table, and whatever breaks a streak it's counted in. */
export interface StreakRow {
  /** `#<pr>`. */
  readonly ref: string;
  readonly number: number;
  readonly title: string;
  /** ISO 8601. */
  readonly mergedAt: string;
  /** The paths it changed, by which the Retro tells what kind of PR it is. */
  readonly paths: readonly string[];
  /** Whether an Architectural escape the Operator opened in the 90 days counts against it. */
  readonly escaped: boolean;
  /** Whether a revert in the 90 days reverted it, by the revert rule the Weekly summary's revert rate counts by. */
  readonly reverted: boolean;
  /** Whether the Operator sent it a Request changes. */
  readonly requestChanges: boolean;
}

/** The evidence bundle for one Retro: what it reads of one Product repo for its window. Pure, no I/O. */
export function evidenceBundle(input: RetroEvidenceInput): EvidenceBundle {
  const end = Date.parse(input.windowEnd);
  const window = { start: input.lastWindowEnd === null ? end - FIRST_RUN_WINDOW_MS : Date.parse(input.lastWindowEnd), end };
  const metrics: MetricsInput = { records: input.records, facts: [input.facts], operator: input.operator };
  return {
    window: { start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() },
    escapes: escapesOf(window, metrics),
    feedback: feedbackOf(window, input),
    followUps: followUpsOf(window, input),
    streakTable: streakTableOf({ start: window.end - STREAK_WINDOW_MS, end: window.end }, metrics),
  };
}

/** The escapes opened in the window, each counted against the agent PRs merged in the 90 days to its end. */
function escapesOf(window: Window, metrics: MetricsInput): EscapeEvidence[] {
  return escapesIn({ start: window.end - ESCAPE_WINDOW_MS, end: window.end }, metrics)
    .filter(({ issue }) => within(window, issue.createdAt))
    .map(({ issue, strength, pullRequests }) => ({
      ref: `#${issue.number}`,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      strength,
      pullRequests: pullRequests.map(({ pullRequest, records, lastPassingReview }) => ({
        ref: `#${pullRequest.number}`,
        number: pullRequest.number,
        title: pullRequest.title,
        ticket: pullRequest.ticket,
        records: records.map(recordEvidenceOf),
        lastPassingReview: lastPassingReview === null ? null : recordEvidenceOf(lastPassingReview),
      })),
    }));
}

/** The Operator's feedback in the window on each agent PR that got some. */
function feedbackOf(window: Window, { facts, operator }: RetroEvidenceInput): FeedbackEvidence[] {
  const pullRequests = [
    ...facts.pullRequests.map((pullRequest) => ({ pullRequest, state: pullRequest.mergedAt === null ? ("closed" as const) : ("merged" as const) })),
    ...facts.openPullRequests.map((pullRequest) => ({ pullRequest, state: "open" as const })),
  ];
  return pullRequests.flatMap(({ pullRequest, state }) => {
    const items = operatorFeedbackOn(pullRequest, window, operator);
    const { number, title } = pullRequest;
    return items.length === 0 ? [] : [{ ref: `#${number}`, number, title, state, items }];
  });
}

/** The Operator's Request changes, pushes and comments on a PR in the window, oldest first. */
function operatorFeedbackOn(
  { reviews, commits, comments }: Pick<AgentPullRequestFacts, "reviews" | "commits" | "comments">,
  window: Window,
  operator: string,
): OperatorFeedback[] {
  const theirs = reviews.filter((review) => review.author === operator && within(window, review.at));
  const requestChanges = theirs
    .filter((review) => review.state === "changes-requested")
    .map((review): OperatorFeedback => ({ kind: "request-changes", at: review.at, body: review.body, inline: review.comments }));
  const reviewComments = theirs
    .filter((review) => review.state !== "changes-requested" && (review.body.trim() !== "" || review.comments.length > 0))
    .map((review): OperatorFeedback => ({ kind: "comment", at: review.at, body: review.body, inline: review.comments }));
  const conversation = comments
    .filter((comment) => !comment.byBot && comment.author === operator && within(window, comment.at))
    .map((comment): OperatorFeedback => ({ kind: "comment", at: comment.at, body: comment.body, inline: [] }));
  const pushes = pushesOf(
    commits.filter((commit) => within(window, commit.at)),
    operator,
  );
  return [...requestChanges, ...reviewComments, ...conversation, ...pushes].toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Each run of consecutive commits the Operator made, as one push: anyone else's commit ends a run. */
function pushesOf(commits: readonly CommitFacts[], operator: string): OperatorFeedback[] {
  const runs: CommitFacts[][] = [];
  commits.forEach((commit, i) => {
    if (commit.byApp || commit.author !== operator) return;
    const previous = commits[i - 1];
    const run = runs.at(-1);
    if (run !== undefined && previous !== undefined && run.at(-1) === previous) run.push(commit);
    else runs.push([commit]);
  });
  return runs.map((run) => ({
    kind: "push",
    at: run.at(-1)?.at ?? "",
    commits: run.map(({ sha, message, at }) => ({ sha, message, at })),
    patch: run.flatMap((commit) => (commit.patch === null ? [] : [commit.patch])).join("\n"),
  }));
}

/** The Follow-ups the Fabrik App's pass Verdicts listed on each agent PR merged in the window, read back from the Verdict comments. */
function followUpsOf(window: Window, { facts, operator }: RetroEvidenceInput): FollowUpEvidence[] {
  return mergedIn(window, facts).flatMap(({ number, comments }) =>
    comments
      .filter((comment) => verdictsOn([comment]).some(({ record }) => record.verdict === "pass"))
      .flatMap((comment) => followUpsIn(comment.body))
      .map(({ title, body }) => {
        const opened = facts.followUpIssues.find(
          (issue) => issue.author === operator && fromPullRequestIn(issue.body) === number && issue.title.trim() === title.trim(),
        );
        return { ref: `#${number}`, pullRequest: number, title, body, openedAs: opened?.number ?? null };
      }),
  );
}

/** The agent PRs merged in the streak window, oldest first, each flagged for what breaks a streak in the same window. */
function streakTableOf(window: Window, metrics: MetricsInput): StreakRow[] {
  const escaped = new Set(escapesIn(window, metrics).flatMap(({ pullRequests }) => pullRequests.map(({ pullRequest }) => pullRequest.number)));
  return mergedAgentPullRequestsIn(window, metrics)
    .toSorted((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt))
    .map(({ pullRequest: { number, title, changedPaths, reviews }, mergedAt, reverted }) => ({
      ref: `#${number}`,
      number,
      title,
      mergedAt,
      paths: changedPaths,
      escaped: escaped.has(number),
      reverted,
      requestChanges: reviews.some((review) => review.author === metrics.operator && review.state === "changes-requested"),
    }));
}

function recordEvidenceOf(record: RunRecord): RecordEvidence {
  return { ref: recordPathOf(record), record };
}
