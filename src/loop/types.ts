// The Loop rules core's interface: a Loop event, a snapshot of GitHub state and
// the resolved Kit config go in; a plan comes out.
import type { CaptureResult, EvidenceMarker } from "../evidence/uiEvidence.ts";
import type { ChangedPath } from "../guard/trust-root.ts";
import type { EvidenceRef, StreakRow } from "../kit/retroEvidence.ts";
import type { SentBack } from "./backToDesign.ts";
import type { Label } from "./labels.ts";

/** An AFK role whose agent job passes structured output to its push job. */
export type AgentRole = "triage" | "design" | "implement" | "review" | "audit" | "retro" | "research";

export const AGENT_ROLES: readonly AgentRole[] = ["triage", "design", "implement", "review", "audit", "retro", "research"];

/** How an agent job says it failed, in the report it leaves for the push job (src/agent/failure.ts). */
export type ReportedFailure =
  | "crash"
  | "missing-output"
  | "provider-error"
  | "dead-token"
  | "weekly-limit"
  | "metered-billing"
  /** With rotation on, the stream watch stopped a run whose stream showed overage. */
  | "usage-credits";

/** Every kind of Infrastructure failure: what the agent job reported, or what the push job saw. */
export type InfrastructureFailure = ReportedFailure | "timeout" | "unreachable-1password";

/** What a failed agent job left for the push job, when it got far enough to leave anything. */
export interface FailureReport {
  readonly failure: ReportedFailure;
  /** One line on what went wrong, for the failure comment. */
  readonly detail: string;
  /** For the weekly limit, when it resets (an ISO 8601 time), if the stream said. */
  readonly resetsAt?: string;
}

/**
 * The paths an agent branch changes: `net` from its base to its head, and
 * `commits` from each commit on its own, so a change made and then undone
 * still counts.
 */
export interface BranchChanges {
  readonly net: readonly ChangedPath[];
  readonly commits: readonly ChangedPath[];
  /**
   * For a run on its agent PR's own branch: whether it brought in main's newer
   * commits, by a merge or a rebase. `net` and `commits` then hold only the
   * run's own changes, never main's, and bringing the PR up to date is a
   * change even when the run made none of its own.
   */
  readonly updatedFromMain?: boolean;
  /**
   * For a run on its agent PR's own branch whose branch moved while it ran
   * (ADR-0006): the head the push job rebased the run's own commits onto, and
   * whether that conflicted. Without a conflict, `net` and `commits` hold only
   * the run's own changes, as rebased; with one, there's nothing to push.
   */
  readonly rebase?: { readonly onto: string; readonly conflicted: boolean };
}

/**
 * What an Implement run's push job knows of its UI evidence (#153): what the
 * Implement job's capture step recorded, when it passed out a result, and
 * where the run keeps it, as its PR's marker will record it, the run being
 * the push job's own. The core puts it on the PR only when it finds the run
 * UI (src/loop/implement.ts).
 */
export interface ImplementEvidence extends Pick<EvidenceMarker, "run" | "artifact"> {
  /**
   * What capture recorded, read from the Implement job's outputs; absent when
   * the job passed out none the push job could read, as when it captured nothing.
   */
  readonly result?: CaptureResult;
  /** The head the Implement run built, which capture is of. */
  readonly headSha: string;
  /** The gallery's web address, or null when the run kept none. */
  readonly gallery: string | null;
}

/**
 * An Operator comment an agent run was given, as its agent job recorded it
 * from the input the Kit wrote, never from the agent's own text: what a
 * Verdict or fix comment links when the run names it as weighed (ADR-0007).
 */
export interface GivenOperatorComment {
  /** `conversation-<id>`, `review-<id>` or `inline-<id>`, as operatorCommentId makes it (src/agent/operatorComments.ts). */
  readonly id: string;
  readonly url: string;
}

/** Something that happened in a Product repo that the Loop may act on. */
export type LoopEvent =
  | { readonly kind: "issue-opened"; readonly issue: number }
  | { readonly kind: "label-added"; readonly issue: number; readonly label: string }
  | {
      readonly kind: "issue-comment-created";
      readonly issue: number;
      /** The login of whoever wrote the comment. */
      readonly commenter: string;
      /** Whether that account is a bot, the Fabrik App included. */
      readonly commenterIsBot: boolean;
      /** The comment's Markdown, which may carry a live Design session's outcome marker. */
      readonly body: string;
      /** The comment's id, which a Design-session turn it starts checks still exists before it posts. */
      readonly comment: number;
    }
  | {
      readonly kind: "agent-run-finished";
      /**
       * Implement, Review, Auditor, Retro and Researcher runs finish through
       * their own events, which carry what their push jobs hold. A
       * Researcher's result has no event yet (#154).
       */
      readonly role: Exclude<AgentRole, "implement" | "review" | "audit" | "retro" | "research">;
      readonly issue: number;
      /** The text the agent emitted as its structured output, unparsed. */
      readonly output: string;
      /**
       * For a Design-session turn the Operator's reply started: that comment's
       * id, from the Actions event the push job runs for, never from the agent.
       * None for the first round, which agent:design starts.
       */
      readonly startedBy?: number;
      /** For a Design turn on a Ticket sent back from an agent PR: the Operator comments on that PR it was given; none when left out. */
      readonly operatorComments?: readonly GivenOperatorComment[];
    }
  | {
      /** An Implement run's agent job finished; its push job has the branch it built, not yet pushed. */
      readonly kind: "implement-run-finished";
      /** The Ticket. */
      readonly issue: number;
      /** The Implementer's structured output (its PR title and summary), unparsed. */
      readonly output: string;
      /** The agent branch the run built (src/loop/agentPullRequest.ts). */
      readonly branch: string;
      /** The branch it was cut from, which the draft PR targets. */
      readonly base: string;
      /** What the branch changes, read from the bundle the agent job passed out. */
      readonly changes: BranchChanges;
      /** Its UI evidence, which the push job always passes; the core decides whether the run is UI. */
      readonly evidence?: ImplementEvidence;
      /**
       * For a retry: the agent PR it fixes, and the head it built on, which is
       * its branch's base, so `changes` holds only the retry's own commits;
       * and the Actions run, which a Verdict the push job posts links to.
       */
      readonly fixes?: {
        readonly pullRequest: number;
        readonly headSha: string;
        readonly runUrl: string;
        /** Whether the run was the Operator's Request changes rather than a retry. */
        readonly requestChanges?: boolean;
        /** The Operator comments on the PR the run was given; none when left out. */
        readonly operatorComments?: readonly GivenOperatorComment[];
      };
    }
  | {
      /** An agent job failed or was cancelled; the push job carries the news. */
      readonly kind: "agent-run-failed";
      readonly role: AgentRole;
      /** The Ticket (or issue) the run was for. */
      readonly issue: number;
      /** The Actions run, linked from the failure comment. */
      readonly runUrl: string;
      /** How the agent job ended, as GitHub's `needs.<job>.result` says it. */
      readonly jobResult: "failure" | "cancelled";
      /** The outcome of the step that loaded the agent's secrets from 1Password, or null if unknown. */
      readonly secretsStep: "success" | "failure" | "cancelled" | "skipped" | null;
      /** What the agent job reported about its own failure, or null if it left nothing. */
      readonly report: FailureReport | null;
      /**
       * The Subscription the run used, from the Kit job's `subscription`
       * output. Absent, it is read as the first listed Subscription.
       */
      readonly subscription?: string;
    }
  | { readonly kind: "issue-closed"; readonly issue: number }
  /** A PR was opened or pushed to, so its required checks start; a Review waits for them. */
  | { readonly kind: "pull-request-pushed"; readonly pullRequest: number }
  | { readonly kind: "pull-request-labeled"; readonly pullRequest: number; readonly label: string }
  | {
      /** An agent PR's required checks finished red, so the Reviewer didn't run. */
      readonly kind: "required-checks-finished";
      readonly pullRequest: number;
      /** The head commit the checks ran on. */
      readonly headSha: string;
      /** The required checks that didn't pass; empty when they all did. */
      readonly failed: readonly string[];
      /** The Review run, linked from the Verdict comment. */
      readonly runUrl: string;
    }
  | {
      /** The Reviewer finished on a green agent PR; its push job holds the Verdict, not yet posted. */
      readonly kind: "review-run-finished";
      readonly pullRequest: number;
      /** The head commit the checks passed on and the Reviewer judged. */
      readonly headSha: string;
      /** The Reviewer's reply, unparsed: a Verdict line, then its findings (src/loop/verdict.ts). */
      readonly output: string;
      readonly runUrl: string;
      /** The Product repo's web address, such as `https://github.com/acme/shop`, which a pass's Follow-ups open issues on. */
      readonly repoUrl: string;
      /** The Operator comments the Reviewer was given; none when left out. */
      readonly operatorComments?: readonly GivenOperatorComment[];
    }
  | {
      /** The Auditor finished on a pending Audit; its push job holds the reply, not yet landed (#150). */
      readonly kind: "audit-run-finished";
      /** The Audit. */
      readonly issue: number;
      /** The Auditor's structured output, the `<audit>` tag's JSON, unparsed (src/loop/auditOutput.ts). */
      readonly output: string;
      /** The hot-spot window the Auditor was given, as its agent job recorded it from the input the Kit wrote, never from the agent. */
      readonly window: AuditWindow;
      /** The Actions run, which a failed Audit links to. */
      readonly runUrl: string;
      /** The Product repo's web address, which an Audit's candidates open issues on. */
      readonly repoUrl: string;
    }
  | {
      /** A Retro run finished on a pending Retro; its push job holds the reply, not yet landed (#151). */
      readonly kind: "retro-run-finished";
      /** The Retro. */
      readonly issue: number;
      /** The Retro's structured output, the `<retro>` tag's JSON, unparsed (src/loop/retroOutput.ts). */
      readonly output: string;
      /** What the Retro was given, which the push job re-reads from the evidence job's artifact, never from the agent. */
      readonly evidence: RetroEvidence;
      /** The Actions run, which a failed Retro links to. */
      readonly runUrl: string;
      /** The Product repo's web address, which a Retro's evidence links to. */
      readonly repoUrl: string;
    }
  | {
      /** A review that requests changes was submitted on a PR: at the Merge gate, the Operator's ask for another run. */
      readonly kind: "pull-request-changes-requested";
      readonly pullRequest: number;
      /** The review's id, which the Request-changes run reads as its input. */
      readonly review: number;
      /** The login of whoever submitted it. */
      readonly reviewer: string;
      readonly reviewerIsBot: boolean;
    }
  | {
      /**
       * A comment on a PR: in its conversation, or a submitted review that
       * doesn't request changes. An Operator comment on an agent PR is context
       * for the next run that reads it, never a trigger (ADR-0007).
       */
      readonly kind: "pull-request-commented";
      readonly pullRequest: number;
      /** The login of whoever wrote it. */
      readonly commenter: string;
      readonly commenterIsBot: boolean;
      /** Where it was made: a conversation comment, or a review, whose inline comments carry its reactions. */
      readonly on: PullRequestCommentPlace;
    }
  | { readonly kind: "pull-request-left-draft"; readonly pullRequest: number }
  | { readonly kind: "pull-request-closed"; readonly pullRequest: number }
  /** A Dispatch check, which an earlier plan asked for with `check-dispatch`. */
  | { readonly kind: "dispatch-check" }
  /** A Design queue check, which an earlier plan asked for with `check-design-queue` (#147). */
  | { readonly kind: "design-queue-check" }
  /** A push to the default branch that changed the Kit config, which may have unpaused or widened Dispatch or the Design-session cap. */
  | { readonly kind: "kit-config-changed" }
  | {
      /** The scheduled Kit workflow's tick (schedule.yml), for the Loop's time-based rules. */
      readonly kind: "scheduled-tick";
      /** When the tick ran, as an ISO 8601 time. */
      readonly now: string;
    };

/**
 * The stretch of history an Auditor looks at first (#150): what changed since
 * the last Audit's commit, or the last 30 days on a first run or when that
 * commit isn't an ancestor of the Audit's own (a force-push).
 */
export type AuditWindow =
  | { readonly kind: "since-audit"; readonly audit: number; readonly commit: string }
  | { readonly kind: "last-days"; readonly days: number };

/**
 * What a Retro run was given, out of its evidence bundle (src/kit/retroEvidence.ts):
 * what landing the Retro checks its proposals against and links their
 * evidence by (src/loop/retroLanding.ts).
 */
export interface RetroEvidence {
  /** The span the evidence covers, from `start` (inclusive) to `end` (exclusive), ISO 8601. */
  readonly window: { readonly start: string; readonly end: string };
  /** Every ref the bundle holds, once each, as refsOf gives them: the only refs a proposal's evidence keeps. */
  readonly refs: readonly EvidenceRef[];
  /** Every agent PR merged in the 90 days to the window's end, with what breaks a streak: what a loosening's streak is counted against. */
  readonly streakTable: readonly StreakRow[];
  /** The store path of each Run record's transcript, by the record's ref; a record whose transcript didn't survive its run has none. */
  readonly transcripts: Readonly<Record<string, string>>;
}

/**
 * Where a PR comment was made: a conversation comment, by its id, or a
 * submitted review, by its id. GitHub takes reactions on a review's inline
 * comments but not on the review itself.
 */
export type PullRequestCommentPlace =
  | { readonly kind: "conversation"; readonly comment: number }
  | { readonly kind: "review"; readonly review: number };

/** An issue as the core sees it, gathered fresh by the GitHub adapter. */
export interface IssueSnapshot {
  readonly number: number;
  readonly open: boolean;
  readonly author: string;
  /**
   * Whether the Fabrik App itself opened it, not a person or any other bot:
   * only then is its body read for an Audit's or a Retro's markers
   * (src/loop/audit.ts, src/loop/retro.ts), and
   * only then does a Design session keep its body's Monitor marker (src/loop/design.ts).
   * The Kit job, which only routes and doesn't know the App's login, takes any
   * bot for the App, so another bot's look-alike pending Audit or Retro costs
   * one run, whose result the push job, which knows the login, drops
   * (src/github/snapshot.ts's byAppOf).
   */
  readonly byApp: boolean;
  /**
   * Its Markdown body as it stands, whose marker lines a Design session's
   * rewrite carries forward (src/loop/carriedLines.ts, src/loop/design.ts).
   */
  readonly body: string;
  readonly labels: readonly string[];
  /** The parent issue's number, or null if it isn't a sub-issue. */
  readonly parent: number | null;
  /**
   * The parent issue as it stands, or null if it isn't a sub-issue: a
   * research Decision's must be an open Map (src/loop/research.ts).
   */
  readonly parentIssue: ParentIssueSnapshot | null;
  /** The open pull requests linked to close this issue, oldest first. */
  readonly openPullRequests: readonly number[];
  /** How many rounds the Kit has posted in the issue's current Design session (src/loop/design.ts). */
  readonly designRounds: number;
  /** Whether a Design-session turn has failed in its current Design session, read from the Kit's failure notice. */
  readonly turnFailed: boolean;
  /**
   * Whether the Kit took agent:design off since the issue last got
   * needs-design: its current session's first turn has started, so it holds
   * a Design session slot even before round 1 posts.
   */
  readonly firstTurnClaimed: boolean;
  /**
   * The agent PR whose Verdict sent this Ticket back to design, read from the
   * Kit's note on it (src/loop/backToDesign.ts), while the Design session that
   * followed hasn't finished; otherwise null.
   */
  readonly sentBack: SentBack | null;
  /** How many Implement runs on it ended in an empty diff since its last Design session (src/loop/implement.ts). */
  readonly emptyDiffs: number;
  /** The open issues blocking it, by GitHub's native issue dependencies. */
  readonly openBlockers: readonly number[];
  /** The open issues it blocks. */
  readonly openBlocking: readonly number[];
}

/** A sub-issue's parent, as the adapter read it with the sub-issue: whether it's open, and its labels, which say whether it's a Map. */
export interface ParentIssueSnapshot {
  readonly number: number;
  readonly open: boolean;
  readonly labels: readonly string[];
}

/** A pull request as the core sees it. */
export interface PullRequestSnapshot {
  readonly number: number;
  /** Whether the Fabrik App opened it for a Ticket (src/loop/agentPullRequest.ts). */
  readonly isAgent: boolean;
  /** The Ticket its agent branch was cut for, or null if it isn't on one. */
  readonly ticket: number | null;
  readonly open: boolean;
  readonly draft: boolean;
  /** Its head commit now. */
  readonly headSha: string;
  readonly labels: readonly string[];
  /** The Verdicts the Fabrik App has posted on it, oldest first, read from their markers (src/loop/verdict.ts). */
  readonly verdicts: readonly VerdictRecord[];
  /** Whether its latest push came from a Request-changes run, so a Verdict on it is marked as one. */
  readonly requestChangesRun: boolean;
  /**
   * Whether a Retry or Request-changes run has pushed to it since its latest
   * Verdict, read from the Kit's note of the push. Until one has, the run that
   * Verdict (or the Operator's review) called for is still in flight (src/loop/retry.ts).
   */
  readonly pushedSinceVerdict: boolean;
  /** The latest review that requested changes on it, if any: what a stalled Request-changes run resumes from. */
  readonly changesRequested: ChangesRequestedReview | null;
  /**
   * Where its UI evidence is kept, read from the marker in the body the Fabrik
   * App wrote (src/evidence/uiEvidence.ts), or null when it has none: not a UI PR.
   */
  readonly uiEvidenceMarker: EvidenceMarker | null;
}

/** A review requesting changes on a PR, as GitHub records it. */
export interface ChangesRequestedReview {
  readonly review: number;
  readonly reviewer: string;
  readonly reviewerIsBot: boolean;
  /** The PR's head commit when the review was submitted. */
  readonly commitSha: string;
}

/** The Reviewer's judgment on a PR (GLOSSARY.md). */
export type Verdict = "pass" | "execution-flaw" | "design-flaw";

/** How sure the Auditor is of an Audit candidate: its badge, which the escape marker carries (#150). */
export type Strength = "strong" | "worth-exploring" | "speculative";

export const STRENGTHS: readonly Strength[] = ["strong", "worth-exploring", "speculative"];

/** Each Strength as people read it: an Audit card's badge, and its name in the Weekly summary. */
export const STRENGTH_LABELS: Readonly<Record<Strength, string>> = {
  strong: "Strong",
  "worth-exploring": "Worth exploring",
  speculative: "Speculative",
};

/** What a Verdict comment's marker records, so the core can read a PR's review history from its comments alone. */
export interface VerdictRecord {
  readonly verdict: Verdict;
  /**
   * The Reviewer judged it; or red required checks, or a retry whose branch
   * changed nothing, made it an Execution flaw.
   */
  readonly source: "reviewer" | "ci" | "empty-diff";
  /** Whether it came from a Request-changes run, which doesn't count as a retry. */
  readonly requestChanges: boolean;
  /** The head commit it was given on. */
  readonly headSha: string;
}

/** A `ready-for-agent` issue that a Dispatch check weighs. */
export interface TicketSnapshot {
  readonly number: number;
  readonly open: boolean;
  readonly labels: readonly string[];
  /** The issues blocking it that are still open. */
  readonly openBlockers: readonly number[];
  /** The issues blocking it that closed as not planned: their work never landed, so they still block it. */
  readonly notPlannedBlockers: readonly number[];
  /** How many sub-issues it has, open or closed. Any at all make it a Spec. */
  readonly subIssues: number;
  /** The open pull requests linked to close it. */
  readonly openLinkedPullRequests: readonly number[];
}

/**
 * An open `wayfinder:research` issue that a Dispatch check weighs: a research
 * Decision, which the Researcher resolves AFK when it's under an open Map
 * (src/loop/research.ts, #154).
 */
export interface ResearchDecisionSnapshot {
  readonly number: number;
  readonly open: boolean;
  readonly labels: readonly string[];
  /** The logins it's assigned to: the Operator assigning themselves claims it, as in `/wayfinder`. */
  readonly assignees: readonly string[];
  /** The issues blocking it that are still open. */
  readonly openBlockers: readonly number[];
  /** Its parent, which must be an open Map, or null when it isn't a sub-issue. */
  readonly parentIssue: ParentIssueSnapshot | null;
  /**
   * Whether the Kit's research failure notice is its latest run's word, read
   * from the Kit's comments on it: only the Operator re-adding agent:research
   * runs it again then.
   */
  readonly lastRunFailed: boolean;
}

/** What a Dispatch check needs: the Tickets it may release and the work already in flight. */
export interface DispatchSnapshot {
  /** Every open `ready-for-agent` issue, in any order. */
  readonly tickets: readonly TicketSnapshot[];
  readonly openAgentDraftPullRequests: number;
  readonly implementRunsInProgress: number;
  /** Every open `wayfinder:research` issue, in any order. No Dispatch check releases one yet (#154). */
  readonly researchDecisions: readonly ResearchDecisionSnapshot[];
}

/** An open `needs-design` issue that a Design queue check weighs (src/loop/designQueue.ts). */
export interface DesignQueueIssue {
  readonly number: number;
  readonly labels: readonly string[];
  /** How many rounds the Kit has posted in its current Design session. */
  readonly designRounds: number;
  /** Whether a Design-session turn has failed in its current Design session, read from the Kit's failure notice. */
  readonly turnFailed: boolean;
  /**
   * Whether its current Design session followed a Ticket going back to design:
   * the back-to-design note (a Design flaw, Retries used up, or the Operator's
   * needs-design at the Merge gate), or a third empty diff. A re-design starts first.
   */
  readonly redesign: boolean;
  /** When it last got `needs-design`, from its label timeline, as an ISO 8601 time. */
  readonly neededDesignAt: string;
}

/** What a Design queue check needs: the open `needs-design` issues and the Design turns in progress. */
export interface DesignQueueSnapshot {
  /** Every open `needs-design` issue, in any order. */
  readonly issues: readonly DesignQueueIssue[];
  /** The issue of each Design-session turn not yet finished: running, queued or waiting. */
  readonly designTurnsInProgress: readonly number[];
}

/**
 * The slice of GitHub state a Loop event needs to be decided. The adapter
 * gathers only the part the event is about and leaves the rest null.
 */
export interface Snapshot {
  /** The issue an issue event is about. */
  readonly issue: IssueSnapshot | null;
  /** The pull request a pull-request event is about. */
  readonly pullRequest: PullRequestSnapshot | null;
  /** Gathered for a Dispatch check only. */
  readonly dispatch: DispatchSnapshot | null;
  /** Gathered for a Design queue check only. */
  readonly designQueue: DesignQueueSnapshot | null;
  /** For an issue closing: the Spec it is a Ticket of, or null when it has no parent. */
  readonly spec: SpecSnapshot | null;
  /** The Operator's GitHub login: ready-for-human work is assigned to them, and Design rounds and failures @-mention them. */
  readonly operator: string;
  /** The open issues the Kit owns in this repo (token rotation, weekly limit), oldest first. Gathered for every event. */
  readonly kitIssues: readonly KitIssueSnapshot[];
  /**
   * For a Design-session turn the Operator's reply started: that comment, and
   * whether it is still on the issue. Null when the event names no such comment.
   */
  readonly startingComment: StartingComment | null;
  /** Gathered for a scheduled tick only: what the audit gate weighs. */
  readonly audit: AuditSnapshot | null;
  /** Gathered for a scheduled tick only: what the retro gate weighs. */
  readonly retro: RetroSnapshot | null;
  /**
   * Gathered for an Audit run finishing only, whose Audit is `issue`: each PR
   * its reply names under "Introduced by" that GitHub has, in any order. A
   * number naming no PR isn't here.
   */
  readonly namedPullRequests: readonly NamedPullRequestSnapshot[] | null;
  /**
   * Gathered for a scheduled tick only: each issue or PR a held marker on an
   * open weekly-limit issue names, that GitHub has, in any order, so that the
   * tick resumes only held runs still in the state they were held in
   * (src/loop/resume.ts). A number naming nothing GitHub has isn't here.
   */
  readonly held: readonly HeldTargetSnapshot[] | null;
}

/** An issue or PR a held run is on, as the adapter read it on a scheduled tick (src/loop/resume.ts). */
export interface HeldTargetSnapshot {
  readonly number: number;
  readonly open: boolean;
  readonly labels: readonly string[];
  /** For a PR, whether it's a draft; null for an issue. */
  readonly draft: boolean | null;
  /** Whether the Fabrik App itself opened it, as IssueSnapshot.byApp says. Only the App's body is read for markers. */
  readonly byApp: boolean;
  readonly body: string;
}

/** A PR an Auditor named, as GitHub has it (src/loop/auditLanding.ts). */
export interface NamedPullRequestSnapshot {
  readonly number: number;
  readonly merged: boolean;
  /** Its head branch. */
  readonly headRef: string;
  /** Whether it's an agent PR: one the Fabrik App opened from an agent branch (src/loop/agentPullRequest.ts). */
  readonly isAgent: boolean;
}

/** What the audit gate weighs on a scheduled tick (src/loop/auditGate.ts). */
export interface AuditSnapshot {
  /** The default branch's head commit, or null when it has none. */
  readonly head: string | null;
  /** The newest `fabrik:audit` issues, open and closed, in any order. */
  readonly issues: readonly AuditIssueSnapshot[];
}

/**
 * A weekly run's issue, a `fabrik:audit` or `fabrik:retro` issue, open or
 * closed, as the adapter read it through one query (src/github/snapshot.ts).
 */
export interface WeeklyIssueSnapshot {
  readonly number: number;
  /** Its title, which an Auditor or Retro run's inputs name each closed one by. */
  readonly title: string;
  readonly open: boolean;
  /** Why it was last closed, or reopened, as GitHub records it; null when it never was. */
  readonly stateReason: "completed" | "not_planned" | "duplicate" | "reopened" | null;
  /** When it was opened, as an ISO 8601 time. */
  readonly createdAt: string;
  /**
   * Whether the Fabrik App itself opened it, not a person or any other bot, as
   * IssueSnapshot.byApp says. Only the App's body is read for markers.
   */
  readonly byApp: boolean;
  readonly body: string;
}

/** A `fabrik:audit` issue, open or closed, as the adapter read it (src/loop/audit.ts). */
export type AuditIssueSnapshot = WeeklyIssueSnapshot;

/** What the retro gate weighs on a scheduled tick (src/loop/retroGate.ts). */
export interface RetroSnapshot {
  /**
   * Whether the fabrik-runs store is ready for a Retro to read: the Fabrik App
   * is installed on it, and it's private. A store that isn't means no Retro.
   */
  readonly storeReady: boolean;
  /** The newest `fabrik:retro` issues, open and closed, in any order. */
  readonly issues: readonly RetroIssueSnapshot[];
  /**
   * Whether any agent PR merged, or closed unmerged, since the window a Retro
   * opened now would start (src/loop/retro.ts): the last Retro's window end,
   * or 7 days before the tick on a first run.
   */
  readonly agentPullRequestClosed: boolean;
  /** Whether the Operator opened any issue with an escape marker since then. */
  readonly escapeFiled: boolean;
}

/** A `fabrik:retro` issue, open or closed, as the adapter read it (src/loop/retro.ts). */
export type RetroIssueSnapshot = WeeklyIssueSnapshot;

/** The Operator's reply that started a Design-session turn, as the adapter found it when the turn finished. */
export interface StartingComment {
  readonly id: number;
  /** False when GitHub no longer has it: the Operator deleted it. */
  readonly exists: boolean;
}

/** A Spec and its Tickets, which Spec closing weighs. */
export interface SpecSnapshot {
  readonly number: number;
  readonly open: boolean;
  /** The parent's labels: only one carrying ready-for-agent or ready-for-human is a Spec. */
  readonly labels: readonly string[];
  /** Every sub-issue, open or closed. */
  readonly tickets: readonly {
    readonly number: number;
    readonly open: boolean;
    /** The merged PRs that closed it. */
    readonly pullRequests: readonly number[];
  }[];
}

/** An open issue carrying one of the Kit's own labels, as the adapter read it (src/loop/kitIssues.ts). */
export interface KitIssueSnapshot {
  readonly number: number;
  readonly labels: readonly string[];
  /**
   * Its body, or empty when the App didn't open it: its markers steer agent
   * runs, so only the App's own text is read (ADR-0007).
   */
  readonly body: string;
  /** The App's own comments' text, every one, oldest first: anyone else's is left out. */
  readonly comments: readonly string[];
}

/** An issue event's snapshot, once the core has checked it holds the issue. */
export interface IssueContext {
  readonly issue: IssueSnapshot;
  readonly operator: Snapshot["operator"];
  readonly kitIssues: Snapshot["kitIssues"];
}

/** The resolved Kit config, every default filled in (src/kit/config.ts). */
export type { KitConfig } from "../kit/config.ts";

/** An issue an earlier `create-issue` action in the same plan creates, named by that action's key. */
export interface CreatedIssue {
  readonly created: string;
}

/** A comment an earlier `comment` action with a `key` in the same plan posts, linked by its URL. */
export interface PostedComment {
  readonly posted: string;
}

/** One change the GitHub adapter makes on the core's behalf. */
export type Action =
  | {
      /** Creates an issue, then links it under its parent and to its blockers. */
      readonly kind: "create-issue";
      /** Names the new issue for later actions in the plan. */
      readonly key: string;
      readonly title: string;
      readonly body: string;
      readonly labels: readonly Label[];
      /** The issue it becomes a sub-issue of: one created earlier in the plan, or an existing issue by its number. */
      readonly parent: CreatedIssue | number | null;
      /** The issues blocking it: each one created earlier in the plan, or an existing issue by its number. */
      readonly blockedBy: readonly (CreatedIssue | number)[];
      /** Who it is assigned to when it is created; none when left out. */
      readonly assignees?: readonly string[];
    }
  | {
      /** Comments on an issue, then closes it as completed: another issue now carries its work. */
      readonly kind: "close-as-superseded";
      readonly issue: number;
      /** The comment's Markdown, with each created issue written as its `#number`. */
      readonly comment: readonly (string | CreatedIssue)[];
    }
  | {
      /** Makes an existing issue wait on one created earlier in the plan, by a blocked-by edge. */
      readonly kind: "add-blocked-by";
      readonly issue: number;
      readonly blocker: CreatedIssue;
    }
  | { readonly kind: "add-labels"; readonly issue: number; readonly labels: readonly Label[] }
  | { readonly kind: "remove-label"; readonly issue: number; readonly label: Label }
  | {
      readonly kind: "comment";
      readonly issue: number;
      readonly body: string;
      /** Names the comment for later `comment-linking` actions in the plan, which link to it. */
      readonly key?: string;
    }
  | {
      /** Comments on an issue, linking comments posted earlier in the plan. */
      readonly kind: "comment-linking";
      readonly issue: number;
      /** The comment's Markdown, with each posted comment written as its URL. */
      readonly body: readonly (string | PostedComment)[];
    }
  | { readonly kind: "edit-issue-body"; readonly issue: number; readonly body: string }
  | { readonly kind: "assign"; readonly issue: number; readonly assignee: string }
  | { readonly kind: "close"; readonly issue: number; readonly reason: "not_planned" | "completed" }
  | {
      readonly kind: "open-issue";
      readonly title: string;
      readonly body: string;
      readonly labels: readonly Label[];
      readonly assignees: readonly string[];
    }
  | {
      /** Starts a role's agent job; the workflow does this by routing to it, not the adapter. */
      readonly kind: "start-agent-run";
      readonly role: AgentRole;
      readonly issue: number;
      /** For an Implement run that retries an agent PR: that PR, whose branch it builds on. */
      readonly pullRequest?: number;
      /** For a Request-changes run: the Operator's review, which is its input. It isn't a retry. */
      readonly requestChanges?: { readonly review: number };
      /** For an Implement run that is a Retry: its Retry number, and whether it Steps up. */
      readonly retry?: number;
      readonly stepUp?: boolean;
      /** For an Auditor run: the pending Audit's marked commit, which its job checks out and reads up to. */
      readonly commit?: string;
      /**
       * For a Review of a UI PR: where its marker says the UI evidence is kept,
       * which the Review job downloads for the Reviewer. A PR with no marker gets none.
       */
      readonly evidence?: EvidenceMarker;
      readonly model: string;
      readonly effort: string | null;
      readonly timeoutMinutes: number;
      /**
       * The Subscription it runs on: the `Fabrik` vault item name its job loads
       * the Claude token from. `planFor` gives it to every run it starts, in one
       * place for every role, so the builders of a run leave it out.
       */
      readonly subscription?: string;
    }
  | {
      /**
       * Holds a role's agent run, with rotation on, while every listed
       * Subscription is used up: no agent job starts. It changes nothing on
       * GitHub itself; the Plan's other actions take the trigger label off and
       * leave the held marker on a weekly-limit issue. The Kit job's step
       * summary reads it.
       */
      readonly kind: "hold-agent-run";
      readonly role: AgentRole;
      /** The issue or PR the run is on: the one its trigger label lives on, or the pending Audit. */
      readonly issue: number;
      /** The trigger label that resumes it, or null for an Auditor run, which has none. */
      readonly label: Label | null;
      /** When the first weekly-limit issue's limit resets, if known. */
      readonly until: string | null;
    }
  | {
      /**
       * Drops a held run rather than resume it, on the scheduled tick: its
       * issue or PR has closed, or moved on in the Loop, since it was held. It
       * changes nothing on GitHub itself; the step summary reads it.
       */
      readonly kind: "drop-held-run";
      readonly role: AgentRole;
      readonly issue: number;
      /** Why, such as "#7 is closed". */
      readonly reason: string;
    }
  /** Push the agent branch the Implement run built, which the push job holds from its bundle. */
  | { readonly kind: "push-branch"; readonly branch: string }
  | {
      /** Opens a PR as the Fabrik App, which starts CI on it. */
      readonly kind: "open-pull-request";
      /** The Ticket it closes. */
      readonly issue: number;
      readonly head: string;
      readonly base: string;
      readonly title: string;
      readonly body: string;
      readonly draft: true;
    }
  /** Closes a PR unmerged. Its branch stays, so nothing it built is lost. */
  | { readonly kind: "close-pull-request"; readonly pullRequest: number }
  /** Puts a PR back in draft, so the Loop reviews it again before it returns to the Merge gate. */
  | { readonly kind: "convert-to-draft"; readonly pullRequest: number }
  /** Takes a draft PR out of draft. */
  | { readonly kind: "mark-ready-for-review"; readonly pullRequest: number }
  | {
      /**
       * Reacts to a PR comment, so its author sees it arrived: the conversation
       * comment itself, or each inline comment of a review.
       */
      readonly kind: "react";
      readonly pullRequest: number;
      readonly on: PullRequestCommentPlace;
      readonly content: "eyes";
    }
  /** Requests a review on a PR: the Merge gate's one notification. */
  | { readonly kind: "request-review"; readonly pullRequest: number; readonly reviewer: string }
  /** Run a Dispatch check, in the Dispatch job, once the rest of this plan has landed. */
  | { readonly kind: "check-dispatch" }
  /** Run a Design queue check, in the Design queue job, once the rest of this plan has landed (#147). */
  | { readonly kind: "check-design-queue" }
  | {
      /**
       * Links a UI PR's preview deployment in its evidence section (#153). Not
       * a GitHub change itself: once this plan has pushed, the push job hands
       * it on to its preview step, which fills `template` in for the PR as the
       * push left it, polls that URL, and edits the section to link it, or to
       * say it never answered. Never a hosting provider's API.
       */
      readonly kind: "link-preview";
      /** The PR, or null for the one this plan opens. */
      readonly pullRequest: number | null;
      /** Kit config's `preview.url`. */
      readonly template: string;
      /** The PR's branch, which this plan pushes. */
      readonly branch: string;
    };

/**
 * What the core decided: actions to apply, nothing (with the reason why), or
 * that the run failed, which changes nothing and fails the job.
 */
export type Plan =
  | {
      readonly kind: "act";
      readonly actions: readonly Action[];
      /** What the run's step summary notes beside its actions, which changes nothing on GitHub: what a Retro's landing dropped, say. */
      readonly notes?: readonly string[];
    }
  | { readonly kind: "nothing"; readonly reason: string }
  | { readonly kind: "fail"; readonly failure: "infrastructure"; readonly reason: string };
