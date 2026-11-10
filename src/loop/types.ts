// The Loop rules core's interface: a Loop event, a snapshot of GitHub state and
// the resolved Kit config go in; a plan comes out.
import type { CaptureResult, EvidenceMarker } from "../evidence/uiEvidence.ts";
import type { ChangedPath } from "../guard/trust-root.ts";
import type { PlannedTicket, ReplayAcceptance, ReplayIssue, ReplayOutcomes, ReplayTicketEnd } from "../kit/replay.ts";
import type { EvidenceRef, StreakRow } from "../kit/retroEvidence.ts";
import type { RateLimitReading } from "../kit/runRecord.ts";
import type { SentBack } from "./backToDesign.ts";
import type { Label, TriggerLabel } from "./labels.ts";
import type { PrototypeRequestMarker } from "./markers.ts";

/** An AFK role whose agent job passes structured output to its push job. */
export type AgentRole = "triage" | "design" | "implement" | "review" | "audit" | "retro" | "research";

export const AGENT_ROLES: readonly AgentRole[] = ["triage", "design", "implement", "review", "audit", "retro", "research"];

/** How an agent job, or the Review checks job (src/review/wait.ts), says it failed, in the report it leaves for the push job (src/agent/failure.ts). */
export type ReportedFailure =
  | "crash"
  | "missing-output"
  | "provider-error"
  | "dead-token"
  | "weekly-limit"
  | "metered-billing"
  /** With rotation on, the stream watch stopped a run whose stream showed overage. */
  | "usage-credits"
  /** The Kit's input step couldn't read the agent's inputs from GitHub, so the agent never started (#328). */
  | "unread-inputs"
  /** A GitHub request failed while the Review waited for its required checks. */
  | "unread-checks"
  /** The Review gave up waiting on gating checks that never reported on the PR's head, which no re-run fixes. */
  | "unreported-checks"
  /**
   * A cut branch built on commits it didn't start from, so the push job,
   * which rebuilds it from its base alone, never could (#535).
   */
  | "unlandable-branch"
  /** The agent ended the run on another branch than its own (#434). */
  | "left-branch"
  /**
   * The job ran out of time: reported by the Review checks job when it gave up
   * on required checks still running, short of its job's timeout, or inferred
   * by the push job for any role whose job was cancelled (src/loop/failures.ts).
   */
  | "timeout";

/**
 * How an Implement run was a Broken run (#434): the Kit can't land its work
 * because of what the agent did. Its output broke the run's contract, it left
 * its branch, or it built on commits its branch didn't start from.
 */
export const BROKEN_RUNS = ["missing-output", "left-branch", "unlandable-branch"] as const satisfies readonly ReportedFailure[];
export type BrokenRun = (typeof BROKEN_RUNS)[number];

/** Whether a failure kind is one a Broken run can be; only an Implement run's is one (brokenRunOf). */
export function isBrokenRun(value: unknown): value is BrokenRun {
  return (BROKEN_RUNS as readonly unknown[]).includes(value);
}

/** Every kind of Infrastructure failure: what the agent job reported, or what the push job saw. */
export type InfrastructureFailure = ReportedFailure | "unreachable-1password";

/** What a failed agent job left for the push job, when it got far enough to leave anything. */
export interface FailureReport {
  readonly failure: ReportedFailure;
  /** One line on what went wrong, for the failure comment. */
  readonly detail: string;
  /** For the weekly limit, when it resets (an ISO 8601 time), if the stream said. */
  readonly resetsAt?: string;
  /**
   * For unread inputs: true when GitHub refused the request (a 4xx that isn't
   * a rate limit), which it does again each time the run goes again, until the Kit is fixed.
   * Absent for a 5xx, a rate limit or a call GitHub never answered.
   */
  readonly refused?: true;
  /**
   * For a Review that gave up waiting on its required checks: the gating
   * checks that never reported, or for a timeout, the ones still running.
   */
  readonly checks?: readonly string[];
  /**
   * For a run that cut a branch (#431): what it had committed on it when it
   * failed, so the notice says whether any work was made and whether it was
   * kept. Absent when the run had no branch, or it couldn't be read.
   */
  readonly commits?: FailedRunCommits;
}

/**
 * What a failed run had committed on its branch. Its commits are never pushed:
 * the push job lands only a result it can read, so a re-run starts where this
 * one did: from `base` again on a branch it continued, or from the default
 * branch's head of the time on a branch it cut.
 */
export interface FailedRunCommits {
  /** The commit the run started at. */
  readonly base: string;
  /** Whether the run carried on its branch from `base` (a run on a PR, a later prototype round), rather than cut it from the default branch. */
  readonly continued: boolean;
  /** The branch's last commit, or null if the run made none. */
  readonly head: string | null;
  /** Whether its commits went out as a bundle with the failure report, for the Operator to fetch. */
  readonly kept: boolean;
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
  /**
   * For a Request-changes run its agent job told to merge main in (#341),
   * because the head it started on conflicted with main: the default branch
   * head it was told to merge, and whether the branch it built resolves that
   * conflict, holding that head or merging cleanly with it. Absent for every
   * other run.
   */
  readonly mainMerge?: { readonly main: string; readonly resolved: boolean };
  /**
   * For a run on its agent PR's own branch with something to push: the commit
   * its push lands as the branch's head, which its push note names (pushedHeadMarker).
   */
  readonly pushedHead?: string;
  /**
   * For an Implement run with commits: the test files its own commits
   * changed, deleted or moved that were already there before it (#463), on
   * the head it built on, or on main for one that brought main in. Absent
   * for any other branch.
   */
  readonly changedTests?: readonly string[];
  /**
   * For a Kept-branch start (#536), whose `net`, `commits` and `changedTests`
   * hold only the run's own changes: the whole branch against main as its
   * push lands it, what its new PR's changed-tests section and UI evidence
   * are worked out from, since that PR is the whole branch.
   */
  readonly wholeBranch?: { readonly net: readonly ChangedPath[]; readonly changedTests: readonly string[] };
  /**
   * For a prototype turn's branch (#155) that moved while the turn ran, as a
   * live Design session's push may move it: the head the turn started on
   * (null when it cut the branch afresh, there being none) and where the
   * branch is now (null when it's gone). A prototype branch is only ever
   * fast-forwarded from the head its turn started on, so there's nothing to push.
   */
  readonly moved?: { readonly from: string | null; readonly to: string | null };
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
       * their own events, which carry what their push jobs hold.
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
      /** The branch it was cut from, which the draft PR targets: for a Kept-branch start, the default branch it opens against. */
      readonly base: string;
      /** What the branch changes, read from the bundle the agent job passed out. */
      readonly changes: BranchChanges;
      /** Its UI evidence, which the push job always passes; the core decides whether the run is UI. */
      readonly evidence?: ImplementEvidence;
      /**
       * The push job's Actions run, which an empty diff's comment links to, a
       * first run's as much as a retry's (#429). On a retry it is the same run
       * as `fixes.runUrl`, which the retry's own comments go on linking.
       */
      readonly runUrl: string;
      /**
       * For a Kept-branch start (#536), from the Kit job's plan: it carried on
       * the Ticket's Kept branch, so `changes` holds only its own commits, and
       * the PR it opens names `pullRequest`, the closed one, when known.
       */
      readonly keptBranch?: KeptBranchStart;
      /**
       * For a retry: the agent PR it fixes, and the head it built on, which is
       * its branch's base, so `changes` holds only the retry's own commits;
       * and the Actions run, which a Verdict the push job posts links to.
       */
      readonly fixes?: {
        readonly pullRequest: number;
        readonly headSha: string;
        readonly runUrl: string;
        /**
         * For a Request-changes run, rather than a retry: the Operator's review
         * it was started for, which its answers are about (#369).
         */
        readonly review?: number;
        /** For a Retry: its number, from the Kit job's plan, so a Retry left over from an earlier flaw never lands (#341). */
        readonly retry?: number;
        /** For a Retry: the head of the Execution flaw it was started for, from the Kit job's plan (#341). */
        readonly retryFlaw?: string;
        /**
         * For a conflict-only run (#304): the default branch's head it was
         * started to bring the PR up to date with. It isn't a retry.
         */
        readonly conflict?: string;
        /** The Operator comments on the PR the run was given; none when left out. */
        readonly operatorComments?: readonly GivenOperatorComment[];
      };
    }
  | {
      /** An agent job failed or was cancelled; the push job carries the news. */
      readonly kind: "agent-run-failed";
      readonly role: AgentRole;
      /**
       * For a Design-session turn: whether it was the session's prototype turn
       * (#155), from the Kit job's `prototype` output, which ran within the
       * Implement role's timeout. Absent, it was an ordinary turn.
       */
      readonly prototype?: boolean;
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
      /**
       * For a conflict-only run (#304), from the Kit job's outputs: the agent
       * PR it was on, and the default branch's head it was started for.
       */
      readonly conflict?: { readonly pullRequest: number; readonly main: string };
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
      /** The ones among `failed` that were skipped or reported neutral, which no Retry changes; absent when none were. */
      readonly skipped?: readonly string[];
      /** What the Kit's re-run of the red checks came to (#462); absent when it didn't try, as from a Kit before it. */
      readonly rerun?: RerunReport;
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
      /** The red checks that passed when the Kit re-ran them on this head, which let the Reviewer run (#462); absent when none did. */
      readonly flaky?: readonly FlakyCheck[];
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
      /** A Researcher run finished on a research Decision; its push job has the branch it built, not yet pushed (#154). */
      readonly kind: "research-run-finished";
      /** The Decision. */
      readonly issue: number;
      /** The Researcher's structured output, the `<research>` tag's JSON, unparsed (src/loop/researchOutput.ts). */
      readonly output: string;
      /** The research branch the run built (src/loop/researchPaths.ts), which names the one findings file it may change. */
      readonly branch: string;
      /** What the branch changes, read from the bundle the agent job passed out. */
      readonly changes: BranchChanges;
      /** The Actions run, which the resolution and a refused branch's failure notice link to. */
      readonly runUrl: string;
      /** The Product repo's web address, by which the resolution links the findings file on the branch. */
      readonly repoUrl: string;
    }
  | {
      /**
       * A Design session's prototype turn finished (#155); its push job has the
       * issue's prototype branch it built, not yet pushed, and what capture
       * recorded of its variants.
       */
      readonly kind: "prototype-run-finished";
      readonly issue: number;
      /** The prototype turn's structured output, its prototype-round, unparsed (src/loop/designOutput.ts). */
      readonly output: string;
      /**
       * The prototype request the turn built, as the Kit job's plan passed it
       * out, never from the agent: what the push job checks is still one of
       * the session's unanswered requests, and, in it, the Operator's reply
       * that approved it, which must still exist for the round to post.
       */
      readonly request: PrototypeRequestMarker;
      /** The issue's prototype branch (prototypeBranchFor). */
      readonly branch: string;
      /** What this turn's commits change, read from the bundle the prototype job passed out. */
      readonly changes: BranchChanges;
      /** The commit the push leaves the branch at, which the round links each variant's component at; null when the turn made no commit. */
      readonly headSha: string | null;
      /** What capture recorded, read from the prototype job's outputs; absent when the job passed out none the push job could read. */
      readonly capture?: CaptureResult;
      /** The prototype gallery's web address, or null when the job kept none. */
      readonly gallery: string | null;
      /** The Actions run, which a failure round links to. */
      readonly runUrl: string;
      /** The Product repo's web address, by which the round links the branch and each variant's component. */
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
  | {
      /**
       * A replay Ticket's run ended (#156): its replay-record job, the
       * replay's push job, saw how both arms went and lands it on the replay
       * issue (src/loop/replayRun.ts).
       */
      readonly kind: "replay-run-finished";
      /** The replay issue. */
      readonly issue: number;
      /** The Ticket the run replayed. */
      readonly ticket: number;
      /** The Actions run its claim marked the Ticket in progress in. */
      readonly run: number;
      readonly end: ReplayTicketEnd;
      /** The Actions run, which a weekly-limit issue links to. */
      readonly runUrl: string;
      /** The Subscription both arms ran on, from the Kit job's `subscription` output. Absent, it is read as the first listed. */
      readonly subscription?: string;
      /** For a weekly-limit refusal, when the limit resets (an ISO 8601 time), if the stream said. */
      readonly resetsAt?: string;
      /**
       * What the store holds of the Replay once the job wrote this run's files,
       * which its results are rewritten from (withReplayResults): this repo's
       * Run records and score files, and each arm's gates. Null when the store
       * couldn't be read, so the results the body shows stay as they are.
       */
      readonly outcomes: Omit<ReplayOutcomes, "open"> | null;
    }
  | { readonly kind: "pull-request-left-draft"; readonly pullRequest: number }
  | {
      readonly kind: "pull-request-closed";
      readonly pullRequest: number;
      /** Whether it closed by merging. */
      readonly merged: boolean;
      /**
       * Whether a bot closed it, which for an agent PR is taken for the Kit's
       * own close (Send it back, back to design, a refusal, its Ticket
       * closing), not the Operator's by hand (#428). The Kit job doesn't know
       * the App's login, so another bot's close counts as the Kit's too, and
       * only frees the PR's slot, as every close did before.
       */
      readonly closedByBot: boolean;
    }
  /** A Dispatch check, which an earlier plan asked for with `check-dispatch`. */
  | { readonly kind: "dispatch-check" }
  /** A Design queue check, which an earlier plan asked for with `check-design-queue` (#147). */
  | { readonly kind: "design-queue-check" }
  /**
   * A push to the default branch (#304): an open agent PR may now conflict
   * with it, which the conflict check weighs (src/loop/conflicts.ts).
   */
  | {
      readonly kind: "main-pushed";
      /** The default branch's new head commit. */
      readonly head: string;
    }
  /**
   * A push to the default branch that changed the Kit config, or can't show it
   * didn't, which may have unpaused or widened Dispatch or the Design-session
   * cap. It is a push to the default branch too, so the conflict check runs on
   * it as on `main-pushed`.
   */
  | {
      readonly kind: "kit-config-changed";
      /** The default branch's new head commit. */
      readonly head: string;
    }
  | {
      /** The scheduled Kit workflow's tick (schedule.yml), for the Loop's time-based rules. */
      readonly kind: "scheduled-tick";
      /** When the tick ran, as an ISO 8601 time. */
      readonly now: string;
      /** The Fabrik release the Tick runs on, such as v1.1.0, which closing a Dead-tick issue names; absent when it isn't known. */
      readonly release?: string;
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
 * submitted review, by its id. A review takes a reaction on itself only
 * through GraphQL, by its node id, and on each of its inline comments through
 * REST (#435).
 */
export type PullRequestCommentPlace =
  | { readonly kind: "conversation"; readonly comment: number }
  | {
      readonly kind: "review";
      readonly review: number;
      /** The review's GraphQL node id, which a reaction on the review itself names. */
      readonly node: string;
      /** Whether the review has a body: one with none, as a lone inline comment submits, is read through its inline comments. */
      readonly hasBody: boolean;
    };

/**
 * A Design session's pending prototype request (#155), as the snapshot reads
 * it from the Fabrik App's request comment: what it asks for, the comment it
 * is, and whether its prototype turn has started, which the Kit marks on that
 * comment as the turn starts, and clears if the turn is refused on its
 * Subscription and held or re-run.
 */
export interface PendingPrototype extends PrototypeRequestMarker {
  readonly comment: number;
  readonly started: boolean;
}

/** An issue as the core sees it, gathered fresh by the GitHub adapter. */
export interface IssueSnapshot {
  readonly number: number;
  /** Its title as it stands: a research Decision's line in its Map's Decisions so far names it by this (src/loop/researchLanding.ts). */
  readonly title: string;
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
  /**
   * The pull requests linked to close this issue that have merged, oldest
   * first: its work landed, though GitHub sometimes leaves it open after (#543).
   */
  readonly mergedPullRequests: readonly number[];
  /**
   * Those of them that are open agent draft PRs on its own agent branch, the
   * kind that holds a max_in_flight slot: closing it closes them (#428).
   */
  readonly openAgentDrafts: readonly number[];
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
   * Its current Design session's pending prototype request (#155): the
   * latest prototype request with no prototype round, prototype failure
   * round or failed turn since, whose approving reply, if one approved it, is
   * still there, read from the Fabrik App's comments (src/github/threads.ts);
   * null when there is none. While one is pending, agent:design starts the
   * session's prototype turn (src/loop/design.ts).
   */
  readonly pendingPrototype: PendingPrototype | null;
  /**
   * Its current Design session's prototype requests that no prototype round
   * or prototype failure round has answered (#155), oldest first, read from
   * the Fabrik App's comments: what a prototype turn's result may still land
   * on (src/loop/prototypeLanding.ts), though another turn's failure notice
   * has ended its request as pending.
   */
  readonly unansweredPrototypes: readonly PrototypeRequestMarker[];
  /**
   * The agent PR whose Verdict sent this Ticket back to design, read from the
   * Kit's note on it (src/loop/backToDesign.ts), while the Design session that
   * followed hasn't finished; otherwise null.
   */
  readonly sentBack: SentBack | null;
  /**
   * How many Implement runs on it landed nothing before its PR opened, since
   * its last Design session: its empty diffs (src/loop/implement.ts) and its
   * Broken runs (#434, src/loop/failures.ts). Each used one of its Retries.
   */
  readonly landedNothing: number;
  /**
   * While it's marked for a Kept-branch start (#536): its Kept branch on the
   * remote. Null when the mark is off, so the adapter doesn't read it, or the
   * branch is gone.
   */
  readonly keptBranch: KeptBranch | null;
  /** The open issues blocking it, by GitHub's native issue dependencies. */
  readonly openBlockers: readonly number[];
  /** The open issues it blocks. */
  readonly openBlocking: readonly number[];
}

/**
 * A Ticket's Kept branch (#536): the agent branch of a pull request the Kit
 * closed unmerged, as it is on the remote.
 */
export interface KeptBranch {
  /** Its head now. */
  readonly head: string;
  /** The latest closed, unmerged PR from it, which the new PR names; null when none is found. */
  readonly pullRequest: number | null;
}

/**
 * What a Kept-branch start (#536) carries from the Kit job's plan to its push
 * job: the closed PR whose Kept branch it carries on, which its new PR names,
 * or null when none was found.
 */
export interface KeptBranchStart {
  readonly pullRequest: number | null;
}

/** A sub-issue's parent, as the adapter read it with the sub-issue: whether it's open, and its labels, which say whether it's a Map. */
export interface ParentIssueSnapshot {
  readonly number: number;
  readonly open: boolean;
  readonly labels: readonly string[];
}

/**
 * Why an Implement run is on the Step-up model: the second Retry, a Ticket
 * marked for a Stepped-up start (ADR-0014), the Operator's Request changes,
 * or a conflict-only run (#304). In the order the Weekly summary lists them.
 */
export const STEP_UP_REASONS = ["retry", "marked", "request-changes", "conflict-only"] as const;
export type StepUpReason = (typeof STEP_UP_REASONS)[number];

export function isStepUpReason(value: unknown): value is StepUpReason {
  return (STEP_UP_REASONS as readonly unknown[]).includes(value);
}

/** A pull request as the core sees it. */
export interface PullRequestSnapshot {
  readonly number: number;
  /** Whether the Fabrik App opened it for a Ticket (src/loop/agentPullRequest.ts). */
  readonly isAgent: boolean;
  /** The Ticket its agent branch was cut for, or null if it isn't on one. */
  readonly ticket: number | null;
  /**
   * That Ticket's labels as this snapshot read them, through the PR's closing
   * link to it, or none when there's no Ticket or the PR doesn't link it. Its
   * Verdict reads them to say whether the Retry it starts Steps up (ADR-0014).
   */
  readonly ticketLabels: readonly string[];
  /** Whether that Ticket is open, read the same way; false when there's no Ticket or the PR doesn't link it. */
  readonly ticketOpen: boolean;
  /**
   * How many Implement runs on that Ticket landed nothing before this PR
   * opened, since its last Design session, read like IssueSnapshot.landedNothing from the Ticket's
   * comments through the PR's closing link, or 0 when there's no such link.
   * Each used up one of the Ticket's Retries, so a Verdict counts on from them (#415).
   */
  readonly ticketLandedNothing: number;
  readonly open: boolean;
  readonly draft: boolean;
  /** Its head commit now. */
  readonly headSha: string;
  readonly labels: readonly string[];
  /** The Verdicts the Fabrik App has posted on it, oldest first, read from their markers (src/loop/verdict.ts). */
  readonly verdicts: readonly VerdictRecord[];
  /** Whether its latest push came from a Request-changes run, so a Verdict on it is marked as one. */
  readonly requestChangesRun: boolean;
  /** Whether its latest push came from a conflict-only run (#304), so a Verdict on it is marked as one. */
  readonly conflictRun: boolean;
  /**
   * The default branch heads the Kit has tried to bring it up to date with
   * (#304), read from the Kit's attempt notes on it, oldest first: one attempt
   * per head, whether its mechanical rebase was clean or started a conflict-only run.
   */
  readonly conflictAttempts: readonly string[];
  /**
   * The default branch head a conflict-only run on it was started for, while
   * that run hasn't pushed or ended (#304); otherwise null.
   */
  readonly conflictRunInFlight: string | null;
  /**
   * Whether that conflict-only run was started on a draft whose push GitHub
   * never reviewed (#389), not a PR at the Merge gate: its Verdict counts as
   * the unreviewed push's own would have, so it isn't marked as from a
   * conflict-only run. False while none is in flight.
   */
  readonly conflictRunOnUnreviewedDraft: boolean;
  /**
   * Whether a Retry, Request-changes or conflict-only run has pushed to it
   * since its latest Verdict, read from the Kit's note of the push, unless that
   * note names a head that never reached the branch (#420). Until one has, the Retry
   * that Verdict called for is still in flight (src/loop/retry.ts).
   */
  readonly pushedSinceVerdict: boolean;
  /**
   * The Kit's note since its latest Verdict on the Retry that Verdict called
   * for, which never started (#416), or null: `restarted` when the Kit re-added
   * agent:implement for it, which it does once, or `ended` when its Ticket was
   * no longer `ready-for-agent`, so no Retry is in flight.
   */
  readonly retryNoteSinceVerdict: "restarted" | "ended" | null;
  /** When the Fabrik App posted its latest Verdict, as an ISO 8601 time, or null when it has none. */
  readonly verdictPostedAt: string | null;
  /**
   * When its current head was pushed, as an ISO 8601 time, as best its history
   * tells (#389): the latest of its force pushes, the Kit's notes of its own
   * pushes, its opening by the Fabrik App, and its head commit's commit time,
   * each of which is no later than the push. Null when none of them is known.
   * What the conflict check waits a Review's grace period (reviewGraceMinutes) from before it brings
   * a draft whose push GitHub never reviewed up to date with main.
   */
  readonly headPushedAt: string | null;
  /**
   * The reviews requesting changes on it, oldest first, that were submitted
   * while it was out of draft and that nothing has settled since (#341): no
   * Request-changes run has pushed or been given a Verdict, and no Review has
   * passed it. A run that ended without pushing settles nothing.
   */
  readonly unbuiltChangesRequests: readonly UnbuiltChangesRequest[];
  /**
   * Of those, the ids a Request-changes run was started for (#341): named by
   * the Kit's note that started it, whether the review was delivered or not,
   * or by an Execution flaw that gave way to it. The Kit never notes one twice.
   */
  readonly notedChangesRequests: readonly number[];
  /**
   * The review the Request-changes run in flight on it is for (#341), or null:
   * the latest of those its starting note named that the Operator hasn't
   * dismissed, while that run hasn't pushed, been given a Verdict or ended,
   * and the PR hasn't left draft since it started.
   */
  readonly requestChangesRunInFlight: number | null;
  /**
   * Every review that Request-changes run is for, dismissed or not, while it's
   * in flight, and none otherwise: a run started for any of them is that run,
   * and only it lands (#341).
   */
  readonly requestChangesRunReviews: readonly number[];
  /** When the Kit's note or Verdict that started that run was posted, while it's in flight; else null. */
  readonly requestChangesRunSince: string | null;
  /**
   * Whether the Kit's Implement failure notice came after that run started,
   * while it's in flight (#424): it ended in an Infrastructure failure, which
   * leaves it in flight for the Operator's re-add of agent:implement to resume,
   * and the Loop never restarts it by itself.
   */
  readonly requestChangesRunFailed: boolean;
  /**
   * The Operator's Request changes on the draft, after the Kit's note put it in
   * draft for reviews they have since dismissed every one of, before that run
   * had an outcome (#341): the run owed now, which agent:implement starts.
   */
  readonly orphanedChangesRequests: readonly number[];
  /**
   * Whether the Operator has dismissed every review of the Request-changes run
   * the Kit put the PR in draft for, before it had an outcome (#341): that run
   * is over, and the PR is theirs again unless one of their reviews is owed.
   */
  readonly requestChangesRunDismissed: boolean;
  /**
   * The Operator's Request changes on the draft while a Retry was in flight
   * (#427), that no run has been started for: they count as unbuilt and noted,
   * but neither that Retry's Review nor a Retry is given them, and the Verdict
   * that ends the Retry, pass or Execution flaw, gives way to them.
   */
  readonly deferredChangesRequests: readonly number[];
  /** Whether the PR has left draft since its latest Verdict, so no Retry that Verdict called for is in flight. */
  readonly leftDraftSinceVerdict: boolean;
  /** Its web address, which the Kit's notes link the Operator's reviews from. */
  readonly url: string;
  /**
   * Where its UI evidence is kept, read from the marker in the body the Fabrik
   * App wrote (src/evidence/uiEvidence.ts), or null when it has none: not a UI PR.
   */
  readonly uiEvidenceMarker: EvidenceMarker | null;
  /**
   * The existing tests its Implement runs changed (#463), read from the
   * marker in the body the Fabrik App wrote (src/loop/changedTests.ts), or
   * none, so a later run's push lists them beside its own.
   */
  readonly changedTests: readonly string[];
}

/** A review requesting changes on an agent PR that no Request-changes run has built yet (#341). */
export interface UnbuiltChangesRequest {
  readonly review: number;
  readonly reviewer: string;
  readonly reviewerIsBot: boolean;
  /** When it was submitted, as an ISO 8601 time. */
  readonly submittedAt: string;
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

/** A check run on a head commit, as the tick reads them for its Flaky check sweep (#462). */
export interface HeadCheckRun {
  readonly name: string;
  readonly status: string;
  /** GitHub's conclusion once it completed: success, failure, timed_out, cancelled, skipped, neutral…; null before. */
  readonly conclusion: string | null;
  readonly startedAt: string | null;
  readonly url: string;
}

/** An open agent PR's ci-sourced Execution flaw not yet counted back, and every check run on its head (#462). */
export interface FlawHeadChecks {
  readonly pullRequest: number;
  readonly ticket: number | null;
  readonly headSha: string;
  /** The checks the Verdict named as failed. */
  readonly checks: readonly string[];
  readonly checkRuns: readonly HeadCheckRun[];
}

/** A required check that reported both failure and success on the same head commit (GLOSSARY.md), with a link to a run of each. */
export interface FlakyCheck {
  readonly name: string;
  readonly red: string;
  readonly green: string;
}

/**
 * What the Kit's re-run of an agent PR's red required checks came to (#462,
 * ADR-0018): it re-runs the GitHub Actions ones once on the same head.
 */
export interface RerunReport {
  /** The red checks that aren't GitHub Actions, which only their owner can re-run. */
  readonly outside: readonly string[];
  /** The re-run checks that failed again. */
  readonly failedAgain: readonly string[];
  /** The re-run checks that passed: Flaky checks. */
  readonly flaky: readonly FlakyCheck[];
  /** Why the Kit re-ran none of the Actions ones it could have, as GitHub refusing; null when it re-ran them, or there were none. */
  readonly refused: string | null;
}

/** What a Verdict comment's marker records, so the core can read a PR's review history from its comments alone. */
export interface VerdictRecord {
  readonly verdict: Verdict;
  /**
   * The Reviewer judged it; or red required checks, a retry whose branch
   * changed nothing, or a retry that was a Broken run (#434), made it an
   * Execution flaw.
   */
  readonly source: "reviewer" | "ci" | "empty-diff" | "broken-run";
  /**
   * Whether it came from a Request-changes run, which uses no retry itself. An
   * Execution flaw on its push still calls for one, and counts (#393).
   */
  readonly requestChanges: boolean;
  /**
   * True when it came from a conflict-only run (#304), which isn't a retry
   * either, though an Execution flaw on its push calls for one and counts
   * (#415); absent otherwise, as on every marker from before them.
   */
  readonly conflictRun?: true;
  /**
   * On an Execution flaw that gave way to the Operator's Request changes no
   * run had built (#341), those reviews' ids: it called for no Retry, doesn't
   * count as one, and started their Request-changes run; on a pass that gave
   * way to those deferred during a Retry (#427), likewise; absent otherwise.
   */
  readonly requestChangesFirst?: readonly number[];
  /**
   * True on an Execution flaw whose Ticket was no longer `ready-for-agent`
   * when it was given (#416): it called for no Retry, doesn't count as one,
   * and started nothing; absent otherwise.
   */
  readonly ticketNotReady?: true;
  /** On one from red required checks (#462), the ones it named as failed, which a later green on its head is read against; absent otherwise, as on every marker from before them. */
  readonly checks?: readonly string[];
  /**
   * True when the checks it named have since passed on its head (#462): a
   * Flaky check, so it no longer counts toward the Ticket's Retries. Read from
   * the Kit's Flaky check line, never from the Verdict's own marker.
   */
  readonly flaky?: true;
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
  /**
   * The pull requests linked to close it that have merged: its work landed,
   * though GitHub sometimes leaves it open after (#543).
   */
  readonly mergedLinkedPullRequests: readonly number[];
  /**
   * Whether the Kit's Implement failure notice is its latest run's word, read
   * from the Kit's comments on it: only the Operator re-adding agent:implement
   * runs it again then (#418).
   */
  readonly lastRunFailed: boolean;
  /**
   * While it's marked for a Kept-branch start (#536): its Kept branch on the
   * remote, or null when it's gone. Absent when unmarked, as the adapter reads
   * it for a marked Ticket only.
   */
  readonly keptBranch?: KeptBranch | null;
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
  /** Every open `wayfinder:research` issue, in any order: the core weighs which are research Decisions on an open Map. */
  readonly researchDecisions: readonly ResearchDecisionSnapshot[];
  /** Research jobs not yet finished: they hold slots under max_in_flight with the Implement runs. */
  readonly researchRunsInProgress: number;
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
   * The open Flaky check issues the Fabrik App filed (#462), by FLAKY_CHECK_LABEL: a
   * Flaky check found again comments on its check's issue rather than filing another.
   * Read for a Review's push job and the scheduled tick; empty for any other event.
   */
  readonly flakyCheckIssues: readonly KitIssueSnapshot[];
  /**
   * For the scheduled tick: each open agent PR's ci-sourced Execution flaws not
   * yet counted back, with every check run on the head each was given on (#462);
   * "no-permission" when the Fabrik App lacks Checks: read; null for any other event.
   */
  readonly flakySweep: readonly FlawHeadChecks[] | "no-permission" | null;
  /**
   * For a Design-session turn the Operator's reply started: that comment, and
   * whether it is still on the issue. Null when the event names no such comment.
   */
  readonly startingComment: StartingComment | null;
  /**
   * For a Comment or Approve review with no body: whether it holds any inline
   * comment, so one with none, such as a bare Approve, has nothing to
   * acknowledge (#435). Null for a review with a body, or any other event.
   */
  readonly reviewHasInlineComments: boolean | null;
  /** Gathered for a scheduled tick only: what the audit gate weighs. */
  readonly audit: AuditSnapshot | null;
  /** Gathered for a scheduled tick only: what the retro gate weighs. */
  readonly retro: RetroSnapshot | null;
  /**
   * For an event that may fail a weekly run, on an issue labelled
   * `fabrik:audit` or `fabrik:retro`: that label's newest issues, open and
   * closed, the event's own among them, as the gate reads them. A failure that
   * gives up on the week tells the Operator by them (src/loop/weeklyRuns.ts).
   * Null for any other event.
   */
  readonly weeklyIssues: readonly WeeklyIssueSnapshot[] | null;
  /**
   * Gathered for a scheduled tick: what the replay step weighs. And for
   * agent:replay added: every open replay issue alone, which a replay
   * Ticket's claim weighs, with no capacity or acceptance read.
   */
  readonly replay: ReplaySnapshot | null;
  /**
   * Gathered for an Audit run finishing only, whose Audit is `issue`: each PR
   * its reply names under "Introduced by" that GitHub has, in any order. A
   * number naming no PR isn't here.
   */
  readonly namedPullRequests: readonly NamedPullRequestSnapshot[] | null;
  /**
   * Gathered for a scheduled tick, and for whatever may free a Subscription
   * (#439): each issue or PR a held marker on an open carrier (a
   * weekly-limit, usage-credits or token-rotation issue), or on
   * closedKitIssue, names, that GitHub has, in any order, so that only
   * held runs still in the state they were held in resume
   * (src/loop/resume.ts). A number naming nothing GitHub has isn't here.
   */
  readonly held: readonly HeldTargetSnapshot[] | null;
  /**
   * Gathered for an issue-closed event on a weekly-limit, usage-credits or
   * token-rotation issue only: that issue, as kitIssues holds an open one,
   * since it has left kitIssues, so that the runs held on it resume as it
   * closes (#440, #470). Null for any other event.
   */
  readonly closedKitIssue: KitIssueSnapshot | null;
  /**
   * Gathered for a Design-session turn finishing only: the open `wayfinder:map`
   * issues, by number, oldest first, whoever made them, the Kit or the
   * Operator by hand. What the Map cap counts (src/loop/mapCap.ts).
   */
  readonly openMaps: readonly number[] | null;
  /**
   * Gathered for a push to the default branch and a scheduled tick only: what
   * the conflict check weighs (src/loop/conflicts.ts, #304).
   */
  readonly conflicts: ConflictSnapshot | null;
  /**
   * Gathered for a Reviewer's Verdict only: whether its PR merges cleanly into
   * the default branch, so a pass on one that conflicts brings it up to date
   * instead of opening the Merge gate (src/loop/review.ts, #480).
   */
  readonly mergeable: MergeableSnapshot | null;
  /**
   * Gathered for a scheduled tick only: what the stuck-trigger sweep weighs
   * (src/loop/triggerSweep.ts, #419).
   */
  readonly triggers: TriggerSweepSnapshot | null;
  /**
   * Gathered for a scheduled tick only: every open ready-for-agent Ticket, as
   * a Dispatch check reads them, so the tick closes each one GitHub left open
   * after a PR that closes it merged (src/loop/mergedTickets.ts, #543).
   */
  readonly readyTickets: readonly TicketSnapshot[] | null;
}

/** What the stuck-trigger sweep weighs (src/loop/triggerSweep.ts, #419). */
export interface TriggerSweepSnapshot {
  /** Each role's jobs unfinished anywhere in the repo, or null when the Actions API couldn't be read. */
  readonly underWay: RolesUnderWay | null;
  /** Each trigger label on an open issue or PR, one entry per label. Empty when `underWay` is null: nothing more is read. */
  readonly labelled: readonly LabelledTrigger[];
}

/**
 * Which roles have a job in a workflow run not yet finished, anywhere in the
 * repo, a job its run skipped aside: a trigger label with one of its role's
 * jobs under way has a run behind it.
 */
export interface RolesUnderWay {
  /** An `Implement` job. */
  readonly implement: boolean;
  /** A `Research` job. */
  readonly research: boolean;
  /** A `Review checks` or `Review` job. */
  readonly review: boolean;
  /** A `Claim the work` job. */
  readonly claim: boolean;
  /** The issue of each `Design-session turn #N` or `Prototype turn #N` job, lowest first. */
  readonly designTurns: readonly number[];
}

/** A trigger label on an open issue or PR, as the stuck-trigger sweep reads it. */
export interface LabelledTrigger {
  readonly number: number;
  readonly label: TriggerLabel;
  /** When it was last added, ISO 8601, from the timeline's latest `labeled` event for it; null when the timeline doesn't show one. */
  readonly lastAddedAt: string | null;
  /** Whether the Kit's stuck-trigger re-add comment for it came after it last came off: the Kit has re-added it once already. */
  readonly readded: boolean;
}

/** What the conflict check weighs (src/loop/conflicts.ts, #304). */
export interface ConflictSnapshot {
  /** The default branch's head commit, or null when it has none. */
  readonly main: string | null;
  /** When the adapter read it, as an ISO 8601 time: what an undelivered Request changes' grace period is measured to (#341). */
  readonly now: string;
  /**
   * Whether an Implement job is under way anywhere in the repo, read from the Actions API: one in a workflow run
   * not yet finished, waiting, running, or done with its push job still to land it, and not skipped. Null when the
   * check had no token that can read workflow runs. A stalled Request-changes run on a draft is restarted only when
   * it reads false (#387).
   */
  readonly implementJobUnderWay: boolean | null;
  /** Every open agent PR, with whether GitHub says it merges cleanly into the default branch. */
  readonly pullRequests: readonly ConflictCandidate[];
}

/** Whether one PR merges cleanly into the default branch, as a Reviewer's Verdict weighs it (#480). */
export interface MergeableSnapshot {
  /** The default branch's head commit, or null when it has none. */
  readonly main: string | null;
  /** GitHub's `mergeable` for the PR against that head, as ConflictCandidate's: null when GitHub hadn't worked it out. */
  readonly mergeable: boolean | null;
}

/** An open agent PR the conflict check weighs. */
export interface ConflictCandidate {
  readonly pullRequest: PullRequestSnapshot;
  /**
   * GitHub's `mergeable`: false when it conflicts with the default branch,
   * true when it doesn't (though it may be behind), null when GitHub still
   * hadn't worked it out by the end of the adapter's bounded poll.
   */
  readonly mergeable: boolean | null;
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
  /**
   * When the App last added each label to it, by label name, as far as its
   * timeline reads. A held run's trigger label added after its newest held
   * marker means the tick resumed it, whether or not the run has since taken
   * it off as it started (#438). Missing when not read.
   */
  readonly labeledAt?: Readonly<Record<string, string>>;
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

/**
 * What the replay step weighs on a scheduled tick (src/loop/replayGate.ts,
 * #156). With no replay issue open, it holds none, and nothing else is read.
 */
export interface ReplaySnapshot {
  /** Every open `fabrik:replay` issue, whoever filed it, in any order. */
  readonly issues: readonly ReplayIssueSnapshot[];
  /** What the spare-capacity gate weighs, read only while one of `issues` is the Operator's; else null. */
  readonly capacity: ReplayCapacitySnapshot | null;
  /** What accepting a waiting request weighs, read only while a valid one waits (replayReads); else null. */
  readonly acceptance: ReplayAcceptance | null;
}

/**
 * A replay issue as the adapter read it: its body whole, though the Operator
 * filed it, since its request is the Operator's own text, and the Fabrik
 * App's comments alone (ADR-0007).
 */
export interface ReplayIssueSnapshot extends ReplayIssue {
  readonly labels: readonly string[];
  /**
   * Whether the Kit gave up on agent:replay here, since nothing started twice
   * (#419), and nobody has added it since: the Fabrik App's give-up comment
   * comes after the label's latest `labeled` event.
   */
  readonly gaveUp: boolean;
}

/** What the spare-capacity gate weighs beside the Kit-owned issues (src/loop/replayGate.ts). */
export interface ReplayCapacitySnapshot {
  /** What Dispatch weighs: every open `ready-for-agent` issue, in any order. */
  readonly tickets: readonly TicketSnapshot[];
  /** And every open `wayfinder:research` issue, in any order. */
  readonly researchDecisions: readonly ResearchDecisionSnapshot[];
  /**
   * The newest weekly-limit reading on each Subscription, from the store's
   * Run records of the last two months, every Product repo's and Replay
   * runs' included; a Subscription none read one for isn't here. Null when
   * the store couldn't be read.
   */
  readonly weeklyLimits: Readonly<Record<string, RateLimitReading>> | null;
}

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
  /** When it was opened, which its body's markers date from. Missing when not read. */
  readonly createdAt?: string;
  /** When each of comments was posted, in step with them. Missing when not read. */
  readonly commentedAt?: readonly string[];
}

/** An issue event's snapshot, once the core has checked it holds the issue. */
export interface IssueContext {
  readonly issue: IssueSnapshot;
  readonly operator: Snapshot["operator"];
  readonly kitIssues: Snapshot["kitIssues"];
  readonly weeklyIssues: Snapshot["weeklyIssues"];
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
      /** Comments on an issue, linking comments posted or issues created earlier in the plan. */
      readonly kind: "comment-linking";
      readonly issue: number;
      /** The comment's Markdown, with each posted comment written as its URL and each created issue as its `#number`. */
      readonly body: readonly (string | PostedComment | CreatedIssue)[];
    }
  | { readonly kind: "edit-issue-body"; readonly issue: number; readonly body: string }
  | {
      /**
       * Appends one line to a Map's Decisions so far. The core never sends the
       * Map's body: the adapter reads it as it stands right before it writes,
       * and inserts the line at the end of that section, or under the heading
       * it adds at the end of the body when the section is missing. Every other
       * byte stays, so what the Operator edited after the plan was made survives.
       */
      readonly kind: "append-to-decisions-so-far";
      /** The Map. */
      readonly issue: number;
      /** The line's Markdown, one line, with each posted comment written as its URL: a resolution posted earlier in the plan, say. */
      readonly line: readonly (string | PostedComment)[];
    }
  | { readonly kind: "assign"; readonly issue: number; readonly assignee: string }
  | { readonly kind: "close"; readonly issue: number; readonly reason: "not_planned" | "completed" | "duplicate" }
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
      /**
       * For a conflict-only run (#304): the default branch head it rebases the
       * PR's branch onto. It isn't a retry or a Request-changes run.
       */
      readonly conflict?: { readonly main: string };
      /** For an Implement run that is a Retry: its Retry number. */
      readonly retry?: number;
      /** For a Retry on an agent PR: the head the Execution flaw it fixes was given on (#341). */
      readonly retryFlaw?: string;
      /**
       * For an Implement run: whether it runs on the Step-up model, and why. A
       * first run that doesn't Step up carries neither.
       */
      readonly stepUp?: boolean;
      readonly stepUpReason?: StepUpReason | null;
      /**
       * For an Implement run with no open PR on a Ticket marked for a
       * Kept-branch start (#536): it carries on the Ticket's Kept branch, and
       * the PR it lands opens naming `pullRequest`, the one the Kit closed.
       */
      readonly keptBranch?: KeptBranchStart;
      /** For an Auditor run: the pending Audit's marked commit, which its job checks out and reads up to. */
      readonly commit?: string;
      /**
       * For a Review of a UI PR: where its marker says the UI evidence is kept,
       * which the Review job downloads for the Reviewer. A PR with no marker gets none.
       */
      readonly evidence?: EvidenceMarker;
      /**
       * For a Design session's prototype turn (#155): the pending prototype
       * request it builds, and the Operator's reply that started the turn
       * which asked for it. Its run is role `design`, on the Design role's
       * model and effort, within the Implement role's timeout.
       */
      readonly prototype?: PrototypeRequestMarker;
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
       * Starts a Replay Ticket's two arms (#156), baseline and variant; the
       * workflow does this by routing to `replay` (src/kit/jobs.ts), not the
       * adapter. A replay run is never held, so the core's holding leaves
       * it alone, and never re-run on another Subscription.
       */
      readonly kind: "start-replay";
      /** The replay issue. */
      readonly issue: number;
      /** The Ticket it replays, from the issue's plan, with what each arm runs it with. */
      readonly ticket: PlannedTicket;
      /** The Subscription both arms run on, which `planFor` gives it as it gives every run. */
      readonly subscription?: string;
    }
  | {
      /**
       * Marks a replay issue's Ticket in progress in the run applying it, as
       * its claim takes agent:replay off (#156): the adapter reads the body
       * fresh and marks it with this Actions run's id and the time
       * (withTicketStarted, src/kit/replay.ts), and fails, so the run's
       * replay jobs never start, when the Ticket isn't waiting to run there,
       * as when another run claimed it first.
       */
      readonly kind: "mark-replay-started";
      readonly issue: number;
      readonly ticket: number;
    }
  | {
      /**
       * Ends a replay Ticket's run that never landed (#156), as the tick
       * found it in progress past the longest its run can last: the adapter
       * reads the body fresh and ends run `run` as an Infrastructure failure
       * with `reason` (withTicketFinished, src/kit/replay.ts), which leaves a
       * run that landed since as it landed. When that ends the Replay's last
       * Ticket, it posts `resultsReady`, the one comment that the results are in.
       */
      readonly kind: "release-replay-ticket";
      readonly issue: number;
      readonly ticket: number;
      readonly run: number;
      readonly reason: string;
      readonly resultsReady: string;
    }
  | {
      /**
       * Holds a role's agent run, with rotation on, while every listed
       * Subscription is used up: no agent job starts. It changes nothing on
       * GitHub itself; the Plan's other actions take the trigger label off and
       * leave the held marker on a carrier. The Kit job's step
       * summary reads it.
       */
      readonly kind: "hold-agent-run";
      readonly role: AgentRole;
      /** The issue or PR the run is on: the one its trigger label lives on. */
      readonly issue: number;
      /** The trigger label that resumes it. */
      readonly label: Label;
      /** When the first weekly-limit issue's limit resets, if known; null too on a carrier with no reset (#470). */
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
      /**
       * Rebases an agent PR's branch onto the default branch's head, with no
       * agent (#304): the adapter replays the branch's commits onto `onto`
       * without a working tree (src/github/branch.ts). When that's clean, it
       * applies `clean`, pushes the rebased branch with a lease on the head it
       * rebased, then applies `pushed`; if the push is refused, as when the
       * branch moved meanwhile, it applies `refused` instead of `pushed`.
       * When the rebase conflicts, it applies `conflicted` and pushes nothing.
       * A branch already holding `onto`, or gone, gets none of them.
       */
      readonly kind: "rebase-onto-main";
      readonly pullRequest: number;
      readonly branch: string;
      readonly onto: string;
      readonly clean: readonly Action[];
      readonly pushed: readonly Action[];
      readonly refused: readonly Action[];
      readonly conflicted: readonly Action[];
    }
  /**
   * Push the issue's prototype branch, `prototype/<issue>`, which the push job
   * holds from a prototype turn's bundle (#155): no other branch, and only as
   * a fast-forward from the head the turn started on (src/github/branch.ts).
   * It never opens a PR, and nothing in the Kit deletes the branch.
   */
  | { readonly kind: "push-prototype-branch"; readonly issue: number }
  | {
      /**
       * Marks a Design session's prototype request (#155), on the Fabrik App's
       * own request comment, as building, once its prototype turn starts, or
       * waiting for it again, once that turn is refused on its Subscription
       * and held or re-run: what agent:design next starts is read from it
       * (src/loop/design.ts). An edit, so it notifies nobody.
       */
      readonly kind: "mark-prototype-request";
      readonly issue: number;
      /** The request's comment. */
      readonly comment: number;
      readonly started: boolean;
    }
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
    }
  | {
      /**
       * Links each variant's preview in a prototype round (#155), as
       * `link-preview` links a UI PR's. Not a GitHub change itself: once this
       * plan has pushed the issue's prototype branch and posted the round, the
       * push job hands it on to its prototype preview step, which fills
       * `template` in for the branch as the push left it, polls the route's
       * page there, and edits the round to link it beside each variant, with
       * `?variant=` and its letter, or to say it never answered. Never a
       * hosting provider's API.
       */
      readonly kind: "link-prototype-preview";
      readonly issue: number;
      /** The prototype round this plan posts. */
      readonly round: PostedComment;
      /** Kit config's `preview.url`, which uses no `{pr}`: a prototype has no PR. */
      readonly template: string;
      /** The route every variant renders on. */
      readonly route: string;
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
