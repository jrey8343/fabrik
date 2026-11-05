// The adapter's event side: turns an Actions event, or what an agent job
// passed out to its push job, into the Loop event it stands for.
// It holds no Loop rules; those all live in src/loop/rules.ts.
import type { AgentRunResult } from "../agent/result.ts";
import { KIT_CONFIG_PATH } from "../kit/config.ts";
import type {
  AgentRole,
  BranchChanges,
  FailureReport,
  GivenOperatorComment,
  LoopEvent,
  PullRequestCommentPlace,
} from "../loop/types.ts";

/** Maps an Actions event to the Loop event it stands for, or null if the Loop ignores it. */
export function loopEventFrom(
  eventName: string,
  payload: Record<string, unknown>,
  now: Date = new Date(),
): LoopEvent | null {
  // The scheduled Kit workflow (schedule.yml), for the Loop's time-based rules.
  if (eventName === "schedule") return { kind: "scheduled-tick", now: now.toISOString() };
  // The caller workflow's push trigger, filtered to the Kit config's path.
  if (eventName === "push") return changesKitConfig(payload) ? { kind: "kit-config-changed" } : null;
  if (eventName === "issues" && payload["action"] === "opened") {
    const issue = payload["issue"] as { number: number };
    return { kind: "issue-opened", issue: issue.number };
  }
  if (eventName === "issues" && payload["action"] === "labeled") {
    const issue = payload["issue"] as { number: number };
    const label = payload["label"] as { name: string };
    return { kind: "label-added", issue: issue.number, label: label.name };
  }
  if (eventName === "issue_comment" && payload["action"] === "created") {
    const issue = payload["issue"] as { number: number; pull_request?: unknown };
    const comment = payload["comment"] as { id: number; user: { login: string; type: string }; body?: string | null };
    // A comment on a PR is not a reply on an issue.
    if (issue.pull_request !== undefined) {
      return pullRequestCommented(issue.number, comment.user, { kind: "conversation", comment: comment.id });
    }
    return {
      kind: "issue-comment-created",
      issue: issue.number,
      commenter: comment.user.login,
      commenterIsBot: comment.user.type === "Bot",
      body: comment.body ?? "",
      comment: comment.id,
    };
  }
  if (eventName === "issues" && payload["action"] === "closed") {
    return { kind: "issue-closed", issue: (payload["issue"] as { number: number }).number };
  }
  // pull_request_target, so the run uses the base branch's caller workflow and
  // Kit config, never the PR's. The Loop never checks out PR code.
  if (eventName === "pull_request_target") {
    const pullRequest = (payload["pull_request"] as { number: number }).number;
    // Opened or pushed to: its required checks start, and a Review waits for them.
    if (payload["action"] === "opened" || payload["action"] === "synchronize" || payload["action"] === "reopened") {
      return { kind: "pull-request-pushed", pullRequest };
    }
    if (payload["action"] === "labeled") {
      const label = payload["label"] as { name: string };
      return { kind: "pull-request-labeled", pullRequest, label: label.name };
    }
    if (payload["action"] === "ready_for_review") return { kind: "pull-request-left-draft", pullRequest };
    if (payload["action"] === "closed") return { kind: "pull-request-closed", pullRequest };
  }
  // There is no _target form of this event, so the run uses the PR's merge
  // commit's caller workflow and Kit config. An agent PR can't change either:
  // both are trust roots its push job refuses (ADR-0005).
  if (eventName === "pull_request_review" && payload["action"] === "submitted") {
    const review = payload["review"] as { id: number; state: string; user: { login: string; type: string } };
    const pullRequest = (payload["pull_request"] as { number: number }).number;
    const state = review.state.toLowerCase();
    // A Comment or Approve review, which a lone inline comment or a thread reply also submits.
    if (state === "commented" || state === "approved") {
      return pullRequestCommented(pullRequest, review.user, { kind: "review", review: review.id });
    }
    if (state !== "changes_requested") return null;
    return {
      kind: "pull-request-changes-requested",
      pullRequest,
      review: review.id,
      reviewer: review.user.login,
      reviewerIsBot: review.user.type === "Bot",
    };
  }
  return null;
}

/**
 * A comment on a PR, or null when a bot wrote it: the Fabrik App's own
 * Verdicts and fix comments would otherwise each start a Kit job that plans
 * nothing (only the Operator's comments are acknowledged, ADR-0007).
 */
function pullRequestCommented(
  pullRequest: number,
  user: { readonly login: string; readonly type: string },
  on: PullRequestCommentPlace,
): LoopEvent | null {
  if (user.type === "Bot") return null;
  return { kind: "pull-request-commented", pullRequest, commenter: user.login, commenterIsBot: false, on };
}

/**
 * Whether a push to the default branch, whose Kit config the Loop reads,
 * added, changed or removed .fabrik/config.json (removing it restores the defaults).
 */
function changesKitConfig(payload: Record<string, unknown>): boolean {
  const defaultBranch = (payload["repository"] as { default_branch: string }).default_branch;
  if (payload["ref"] !== `refs/heads/${defaultBranch}`) return false;
  const commits = payload["commits"] as { added: string[]; modified: string[]; removed: string[] }[];
  return commits.some((commit) => [...commit.added, ...commit.modified, ...commit.removed].includes(KIT_CONFIG_PATH));
}

/**
 * Turns the result an agent job passed out as an artifact (src/agent/result.ts)
 * into the Loop event its push job applies. `startedBy` is the Operator's
 * reply that started a Design-session turn, which the push job reads from its
 * own Actions event, never from the agent's result.
 */
export function agentRunEventFrom(
  result: AgentRunResult,
  changes: BranchChanges | null = null,
  retry: { readonly pullRequest: number; readonly runUrl: string; readonly requestChanges?: boolean } | null = null,
  startedBy: number | null = null,
): LoopEvent {
  if (result.role === "review") throw new Error("A Reviewer's result is applied through reviewEventFrom");
  if (result.role === "audit") throw new Error("An Auditor's result is applied through its own event, not agentRunEventFrom");
  if (result.role !== "implement") {
    const finished = {
      kind: "agent-run-finished",
      role: result.role,
      issue: result.issue,
      output: result.output,
      ...givenTo(result),
    } as const;
    return result.role === "design" && startedBy !== null ? { ...finished, startedBy } : finished;
  }
  if (result.branch === undefined || changes === null) {
    throw new Error("An Implement run's result needs the branch it built and the paths that branch changes");
  }
  return {
    kind: "implement-run-finished",
    issue: result.issue,
    output: result.output,
    branch: result.branch.name,
    base: result.branch.base.ref,
    changes,
    // A retry's branch starts at the PR head it built on, which the core checks is still the PR's.
    ...(retry === null
      ? {}
      : {
          fixes: {
            ...retry,
            headSha: result.branch.base.sha,
            ...givenTo(result),
          },
        }),
  };
}

/** What a Review's push job knows: from its checks job, and the Reviewer's result when it ran. */
export interface FinishedReview {
  readonly pullRequest: number;
  readonly headSha: string;
  readonly runUrl: string;
  /** The Product repo's web address, which a pass's Follow-ups open issues on. */
  readonly repoUrl: string;
  /** The required checks that didn't pass, from the checks job. */
  readonly failedChecks: readonly string[];
  /** The Reviewer's result, null when red checks kept it from running. */
  readonly result: AgentRunResult | null;
}

/** Turns a finished Review into the Loop event its push job applies. */
export function reviewEventFrom(review: FinishedReview): LoopEvent {
  const { pullRequest, headSha, runUrl, result } = review;
  if (result === null) {
    return { kind: "required-checks-finished", pullRequest, headSha, failed: review.failedChecks, runUrl };
  }
  if (result.role !== "review") throw new Error(`A Review's push job was handed a ${result.role} result`);
  if (result.issue !== pullRequest) throw new Error(`The Reviewer's result is for #${result.issue}, not #${pullRequest}`);
  return {
    kind: "review-run-finished",
    pullRequest,
    headSha,
    output: result.output,
    runUrl,
    repoUrl: review.repoUrl,
    ...givenTo(result),
  };
}

/** The Operator comments a run was given, for its event to carry; nothing when its result has none. */
function givenTo(result: AgentRunResult): { operatorComments?: readonly GivenOperatorComment[] } {
  return result.operatorComments === undefined ? {} : { operatorComments: result.operatorComments };
}

/** What the push job knows about the agent job it follows (src/kit/pushJob.ts). */
export interface FailedJob {
  readonly role: AgentRole;
  readonly issue: number;
  readonly runUrl: string;
  /** `needs.<job>.result`. */
  readonly jobResult: string;
  /** The agent job's 1Password step outcome, passed out as a job output; empty if it never got that far. */
  readonly secretsStep: string;
  readonly report: FailureReport | null;
}

const SECRETS_OUTCOMES = ["success", "failure", "cancelled", "skipped"] as const;

/** Turns what the push job gathered into the Loop event it reports. */
export function agentFailureEventFrom(job: FailedJob): LoopEvent {
  const secretsStep = SECRETS_OUTCOMES.find((outcome) => outcome === job.secretsStep) ?? null;
  return {
    kind: "agent-run-failed",
    role: job.role,
    issue: job.issue,
    runUrl: job.runUrl,
    jobResult: job.jobResult === "cancelled" ? "cancelled" : "failure",
    secretsStep,
    report: job.report,
  };
}
