// The Loop rules core's interface: a Loop event, a snapshot of GitHub state and
// the resolved Kit config go in; a plan comes out.
import type { ChangedPath } from "../guard/trust-root.ts";
import type { SentBack } from "./backToDesign.ts";
import type { Label } from "./labels.ts";

/** An AFK role whose agent job passes structured output to its push job. */
export type AgentRole = "triage" | "design" | "implement" | "review";

export const AGENT_ROLES: readonly AgentRole[] = ["triage", "design", "implement", "review"];

/** How an agent job says it failed, in the report it leaves for the push job (src/agent/failure.ts). */
export type ReportedFailure =
  | "crash"
  | "missing-output"
  | "provider-error"
  | "dead-token"
  | "weekly-limit"
  | "metered-billing";

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
      /** Implement and Review runs finish through their own events, which carry what their push jobs hold. */
      readonly role: Exclude<AgentRole, "implement" | "review">;
      readonly issue: number;
      /** The text the agent emitted as its structured output, unparsed. */
      readonly output: string;
      /**
       * For a Design-session turn the Operator's reply started: that comment's
       * id, from the Actions event the push job runs for, never from the agent.
       * None for the first round, which adding needs-design starts.
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
  /** A push to the default branch that changed the Kit config, which may have unpaused or widened Dispatch. */
  | { readonly kind: "kit-config-changed" }
  | {
      /** The scheduled Kit workflow's tick (schedule.yml), for the Loop's time-based rules. */
      readonly kind: "scheduled-tick";
      /** When the tick ran, as an ISO 8601 time. */
      readonly now: string;
    };

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
  readonly labels: readonly string[];
  /** The parent issue's number, or null if it isn't a sub-issue. */
  readonly parent: number | null;
  /** The open pull requests linked to close this issue, oldest first. */
  readonly openPullRequests: readonly number[];
  /** How many rounds the Kit has posted in the issue's current Design session (src/loop/design.ts). */
  readonly designRounds: number;
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

/** What a Dispatch check needs: the Tickets it may release and the work already in flight. */
export interface DispatchSnapshot {
  /** Every open `ready-for-agent` issue, in any order. */
  readonly tickets: readonly TicketSnapshot[];
  readonly openAgentDraftPullRequests: number;
  readonly implementRunsInProgress: number;
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
  readonly body: string;
  /** Its comments' text, oldest first. */
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
      readonly model: string;
      readonly effort: string | null;
      readonly timeoutMinutes: number;
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
  | { readonly kind: "check-design-queue" };

/**
 * What the core decided: actions to apply, nothing (with the reason why), or
 * that the run failed, which changes nothing and fails the job.
 */
export type Plan =
  | { readonly kind: "act"; readonly actions: readonly Action[] }
  | { readonly kind: "nothing"; readonly reason: string }
  | { readonly kind: "fail"; readonly failure: "infrastructure"; readonly reason: string };
