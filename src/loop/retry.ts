// Execution-flaw retries: an Execution flaw on an agent PR re-runs the
// Implementer on the same branch with the findings as input, then Review runs
// again. Retries are counted from the PR's earlier Verdict comments alone, and
// stay silent: no mention, assignment or review request.
import { whyNotReviewable } from "./agentPullRequest.ts";
import { DISPATCH_LABEL } from "./labels.ts";
import type { Action, KitConfig, PullRequestSnapshot, VerdictRecord } from "./types.ts";

/** Execution-flaw retries a Ticket gets before the next flaw counts as a Design flaw. */
export const MAX_RETRIES = 2;

/**
 * Which retry an Execution flaw calls for, given the Verdicts posted before it:
 * one more than the earlier Execution flaws. Verdicts from a Request-changes
 * run don't count, and an Infrastructure failure posts no Verdict at all.
 */
export function retryNumber(earlier: readonly VerdictRecord[]): number {
  return 1 + earlier.filter((record) => record.verdict === "execution-flaw" && !record.requestChanges).length;
}

/**
 * What an Execution flaw on this PR does next: its retry and a line saying so,
 * or null when its retries are used up, so the flaw counts as a Design flaw.
 */
export function retryAfterFlaw(pullRequest: PullRequestSnapshot): { readonly line: string; readonly actions: Action[] } | null {
  const retry = retryNumber(pullRequest.verdicts);
  if (retry > MAX_RETRIES || pullRequest.ticket === null) return null;
  return {
    line: `Retry ${retry} of ${MAX_RETRIES} starts now${retry === MAX_RETRIES ? ", stepped up" : ""}: the Implementer fixes these findings on the same branch.`,
    // A fresh agent:implement on the Ticket resumes the PR's Implement run (src/loop/implement.ts). It notifies nobody.
    actions: [{ kind: "add-labels", issue: pullRequest.ticket, labels: [DISPATCH_LABEL] }],
  };
}

/**
 * The retry an agent draft PR is owed, when its latest Verdict, on its head,
 * is an Execution flaw with a retry left; otherwise null. The first retry runs
 * on the Implementer's model and the second Steps up, for this PR only. An
 * Infrastructure failure posts no Verdict, so resuming after one runs the same
 * retry again and uses none up.
 */
export function owedRetry(
  pullRequest: PullRequestSnapshot,
  config: KitConfig,
): Extract<Action, { kind: "start-agent-run" }> | null {
  if (whyNotRetryable(pullRequest) !== null || pullRequest.ticket === null) return null;
  const { implement, stepUp } = config.roles;
  // Never a cheaper model, and never a skipped Step-up, whatever the weekly pool says.
  const { model, effort } = retryNumber(pullRequest.verdicts.slice(0, -1)) === MAX_RETRIES ? stepUp : implement;
  return {
    kind: "start-agent-run",
    role: "implement",
    issue: pullRequest.ticket,
    pullRequest: pullRequest.number,
    model,
    effort,
    timeoutMinutes: implement.timeoutMinutes,
  };
}

/** Why this PR has no retry to run now, or null when it has. */
function whyNotRetryable(pullRequest: PullRequestSnapshot): string | null {
  const why = whyNotReviewable(pullRequest);
  if (why !== null) return why;
  const latest = pullRequest.verdicts.at(-1);
  if (latest === undefined) return `#${pullRequest.number} has no Verdict to fix`;
  if (latest.verdict !== "execution-flaw") return `#${pullRequest.number}'s latest Verdict isn't an Execution flaw`;
  if (latest.headSha !== pullRequest.headSha) return `#${pullRequest.number} has moved on from its Execution flaw`;
  if (retryNumber(pullRequest.verdicts.slice(0, -1)) > MAX_RETRIES) {
    return `#${pullRequest.number} has used its ${MAX_RETRIES} retries`;
  }
  return null;
}
