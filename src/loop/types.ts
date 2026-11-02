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
}

/** Something that happened in a Product repo that the Loop may act on. */
export type LoopEvent =
  | { readonly kind: "issue-opened"; readonly issue: number }
  | {
      readonly kind: "issue-comment-created";
      readonly issue: number;
      /** The login of whoever wrote the comment. */
      readonly commenter: string;
      /** Whether that account is a bot, the Fabrik App included. */
      readonly commenterIsBot: boolean;
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
    };

/** An issue as the core sees it, gathered fresh by the GitHub adapter. */
export interface IssueSnapshot {
  readonly number: number;
  readonly author: string;
  readonly labels: readonly string[];
  /** The parent issue's number, or null if it isn't a sub-issue. */
  readonly parent: number | null;
  /** The open pull requests linked to close this issue, oldest first. */
  readonly openPullRequests: readonly number[];
}

/** The slice of GitHub state a Loop event needs to be decided. */
export interface Snapshot {
  readonly issue: IssueSnapshot;
  /** The Operator's GitHub login, whom ready-for-human work is assigned to and failures @-mention. */
  readonly operator: string;
}

/** The resolved Kit config, every default filled in (src/kit/config.ts). */
export type { KitConfig } from "../kit/config.ts";

/** One change the GitHub adapter makes on the core's behalf. */
export type Action =
  | { readonly kind: "add-labels"; readonly issue: number; readonly labels: readonly string[] }
  | { readonly kind: "remove-label"; readonly issue: number; readonly label: string }
  | { readonly kind: "comment"; readonly issue: number; readonly body: string }
  | { readonly kind: "assign"; readonly issue: number; readonly assignee: string }
  | { readonly kind: "close"; readonly issue: number; readonly reason: "not_planned" };

/**
 * What the core decided: actions to apply, nothing (with the reason why), or
 * that the run failed, which changes nothing and fails the job.
 */
export type Plan =
  | { readonly kind: "act"; readonly actions: readonly Action[] }
  | { readonly kind: "nothing"; readonly reason: string }
  | { readonly kind: "fail"; readonly failure: "infrastructure"; readonly reason: string };
