// The Loop rules core's interface: a Loop event, a snapshot of GitHub state and
// the resolved Kit config go in; a plan comes out.

/** An AFK role whose agent job passes structured output to its push job. */
export type AgentRole = "triage" | "design" | "implement" | "review";

export const AGENT_ROLES: readonly AgentRole[] = ["triage", "design", "implement", "review"];

/** How an agent job says it failed, in the report it leaves for its failure job (src/agent/failure.ts). */
export type ReportedFailure =
  | "crash"
  | "missing-output"
  | "provider-error"
  | "dead-token"
  | "weekly-limit"
  | "metered-billing";

/** Every kind of Infrastructure failure: what the agent job reported, or what its failure job saw. */
export type InfrastructureFailure = ReportedFailure | "timeout" | "unreachable-1password";

/** What a failed agent job left for its failure job, when it got far enough to leave anything. */
export interface FailureReport {
  readonly failure: ReportedFailure;
  /** One line on what went wrong, for the failure comment. */
  readonly detail: string;
  /** For the weekly limit, when it resets (an ISO 8601 time), if the stream said. */
  readonly resetsAt?: string;
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
      readonly role: AgentRole;
      readonly issue: number;
      /** The text the agent emitted as its structured output, unparsed. */
      readonly output: string;
    }
  | {
      /** An agent job failed or was cancelled; its failure job carries the news. */
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
  /** How many Design-session rounds the Kit has posted on the issue so far. */
  readonly designRounds: number;
}

/** A pull request as the core sees it. */
export interface PullRequestSnapshot {
  readonly number: number;
  /** Whether the Fabrik App opened it for a Ticket (src/loop/agentPullRequest.ts). */
  readonly isAgent: boolean;
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
  /** The Operator's GitHub login: ready-for-human work is assigned to them, and Design rounds and failures @-mention them. */
  readonly operator: string;
  /** The open issues the Kit owns in this repo (token rotation, weekly limit), oldest first. Gathered for every event. */
  readonly kitIssues: readonly KitIssueSnapshot[];
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

/** One change the GitHub adapter makes on the core's behalf. */
export type Action =
  | {
      /** Creates an issue, then links it under its parent and to its blockers, which earlier actions created. */
      readonly kind: "create-issue";
      /** Names the new issue for later actions in the plan. */
      readonly key: string;
      readonly title: string;
      readonly body: string;
      readonly labels: readonly string[];
      readonly parent: CreatedIssue | null;
      readonly blockedBy: readonly CreatedIssue[];
    }
  | {
      /** Comments on an issue, then closes it as completed: another issue now carries its work. */
      readonly kind: "close-as-superseded";
      readonly issue: number;
      /** The comment's Markdown, with each created issue written as its `#number`. */
      readonly comment: readonly (string | CreatedIssue)[];
    }
  | { readonly kind: "add-labels"; readonly issue: number; readonly labels: readonly string[] }
  | { readonly kind: "remove-label"; readonly issue: number; readonly label: string }
  | { readonly kind: "comment"; readonly issue: number; readonly body: string }
  | { readonly kind: "edit-issue-body"; readonly issue: number; readonly body: string }
  | { readonly kind: "assign"; readonly issue: number; readonly assignee: string }
  | { readonly kind: "close"; readonly issue: number; readonly reason: "not_planned" | "completed" }
  | {
      readonly kind: "open-issue";
      readonly title: string;
      readonly body: string;
      readonly labels: readonly string[];
      readonly assignees: readonly string[];
    }
  | {
      /** Starts a role's agent job; the workflow does this by routing to it, not the adapter. */
      readonly kind: "start-agent-run";
      readonly role: AgentRole;
      readonly issue: number;
      readonly model: string;
      readonly effort: string | null;
      readonly timeoutMinutes: number;
    }
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
