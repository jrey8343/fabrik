// Execution-flaw retries: an Execution flaw on an agent PR re-runs the
// Implementer on the same branch with the findings as input, then Review runs
// again. Retries are counted from the PR's earlier Verdict comments alone, and
// stay silent: no mention, assignment or review request. While one is in
// flight, no other head gets a Verdict, so each flaw starts exactly one
// Implementer attempt (ADR-0006).
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

/** The Implement run an agent PR's latest Verdict, or the Operator's review, called for, that hasn't pushed yet. */
export type RunInFlight =
  | { readonly kind: "retry"; readonly retry: number }
  | { readonly kind: "request-changes"; readonly review: number };

/**
 * The run in flight on this PR, read from its comments alone, or null. A
 * Retry is in flight from the Execution flaw that calls for it until a Retry
 * outcome: its push, or its empty-diff Verdict (which may call for the next
 * one). A Request-changes run is in flight from the Operator's review
 * requesting changes on the head that passed until its push. An
 * Infrastructure failure posts no outcome, so the run stays in flight until
 * agent:implement resumes it; a trust-root refusal closes the PR.
 */
export function runInFlight(pullRequest: PullRequestSnapshot, operator: string): RunInFlight | null {
  const latest = pullRequest.verdicts.at(-1);
  if (latest === undefined || pullRequest.pushedSinceVerdict) return null;
  if (latest.verdict === "execution-flaw") {
    const retry = retryNumber(pullRequest.verdicts.slice(0, -1));
    return retry > MAX_RETRIES ? null : { kind: "retry", retry };
  }
  const review = pullRequest.changesRequested;
  if (latest.verdict !== "pass" || review === null || review.reviewerIsBot || review.reviewer !== operator) return null;
  return review.commitSha === latest.headSha ? { kind: "request-changes", review: review.review } : null;
}

/** How the Kit's comments name a run in flight, at the start of a sentence. */
export function runName(run: RunInFlight): string {
  return run.kind === "retry" ? `Retry ${run.retry} of ${MAX_RETRIES}` : "The Operator's Request-changes run";
}

/** Why a Review on this PR posts no Verdict, while a run is in flight on it; otherwise null. */
export function whyAwaitingRun(pullRequest: PullRequestSnapshot, operator: string): string | null {
  const run = runInFlight(pullRequest, operator);
  if (run === null) return null;
  return `${runName(run)} on #${pullRequest.number} is still in flight, so ${pullRequest.headSha.slice(0, 7)} gets no Verdict: the run's push starts the next Review`;
}

/**
 * The retry an agent draft PR is owed: the one in flight, on whatever head the
 * PR is at now, the Operator's pushes included; otherwise null. The first
 * retry runs on the Implementer's model and the second Steps up, for this PR
 * only. An Infrastructure failure posts no Verdict, so resuming after one runs
 * the same retry again and uses none up.
 */
export function owedRetry(
  pullRequest: PullRequestSnapshot,
  operator: string,
  config: KitConfig,
): Extract<Action, { kind: "start-agent-run" }> | null {
  if (whyNotReviewable(pullRequest) !== null || pullRequest.ticket === null) return null;
  const run = runInFlight(pullRequest, operator);
  if (run?.kind !== "retry") return null;
  const { implement, stepUp } = config.roles;
  // Never a cheaper model, and never a skipped Step-up, whatever the weekly pool says.
  const { model, effort } = run.retry === MAX_RETRIES ? stepUp : implement;
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
