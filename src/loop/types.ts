// The Loop rules core's interface: a Loop event, a snapshot of GitHub state and
// the resolved Kit config go in; a plan comes out.

/** An AFK role whose agent job passes structured output to its push job. */
export type AgentRole = "triage" | "design";

/** Something that happened in a Product repo that the Loop may act on. */
export type LoopEvent =
  | { readonly kind: "issue-opened"; readonly issue: number }
  | { readonly kind: "label-added"; readonly issue: number; readonly label: string }
  | {
      readonly kind: "issue-comment-created";
      readonly issue: number;
      /** The comment author's login. */
      readonly author: string;
      /** Whether GitHub says the author is a bot (any App, the Fabrik App included). */
      readonly authorIsBot: boolean;
    }
  | {
      readonly kind: "agent-run-finished";
      readonly role: AgentRole;
      readonly issue: number;
      /** The text the agent emitted as its structured output, unparsed. */
      readonly output: string;
    };

/** An issue as the core sees it, gathered fresh by the GitHub adapter. */
export interface IssueSnapshot {
  readonly number: number;
  readonly open: boolean;
  readonly author: string;
  readonly labels: readonly string[];
  /** The parent issue's number, or null if it isn't a sub-issue. */
  readonly parent: number | null;
  /** How many Design-session rounds the Kit has posted on the issue so far. */
  readonly designRounds: number;
}

/** The slice of GitHub state a Loop event needs to be decided. */
export interface Snapshot {
  readonly issue: IssueSnapshot;
  /** The Operator's GitHub login. */
  readonly operator: string;
}

/** The resolved Kit config, every default filled in (src/kit/config.ts). */
export type { KitConfig } from "../kit/config.ts";

/** One change the GitHub adapter makes on the core's behalf. */
export type Action =
  | { readonly kind: "add-labels"; readonly issue: number; readonly labels: readonly string[] }
  | { readonly kind: "remove-label"; readonly issue: number; readonly label: string }
  | { readonly kind: "comment"; readonly issue: number; readonly body: string }
  | { readonly kind: "edit-issue-body"; readonly issue: number; readonly body: string }
  | {
      /** Starts a role's agent job; the workflow does this by routing to it, not the adapter. */
      readonly kind: "start-agent-run";
      readonly role: AgentRole;
      readonly issue: number;
      readonly model: string;
      readonly effort: string | null;
      readonly timeoutMinutes: number;
    };

/**
 * What the core decided: actions to apply, nothing (with the reason why), or
 * that the run failed, which changes nothing and fails the job.
 */
export type Plan =
  | { readonly kind: "act"; readonly actions: readonly Action[] }
  | { readonly kind: "nothing"; readonly reason: string }
  | { readonly kind: "fail"; readonly failure: "infrastructure"; readonly reason: string };
