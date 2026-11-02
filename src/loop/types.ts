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
    }
  | {
      readonly kind: "agent-run-finished";
      /** Implement and Review runs finish through their own events, which carry what their push jobs hold. */
      readonly role: Exclude<AgentRole, "implement" | "review">;
      readonly issue: number;
      /** The text the agent emitted as its structured output, unparsed. */
      readonly output: string;
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
  | { readonly kind: "pull-request-left-draft"; readonly pullRequest: number }
  | { readonly kind: "pull-request-closed"; readonly pullRequest: number }
  /** A Dispatch check, which an earlier plan asked for with `check-dispatch`. */
  | { readonly kind: "dispatch-check" }
  | {
      /** The scheduled Kit workflow's tick (schedule.yml), for the Loop's time-based rules. */
      readonly kind: "scheduled-tick";
      /** When the tick ran, as an ISO 8601 time. */
      readonly now: string;
    };

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
  /** For an issue closing: the Spec it is a Ticket of, or null when it has no parent. */
  readonly spec: SpecSnapshot | null;
  /** The Operator's GitHub login: ready-for-human work is assigned to them, and Design rounds and failures @-mention them. */
  readonly operator: string;
  /** The open issues the Kit owns in this repo (token rotation, weekly limit), oldest first. Gathered for every event. */
  readonly kitIssues: readonly KitIssueSnapshot[];
}

/** A Spec and its Tickets, which Spec closing weighs. */
export interface SpecSnapshot {
  readonly number: number;
  readonly open: boolean;
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
      /** Creates an issue, then links it under its parent and to its blockers, which earlier actions created. */
      readonly kind: "create-issue";
      /** Names the new issue for later actions in the plan. */
      readonly key: string;
      readonly title: string;
      readonly body: string;
      readonly labels: readonly Label[];
      /** The issue it becomes a sub-issue of: one created earlier in the plan, or an existing issue by its number. */
      readonly parent: CreatedIssue | number | null;
      readonly blockedBy: readonly CreatedIssue[];
    }
  | {
      /** Comments on an issue, then closes it as completed: another issue now carries its work. */
      readonly kind: "close-as-superseded";
      readonly issue: number;
      /** The comment's Markdown, with each created issue written as its `#number`. */
      readonly comment: readonly (string | CreatedIssue)[];
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
  /** Requests a review on a PR: the Merge gate's one notification. */
  | { readonly kind: "request-review"; readonly pullRequest: number; readonly reviewer: string }
  /** Run a Dispatch check, in the Dispatch job, once the rest of this plan has landed. */
  | { readonly kind: "check-dispatch" };

/**
 * What the core decided: actions to apply, nothing (with the reason why), or
 * that the run failed, which changes nothing and fails the job.
 */
export type Plan =
  | { readonly kind: "act"; readonly actions: readonly Action[] }
  | { readonly kind: "nothing"; readonly reason: string }
  | { readonly kind: "fail"; readonly failure: "infrastructure"; readonly reason: string };
