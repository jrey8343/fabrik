// The Retro evidence module (#151): the factory's metrics, promoted out of the
// Weekly summary so the summary (src/kit/weeklySummary.ts) and the Retro read
// them by one set of rules. From each Product repo's GitHub facts, as the facts
// adapter gathers them (src/github/facts.ts), and the store's Run records: the
// agent PRs merged in a window, each with its Ticket, Dispatch, Human touches,
// last passing Verdict and whether it was reverted; the Verdicts on a PR; and
// the Architectural escapes opened in a window, with what let each PR through;
// and the Request changes submitted in a window, each with what its run
// answered about it (#369).
// Then the evidence bundle a Retro reads for its window (evidenceBundle), each
// of its items carrying the ref the Retro cites it by (refsOf): its runs'
// transcripts read through the transcript digest (src/kit/transcriptDigest.ts),
// as the judge reads them, and the whole held to one budget, cut least
// important first. Pure, no I/O.
import { verdictsIn } from "../github/threads.ts";
import type { RequestChangesAnswers } from "../loop/implementOutput.ts";
import { DISPATCH_LABEL, READY_FOR_HUMAN, REVIEW_LABEL } from "../loop/labels.ts";
import { followUpsIn } from "../loop/followUps.ts";
import { escapeMarkerIn, fromPullRequestIn, fromRetroIn, requestChangesAnswersIn } from "../loop/markers.ts";
import { retrosIn, retroWindowStart } from "../loop/retro.ts";
import { type RetroEvidence, type RetroIssueSnapshot, STRENGTHS, type Strength, type Verdict, type VerdictRecord } from "../loop/types.ts";
import { isLive, recordPathOf, type RunRecord, runKey } from "./runRecord.ts";
import { inSample, type ScoreFile } from "./scorer.ts";
import { cutMarker, cutTo, digestOf, largestCap, type TranscriptDigest } from "./transcriptDigest.ts";

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
  /** Its database id: what a Request-changes run's answers name it by (#369). */
  readonly id: number;
  /** Where it's shown on its PR. */
  readonly url: string;
  readonly author: string;
  readonly state: "approved" | "changes-requested" | "commented" | "dismissed";
  /** What the review says, "" when it says nothing beyond its inline comments. */
  readonly body: string;
  /** Its first 50 inline comments, in the order GitHub lists them. */
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
  /** Where it's shown on its issue or PR. */
  readonly url: string;
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
  /** The Ticket its `Closes #n` names, or null. */
  readonly ticket: number | null;
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
  const posted = verdictCommentsOf(comments);
  // Read across every comment, so the Kit's Flaky check line marks the Verdict it counted back (#462). verdictsIn
      // keeps the comments' order, one Verdict to a comment at most.
      return verdictsIn(comments.filter((comment) => comment.byBot).map(({ body }) => body)).map((record, at) => ({ record, at: posted[at]!.at }));
    }
    
    /** The Fabrik App's comments that hold a Verdict, oldest first, as verdictsOn reads them. */
    function verdictCommentsOf(comments: readonly CommentFacts[]): CommentFacts[] {
      return comments.filter((comment) => comment.byBot && verdictsIn([comment.body]).length > 0);
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
    
    /** What a Request-changes run answered about the review it was started for (#369), and the Kit's comment that holds it. */
    export interface RequestChangesAnswer extends RequestChangesAnswers {
      readonly comment: CommentFacts;
    }
    
    /** A Request changes the Operator submitted on an agent PR, and what its run answered about it. */
    export interface RequestChangesReview {
      /** `owner/name`. */
      readonly repo: string;
      readonly pullRequest: number;
      readonly review: ReviewFacts;
      /**
       * Its run's answers, or null when it has none: its run is held, failed, was
       * replaced by Send it back, or came before the answers. Never guessed.
       */
      readonly answer: RequestChangesAnswer | null;
      /** The last Review record on the PR with a pass Verdict that ended before the review: the pass it followed, or null when the store holds none. */
      readonly passingReview: RunRecord | null;
    }
    
    /**
     * The answer to `review` among a PR's comments: the one a bot's comment
     * records for that review alone, so a run never answers for a later Request
     * changes it read as an amendment, and quoting a marker answers nothing.
     */
    export function answerTo(review: ReviewFacts, comments: readonly CommentFacts[]): RequestChangesAnswer | null {
      for (const comment of comments) {
        if (!comment.byBot) continue;
        const answers = requestChangesAnswersIn(comment.body);
        if (answers?.review === review.id) return { reviewMiss: answers.reviewMiss, amendsTicket: answers.amendsTicket, comment };
      }
      return null;
    }
    
    /**
     * The Request changes the Operator submitted in the window on each repo's
     * agent PRs, merged, closed or open, in the order the facts came, each with
     * its run's answers, counted by when the review was submitted.
     */
    export function requestChangesIn(window: Window, { records, facts, operator }: MetricsInput): RequestChangesReview[] {
      return facts.flatMap((repo) => {
        const passes = records
          .filter((record) => record.repo === repo.repo && record.role === "review" && record.verdict === "pass")
          .toSorted((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt));
        return [...repo.pullRequests, ...repo.openPullRequests].flatMap(({ number, reviews, comments }) =>
          reviews
            .filter((review) => review.author === operator && review.state === "changes-requested" && within(window, review.at))
            .map((review) => ({
              repo: repo.repo,
              pullRequest: number,
              review,
              answer: answerTo(review, comments),
              passingReview: passes.findLast((record) => record.pullRequest === number && Date.parse(record.endedAt) <= Date.parse(review.at)) ?? null,
            })),
        );
      });
    }
    
    // The evidence bundle: what one Retro reads of one Product repo for its window.
    
    const DAY_MS = 24 * 60 * 60 * 1000;
    
    /** How far back an escape's PRs may have merged to count, as for the Weekly summary's escape rate: slow decay takes time to show. */
    export const ESCAPE_WINDOW_MS = 90 * DAY_MS;
    
    /** How far back the streak table reaches: long enough to count a streak a loosening can rest on. */
    export const STREAK_WINDOW_MS = 90 * DAY_MS;
    
    /**
     * The share of the window's merged agent PRs a Retro reads in depth: one in
     * ten, by the SHA-256 of `<owner>/<repo>#<number>`, so every attempt at a
     * Retro reads the same ones.
     */
    export const SAMPLE_SHARE = 1 / 10;
    
    /** How many closed Retros a Retro reads the Operator's comments on its proposals from. */
    export const HISTORY_DEPTH = 3;
    
    /** A `fabrik:retro` issue, as the tick's snapshot reads it, with its comments, oldest first. */
    export interface RetroIssueFacts extends RetroIssueSnapshot {
      readonly comments: readonly CommentFacts[];
    }
    
    /** What a Retro reads of one Product repo, as the Retro evidence job gathers it. */
    export interface RetroEvidenceInput {
      /** The store's Run records. */
      readonly records: readonly RunRecord[];
      /**
       * Reads one of the store's transcripts by its path in the store, as a Run
       * record's `transcript` names it: every stdout line of the run's
       * stream-json, or null when the store holds none there. The store keeps
       * every transcript and the bundle digests only a few, so the module asks
       * for each it digests, once, however often the budget digests it again.
       */
      readonly readTranscript: (path: string) => readonly string[] | null;
      /** The store's score files, each by its path in the store. */
      readonly scoreFiles: Readonly<Record<string, ScoreFile>>;
      /** The Product repo's GitHub facts, as the facts adapter gathers them for a Retro (gatherRetroFacts, src/github/facts.ts). */
      readonly facts: MetricFacts;
      /** The Operator's GitHub login. */
      readonly operator: string;
      /** The Retro being filled: the pending `fabrik:retro` issue this evidence is for. */
      readonly retro: number;
      /** When its window ends, as its retro marker says, ISO 8601: the time of the tick that opened it. */
      readonly windowEnd: string;
      /**
       * The repo's `fabrik:retro` issues, open and closed, the Retro being filled
       * among them or not. Its window starts where the last Retro's ended, as the
       * retro gate reads it (src/loop/retro.ts), with the Retro being filled left
       * out: the gate takes a pending Retro for the last one, so it would
       * otherwise be its own last Retro, and its window would come out empty.
       */
      readonly retros: readonly RetroIssueFacts[];
      /**
       * The open issues whose body says it was filed from a Retro: the repo's own
       * that say `From retro #n`, and those on the Kit's repo or a Skills source
       * the Operator owns that say `From retro <this repo>#n`. Any other open
       * issue given is left out.
       */
      readonly fromRetroIssues: readonly FromRetroIssueFacts[];
      /**
       * The Tickets evidenceTicketsOf names, each with its title and body, as the
       * evidence job read them: the facts hold a Ticket's number alone. One
       * GitHub no longer has is left out, and its PRs carry its number alone.
       */
      readonly tickets: readonly TicketTextFacts[];
    }
    
    /** A Ticket's title and body, as GitHub has them now. */
    export interface TicketTextFacts {
      readonly number: number;
      readonly title: string;
      readonly body: string;
    }
    
    /** An open issue, as the Retro's history reads it. */
    export interface FromRetroIssueFacts {
      /** The repo it's open on, owner/name, when that isn't the Product repo. */
      readonly repo?: string;
      readonly number: number;
      readonly title: string;
      readonly body: string;
    }
    
    /**
     * What a Retro reads. Every item in it carries the ref the Retro cites it by:
     * a Run record's or score file's path in the store, `#<pr>` or `#<issue>`.
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
      /** The runs that ended in the window that a Scorer failed, oldest first: none until the repo has score files. */
      readonly lowScores: readonly LowScoreEvidence[];
      /** The sample of the agent PRs merged in the window, oldest first: ordinary runs, read in depth. */
      readonly sample: readonly SampledPullRequestEvidence[];
      /** Every agent PR merged in the 90 days to the window's end, oldest first: the counts a loosening's streak rests on. */
      readonly streakTable: readonly StreakRow[];
      /** What the Operator made of earlier Retros: what not to propose again without new evidence. */
      readonly history: RetroHistory;
      /** Whether the budget cut anything to make the bundle fit: each cut is marked in place. */
      readonly trimmed: boolean;
    }
    
    /** A Run record, by its path in the store. */
    export interface RecordEvidence {
      /** The record's path in the store. */
      readonly ref: string;
      readonly record: RunRecord;
    }
    
    /** A Run record with its transcript's digest. */
    export interface DigestedRecordEvidence extends RecordEvidence {
      /**
       * The run's transcript read through the transcript digest (src/kit/transcriptDigest.ts),
       * as the judge reads it: null when the store holds no transcript of the run.
       */
      readonly digest: string | null;
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
      readonly ticket: TicketEvidence | null;
      /** Every Run record on its Ticket, oldest first. */
      readonly records: readonly RecordEvidence[];
      /** The last Review record on the PR with a pass Verdict, the gate that missed the escape, with its transcript's digest, or null when the store holds none. */
      readonly lastPassingReview: DigestedRecordEvidence | null;
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
          /**
           * What its own run answered (#369): whether it holds a Review miss, and
           * whether it amends the Ticket. Null for each when it's unanswered.
           */
        } & { readonly [Answer in keyof RequestChangesAnswers]: RequestChangesAnswers[Answer] | null }
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
  
  /** A run a Scorer failed: its score file, and the run as the store holds it. */
  export interface LowScoreEvidence {
    /** The score file's path in the store. */
    readonly ref: string;
    /** The scored run's Run record, by its path, with its transcript's digest, or null when the store holds no record of it. */
    readonly run: DigestedRecordEvidence | null;
    /** Every rubric's score of the run, the failing ones and the rest, in the rubrics' order. */
    readonly entries: readonly ScoreEvidence[];
  }
  
  /** One rubric's score of a run, as its score file gives it. */
  export interface ScoreEvidence {
    readonly scorer: string;
    readonly score: number;
    /** Whether the score is at or above the rubric's threshold: the Kit's call, never the judge's. */
    readonly pass: boolean;
    readonly label: string;
    readonly rationale: string;
  }
  
  /** A sampled agent PR: its Ticket, its Verdicts and the agent runs on its Ticket. */
  export interface SampledPullRequestEvidence {
    /** `#<pr>`. */
    readonly ref: string;
    readonly number: number;
    readonly title: string;
    /** ISO 8601. */
    readonly mergedAt: string;
    /** The Ticket its `Closes #n` names, or null. */
    readonly ticket: TicketEvidence | null;
    /** Its Verdicts, oldest first. */
    readonly verdicts: readonly VerdictEvidence[];
    /** The Run record of every agent run on its Ticket, oldest first, each with its transcript's digest. */
    readonly records: readonly DigestedRecordEvidence[];
  }
  
  /**
   * An agent PR's Ticket: what it was asked to build, which a Retro traces an
   * escape or a pattern to when the Ticket asked for it or left it open. Never
   * cut to the budget, as a Verdict isn't.
   */
  export interface TicketEvidence {
    /** `#<issue>`. */
    readonly ref: string;
    readonly number: number;
    /** Its title and body as GitHub has them now, or null for a Ticket it no longer has. */
    readonly title: string | null;
    readonly body: string | null;
  }
  
  /** A Verdict, in the comment the Fabrik App posted it in. */
  export interface VerdictEvidence {
    readonly verdict: Verdict;
    /** The Reviewer gave it; or red required checks, or a Retry whose branch changed nothing, made it an Execution flaw. */
    readonly source: VerdictRecord["source"];
    /** ISO 8601. */
    readonly at: string;
    /** The Verdict comment, its findings and Follow-ups included. */
    readonly body: string;
    /** True when its checks have since passed on its head (#462): a Flaky check, counted back from the Ticket's Retries. */
    readonly flaky?: true;
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
  
  /** The earlier Retros, and what the Operator filed from them. */
  export interface RetroHistory {
    /** The last 3 closed Retros the Fabrik App opened whose run didn't fail, newest first. */
    readonly retros: readonly ClosedRetroEvidence[];
    /** The open issues filed from a Retro's proposal: the Retro skips a proposal while its issue is open. */
    readonly filed: readonly FiledProposalEvidence[];
  }
  
  /** A closed Retro: its proposals, and the Operator's comments on them, context never a trigger (ADR-0007). */
  export interface ClosedRetroEvidence {
    /** `#<issue>`. */
    readonly ref: string;
    readonly number: number;
    readonly title: string;
    /** How the Operator closed it: completed when they filed something, not planned otherwise. */
    readonly closedAs: RetroIssueSnapshot["stateReason"];
    /** The filled Retro, its proposals' cards included. */
    readonly body: string;
    /** What the Operator wrote on it, oldest first, each at an ISO 8601 time. */
    readonly operatorComments: readonly { readonly at: string; readonly body: string }[];
  }
  
  /** An open issue filed from a Retro's proposal, by its `From retro` line. */
  export interface FiledProposalEvidence {
    /** `#<issue>`, or `<owner>/<repo>#<issue>` for one open on another repo, the Kit's or a Skills source. */
    readonly ref: string;
    readonly number: number;
    readonly title: string;
    readonly body: string;
    /** The Retro it was filed from. */
    readonly retro: number;
  }
  
  /** The evidence bundle for one Retro: what it reads of one Product repo for its window. Pure, no I/O. */
  export function evidenceBundle(input: RetroEvidenceInput): EvidenceBundle {
    const earlier = earlierRetrosOf(input);
    const window = windowOf(input);
    const metrics = metricsOf(input);
    const digests = digestsOf(input.readTranscript);
    const digested: Digested = (record) => ({ ...recordEvidenceOf(record), digest: digests(record, Infinity) });
    const tickets = new Map(input.tickets.map((ticket) => [ticket.number, ticket]));
    const ticketOf: TicketOf = (number) => {
      if (number === null) return null;
      const { title = null, body = null } = tickets.get(number) ?? {};
      return { ref: `#${number}`, number, title, body };
    };
    const whole: EvidenceBundle = {
      window: { start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() },
      escapes: escapesOf(window, metrics, digested, ticketOf),
      feedback: feedbackOf(window, input),
      followUps: followUpsOf(window, input),
      lowScores: lowScoresOf(window, metrics.records, input, digested),
      sample: sampleOf(window, metrics, digested, ticketOf),
      streakTable: streakTableOf({ start: window.end - STREAK_WINDOW_MS, end: window.end }, metrics),
      history: historyOf(earlier, input),
      trimmed: false,
    };
    return heldToBudget(whole, digests);
  }
  
  /**
   * The Tickets a Retro's evidence carries, each once: the Ticket of each PR an
   * escape counts against and of each sampled PR. The facts hold a Ticket's
   * number alone, so the evidence job reads each one's title and body and
   * gives them to evidenceBundle as `tickets`.
   */
  export function evidenceTicketsOf(input: Omit<RetroEvidenceInput, "tickets">): number[] {
    const window = windowOf(input);
    const metrics = metricsOf(input);
    // Which PRs they are needs no transcript.
    const undigested: Digested = (record) => ({ ...recordEvidenceOf(record), digest: null });
    const numberOnly: TicketOf = (number) => (number === null ? null : { ref: `#${number}`, number, title: null, body: null });
    const numbers = [
      ...escapesOf(window, metrics, undigested, numberOnly).flatMap(({ pullRequests }) => pullRequests.map(({ ticket }) => ticket)),
      ...sampleOf(window, metrics, undigested, numberOnly).map(({ ticket }) => ticket),
    ].flatMap((ticket) => (ticket === null ? [] : [ticket.number]));
    return [...new Set(numbers)];
  }
  
  /**
   * What the metrics read of the input: only this repo's live records, whatever
   * the store gave. A Replay arm's record names the Ticket and PR it re-ran,
   * but no Replay run built or let through what merged (#156).
   */
  function metricsOf({ records, facts, operator }: Pick<RetroEvidenceInput, "records" | "facts" | "operator">): MetricsInput {
    return { records: records.filter((record) => record.repo === facts.repo && isLive(record)), facts: [facts], operator };
  }
  
  /**
   * The earliest time a Retro's evidence reads, in milliseconds: 90 days before
   * its window starts, so an escape opened at the start is counted against
   * every agent PR it may name. A Retro held back for weeks starts its window
   * long ago, so the facts it's given must reach back this far
   * (gatherRetroFacts, src/github/facts.ts) for its window to be read whole.
   */
  export function evidenceReachOf(input: Pick<RetroEvidenceInput, "retro" | "windowEnd" | "retros">): number {
    return windowOf(input).start - ESCAPE_WINDOW_MS;
  }
  
  /** The Retros before the one being filled, which is left out: the gate takes a pending Retro for the last one. */
  function earlierRetrosOf({ retro, retros }: Pick<RetroEvidenceInput, "retro" | "retros">): readonly RetroIssueFacts[] {
    return retros.filter(({ number }) => number !== retro);
  }
  
  /** The Retro's window: from the last Retro's window end, as the gate reads it (src/loop/retro.ts), to its own. */
  function windowOf(input: Pick<RetroEvidenceInput, "retro" | "windowEnd" | "retros">): Window {
    return { start: Date.parse(retroWindowStart(input.windowEnd, earlierRetrosOf(input))), end: Date.parse(input.windowEnd) };
  }
  
  /** A ref the Retro may cite, and what it cites. */
  export interface EvidenceRef {
    readonly ref: string;
    /** An escape's issue, an agent PR, any other issue, a Run record, or a score file. */
    readonly kind: "escape" | "pull-request" | "issue" | "record" | "score";
  }
  
  /**
   * Every ref in the bundle, once each, in the order the bundle first gives
   * it: the refs a Retro's proposal may cite as its evidence.
   */
  export function refsOf(bundle: EvidenceBundle): EvidenceRef[] {
    const pullRequest = (ref: string): EvidenceRef => ({ ref, kind: "pull-request" });
    const issue = (number: number): EvidenceRef => ({ ref: `#${number}`, kind: "issue" });
    const record = ({ ref }: RecordEvidence): EvidenceRef => ({ ref, kind: "record" });
    const refs: EvidenceRef[] = [
      ...bundle.escapes.flatMap((escape) => [
        { ref: escape.ref, kind: "escape" as const },
        ...escape.pullRequests.flatMap((escaped) => [
          pullRequest(escaped.ref),
          ...(escaped.ticket === null ? [] : [issue(escaped.ticket.number)]),
          ...escaped.records.map(record),
          ...(escaped.lastPassingReview === null ? [] : [record(escaped.lastPassingReview)]),
        ]),
      ]),
      ...bundle.feedback.map(({ ref }) => pullRequest(ref)),
      ...bundle.followUps.flatMap((followUp) => [pullRequest(followUp.ref), ...(followUp.openedAs === null ? [] : [issue(followUp.openedAs)])]),
      ...bundle.lowScores.flatMap((low) => [{ ref: low.ref, kind: "score" as const }, ...(low.run === null ? [] : [record(low.run)])]),
      ...bundle.sample.flatMap((sampled) => [
        pullRequest(sampled.ref),
        ...(sampled.ticket === null ? [] : [issue(sampled.ticket.number)]),
        ...sampled.records.map(record),
      ]),
      ...bundle.streakTable.map(({ ref }) => pullRequest(ref)),
      ...bundle.history.retros.map(({ number }) => issue(number)),
      ...bundle.history.filed.map(({ ref }): EvidenceRef => ({ ref, kind: "issue" })),
    ];
    const once = new Map<string, EvidenceRef>();
    for (const each of refs) if (!once.has(each.ref)) once.set(each.ref, each);
    return [...once.values()];
  }
  
  /**
   * What landing a Retro reads of the bundle its run was given
   * (src/loop/retroLanding.ts): the window, every ref a proposal may cite, the
   * streak table, and the transcript of each Run record among the refs that
   * left one. The push job reads these from the evidence job's artifact, never
   * from the Retro's output.
   */
  export function retroEvidenceOf(bundle: EvidenceBundle): RetroEvidence {
    const records = [
      ...bundle.escapes.flatMap(({ pullRequests }) => pullRequests.flatMap(({ records, lastPassingReview }) => [...records, ...(lastPassingReview === null ? [] : [lastPassingReview])])),
      ...bundle.lowScores.flatMap(({ run }) => (run === null ? [] : [run])),
      ...bundle.sample.flatMap(({ records }) => records),
    ];
    const transcripts: Record<string, string> = {};
    for (const { ref, record } of records) if (record.transcript !== null) transcripts[ref] = record.transcript;
    return { window: bundle.window, refs: refsOf(bundle), streakTable: bundle.streakTable, transcripts };
  }
  
  /** The evidence job's artifact's one file: the bundle as JSON, which the Retro agent job and the push job each read. */
  export const RETRO_EVIDENCE_FILE = "evidence.json";
  
  /**
   * Reads the evidence artifact's text back into its bundle, refusing anything
   * that isn't one in the parts landing a Retro relies on. The Kit's evidence
   * job wrote it, so this checks its shape, not every field.
   */
  export function readEvidenceBundle(text: string): EvidenceBundle {
    const fail = (why: string): never => {
      throw new Error(`${RETRO_EVIDENCE_FILE} ${why}`);
    };
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return fail("is not JSON");
    }
    if (!isObject(value)) return fail("is not a JSON object");
    const { window, streakTable, history } = value;
    if (!isObject(window) || !isTime(window["start"]) || !isTime(window["end"])) return fail("has no window from one ISO 8601 time to another");
    for (const part of ["escapes", "feedback", "followUps", "lowScores", "sample"] as const) {
      if (!Array.isArray(value[part])) fail(`has no ${part} list`);
    }
    if (!Array.isArray(streakTable) || !streakTable.every(isStreakRow)) return fail("has no streak table of PRs, each with its ref, number and flags");
    if (!isObject(history) || !Array.isArray(history["retros"]) || !Array.isArray(history["filed"])) return fail("has no history of earlier Retros");
    return value as unknown as EvidenceBundle;
  }
  
  function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  
  function isTime(value: unknown): value is string {
    return typeof value === "string" && !Number.isNaN(Date.parse(value));
  }
  
  function isStreakRow(value: unknown): boolean {
    if (!isObject(value)) return false;
    const { ref, number, escaped, reverted, requestChanges } = value;
    return (
      typeof ref === "string" &&
      Number.isInteger(number) &&
      [escaped, reverted, requestChanges].every((flag) => typeof flag === "boolean")
    );
  }
  
  /** A run's transcript's digest held to a budget, or null when the store holds no transcript of it. */
  type Digests = (record: RunRecord, budget: number) => string | null;
  
  /** The store's transcripts as digests, each transcript read once however often it's digested. */
  function digestsOf(readTranscript: RetroEvidenceInput["readTranscript"]): Digests {
    // Each path read, by its digest, or null when the store holds no transcript there.
    const read = new Map<string, ((budget: number) => TranscriptDigest) | null>();
    return (record, budget) => {
      const path = record.transcript;
      if (path === null) return null;
      if (!read.has(path)) {
        const lines = readTranscript(path);
        read.set(path, lines === null ? null : digestOf(lines));
      }
      return read.get(path)?.(budget).digest ?? null;
    };
  }
  
  /** A Run record with its transcript's whole digest. */
  type Digested = (record: RunRecord) => DigestedRecordEvidence;
  
  /** The Ticket a PR's `Closes #n` names, as the evidence carries it, or null for none. */
  type TicketOf = (number: number | null) => TicketEvidence | null;
  
  /**
   * Every escape the Operator opened in the window, each counted, by the Weekly
   * summary's rule, against the agent PRs its marker names that merged in the
   * 90 days to it. Counting each from itself rather than from the window's end
   * keeps every escape's PRs however long a held-back Retro's window runs.
   */
  function escapesOf(window: Window, metrics: MetricsInput, digested: Digested, ticketOf: TicketOf): EscapeEvidence[] {
    return metrics.facts
      .flatMap((repo) =>
        repo.escapeMarkerIssues
          .filter((issue) => within(window, issue.createdAt))
          .flatMap((issue) => {
            const at = Date.parse(issue.createdAt);
            // A window holds its start but not its end, so the 90 days to an escape end just after it.
            const counted = { start: at + 1 - ESCAPE_WINDOW_MS, end: at + 1 };
            return escapesIn(counted, { ...metrics, facts: [{ ...repo, escapeMarkerIssues: [issue] }] });
          }),
      )
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
          ticket: ticketOf(pullRequest.ticket),
          records: records.map(recordEvidenceOf),
          lastPassingReview: lastPassingReview === null ? null : digested(lastPassingReview),
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
      .map((review): OperatorFeedback => {
        const answer = answerTo(review, comments);
        return {
          kind: "request-changes",
          at: review.at,
          body: review.body,
          inline: review.comments,
          reviewMiss: answer?.reviewMiss ?? null,
          amendsTicket: answer?.amendsTicket ?? null,
      };
    });
  const reviewComments = theirs
    .filter((review) => review.state !== "changes-requested" && (review.body.trim() !== "" || review.comments.length > 0))
    .map((review): OperatorFeedback => ({ kind: "comment", at: review.at, body: review.body, inline: review.comments }));
  const conversation = comments
    .filter((comment) => !comment.byBot && comment.author === operator && within(window, comment.at))
    .map((comment): OperatorFeedback => ({ kind: "comment", at: comment.at, body: comment.body, inline: [] }));
  const pushes = pushesOf(commits.filter((commit) => within(window, commit.at)), operator);
  return [...requestChanges, ...reviewComments, ...conversation, ...pushes].toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Each run of consecutive commits the Operator made, as one push: anyone else's commit ends a run. */
function pushesOf(commits: readonly CommitFacts[], operator: string): OperatorFeedback[] {
  const runs: CommitFacts[][] = [];
  let inRun = false;
  for (const commit of commits) {
    const theirs = !commit.byApp && commit.author === operator;
    if (theirs && inRun) runs.at(-1)?.push(commit);
    else if (theirs) runs.push([commit]);
    inRun = theirs;
  }
  return runs.flatMap((run) => {
    const last = run.at(-1);
    if (last === undefined) return [];
    return [
      {
        kind: "push",
        at: last.at,
        commits: run.map(({ sha, message, at }) => ({ sha, message, at })),
        patch: run.flatMap((commit) => (commit.patch === null ? [] : [commit.patch])).join("\n"),
      },
    ];
  });
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

/**
 * The repo's live score files with a failing entry whose run ended in the
 * window, oldest first: never a Replay arm's, as the Weekly summary's Scores
 * leave them out. A score file whose record the store doesn't hold goes by
 * when it was scored, minutes after its run ended, as the Weekly summary does.
 */
function lowScoresOf(window: Window, records: readonly RunRecord[], { facts, scoreFiles }: RetroEvidenceInput, digested: Digested): LowScoreEvidence[] {
  const byRun = new Map(records.map((record) => [runKey(record), record]));
  return Object.entries(scoreFiles)
    .flatMap(([ref, file]) => {
      const entries = file.entries ?? [];
      if (file.repo !== facts.repo || !isLive(file) || entries.every((entry) => entry.pass)) return [];
      const record = byRun.get(runKey(file));
      const endedAt = record?.endedAt ?? file.scoredAt;
      if (!within(window, endedAt)) return [];
      const scores = entries.map(({ scorer, score, pass, label, rationale }) => ({ scorer, score, pass, label, rationale }));
      return [{ endedAt, evidence: { ref, run: record === undefined ? null : digested(record), entries: scores } }];
    })
    .toSorted((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt) || a.evidence.ref.localeCompare(b.evidence.ref))
    .map(({ evidence }) => evidence);
}

/**
 * The agent PRs merged in the window that are in the sample, oldest first,
 * with the agent runs on each one's Ticket: a judge's run scoring one of
 * them is left out, as the low scores give what it found.
 */
function sampleOf(window: Window, metrics: MetricsInput, digested: Digested, ticketOf: TicketOf): SampledPullRequestEvidence[] {
  return mergedAgentPullRequestsIn(window, metrics)
    .filter(({ repo, pullRequest }) => inSample(`${repo}#${pullRequest.number}`, SAMPLE_SHARE))
    .toSorted((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt) || a.pullRequest.number - b.pullRequest.number)
    .map(({ pullRequest: { number, title, ticket, comments }, mergedAt }) => {
      const posted = verdictCommentsOf(comments);
      return {
        ref: `#${number}`,
        number,
        title,
        mergedAt,
        ticket: ticketOf(ticket),
        verdicts: verdictsOn(comments).map(({ record: { verdict, source, flaky }, at }, index) => ({
          verdict,
          source,
          at,
          body: posted[index]!.body,
          ...(flaky === true ? { flaky } : {}),
        })),
        records: metrics.records
          .filter((record) => ticket !== null && record.issue === ticket && record.role !== "score")
          .toSorted((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt))
          .map(digested),
      };
    });
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

/** The last closed Retros whose run didn't fail, with the Operator's comments, and the open issues filed from one. */
function historyOf(retros: readonly RetroIssueFacts[], { operator, fromRetroIssues, facts }: RetroEvidenceInput): RetroHistory {
  const closed = retrosIn(retros)
    .filter((retro) => !retro.open && !retro.failed)
    .slice(0, HISTORY_DEPTH)
    .flatMap(({ number }) => retros.find((issue) => issue.number === number) ?? [])
    .map(({ number, title, stateReason, body, comments }) => ({
      ref: `#${number}`,
      number,
      title,
      closedAs: stateReason,
      body,
      operatorComments: comments.filter((comment) => !comment.byBot && comment.author === operator).map(({ at, body }) => ({ at, body })),
    }));
  // A bare `From retro #n` names a Retro of the repo the issue is open on, so only one of this repo's counts.
  const isThisRepo = (repo: string | null | undefined) => repo == null || repo.toLowerCase() === facts.repo.toLowerCase();
  const filed = fromRetroIssues.flatMap(({ repo, number, title, body }) => {
    const from = fromRetroIn(body);
    if (from === null || !isThisRepo(from.repo ?? repo)) return [];
    const ref = isThisRepo(repo) ? `#${number}` : `${repo}#${number}`;
    return [{ ref, number, title, body, retro: from.retro }];
  });
  return { retros: closed, filed };
}

// The budget.

/**
 * How many characters a Retro's evidence bundle may take, as JSON: about
 * 85,000 tokens, as the judge's digest may, which leaves the Retro's context
 * room for its prompt, the Kit's prompts and rubrics, and the files it reads.
 * A bigger bundle is cut to fit, in CUT_ORDER.
 */
export const EVIDENCE_BUDGET = 300_000;

/**
 * What the budget may cut, least important first: the sample's transcripts,
 * then the low-scoring runs', then the patches of the Operator's pushes, then
 * the escapes' passing Review runs' transcripts. Nothing else is ever cut:
 * not a ref, a Verdict, a Ticket, a review comment or the streak table.
 */
const CUT_ORDER = ["sample", "lowScores", "patches", "escapes"] as const;

type Cut = (typeof CUT_ORDER)[number];

/** How long each kind of cut text may be; Infinity leaves that kind whole. */
type Caps = Readonly<Record<Cut, number>>;

const UNCUT: Caps = { sample: Infinity, lowScores: Infinity, patches: Infinity, escapes: Infinity };

/** A text the budget may cut: whole, and cut to a cap with the cut marked in place. */
interface Cuttable {
  readonly cut: Cut;
  readonly whole: string;
  readonly to: (cap: number) => string;
}

/**
 * The bundle held to the budget, as JSON: whole if it fits, else with the
 * longest texts of the least important kind cut to one shared cap, and only
 * when even cutting all of those whole can't make it fit, the next kind too,
 * and so on. A transcript's digest is cut as the digest cuts itself, keeping
 * its tool calls, until even those don't fit, when it's cut whole. Held as
 * far as cutting can: what's never cut can leave it over the budget.
 */
function heldToBudget(bundle: EvidenceBundle, digests: Digests): EvidenceBundle {
  const cuttable: Cuttable[] = [];
  withCuts(bundle, digests, (text) => {
    cuttable.push(text);
    return text.whole;
  });
  // A text's share of the bundle's JSON is its own JSON, so cutting it changes the bundle's length by that much.
  const json = (text: string) => JSON.stringify(text).length;
  const whole = JSON.stringify(bundle).length;
  const length = (caps: Caps) =>
    cuttable.reduce((sum, text) => (caps[text.cut] === Infinity ? sum : sum + json(text.to(caps[text.cut])) - json(text.whole)), whole);
  const fits = (caps: Caps) => length(caps) <= EVIDENCE_BUDGET;

  let caps = UNCUT;
  for (const cut of CUT_ORDER) {
    if (fits(caps)) break;
    const longest = cuttable.reduce((max, text) => (text.cut === cut ? Math.max(max, text.whole.length) : max), 0);
    const others = caps;
    caps = { ...others, [cut]: largestCap((cap) => fits({ ...others, [cut]: cap }), longest) ?? 0 };
  }
  const trimmed = cuttable.some((text) => text.to(caps[text.cut]) !== text.whole);
  return { ...withCuts(bundle, digests, (text) => text.to(caps[text.cut])), trimmed };
}

/** The bundle with each text the budget may cut replaced by what `cutting` makes of it. */
function withCuts(bundle: EvidenceBundle, digests: Digests, cutting: (text: Cuttable) => string): EvidenceBundle {
  const digest =
    (cut: Cut) =>
    (evidence: DigestedRecordEvidence): DigestedRecordEvidence => {
      const whole = evidence.digest;
      if (whole === null) return evidence;
      return { ...evidence, digest: cutting({ cut, whole, to: (cap) => digestCutTo(evidence.record, whole, cap, digests) }) };
    };
  return {
    ...bundle,
    escapes: bundle.escapes.map((escape) => ({
      ...escape,
      pullRequests: escape.pullRequests.map((escaped) => ({
        ...escaped,
        lastPassingReview: escaped.lastPassingReview === null ? null : digest("escapes")(escaped.lastPassingReview),
      })),
    })),
    feedback: bundle.feedback.map((on) => ({
      ...on,
      items: on.items.map((item) =>
        item.kind === "push" ? { ...item, patch: cutting({ cut: "patches", whole: item.patch, to: (cap) => cutTo(item.patch, cap) }) } : item,
      ),
    })),
    lowScores: bundle.lowScores.map((low) => ({ ...low, run: low.run === null ? null : digest("lowScores")(low.run) })),
    sample: bundle.sample.map((sampled) => ({ ...sampled, records: sampled.records.map(digest("sample")) })),
  };
}

/** A run's whole digest cut to `cap` as the digest cuts itself, or cut whole, its marker in its place, when even its tool calls are longer. */
function digestCutTo(record: RunRecord, whole: string, cap: number, digests: Digests): string {
  if (cap >= whole.length) return whole;
  const least = digests(record, 0) ?? whole;
  return cap < least.length ? cutMarker(whole.length) : (digests(record, cap) ?? whole);
}

function recordEvidenceOf(record: RunRecord): RecordEvidence {
  return { ref: recordPathOf(record), record };
}
