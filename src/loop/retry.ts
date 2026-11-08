// Execution-flaw retries: an Execution flaw on an agent PR re-runs the
// Implementer on the same branch with the findings as input, then Review runs
// again. Retries are counted from the PR's earlier Verdict comments alone, and
// stay silent: no mention, assignment or review request. While one is in
// flight, no other head gets a Verdict, so each flaw starts exactly one
// Implementer attempt (ADR-0006).
import { whyNotReviewable } from "./agentPullRequest.ts";
import { DISPATCH_LABEL, STEP_UP_LABEL } from "./labels.ts";
import type { Action, KitConfig, PullRequestSnapshot, StepUpReason, VerdictRecord } from "./types.ts";

/** Execution-flaw retries a Ticket gets before the next flaw counts as a Design flaw. */
export const MAX_RETRIES = 2;

/** Whether this retry Steps up: the last one does, while the first run and earlier retries use the Implementer's model. */
function stepsUp(retry: number): boolean {
  return retry >= MAX_RETRIES;
}

/**
 * Why a first run or a Retry on a Ticket with these labels Steps up, or null
 * when it runs on the Implementer's model. The label is read as the run
 * starts, so adding it mid-chain steps up the next run and removing it drops
 * back (ADR-0014). On a marked Ticket the second Retry says `marked`.
 */
export function stepUpReasonFor(retry: number, ticketLabels: readonly string[]): Extract<StepUpReason, "retry" | "marked"> | null {
  if (ticketLabels.includes(STEP_UP_LABEL)) return "marked";
  return stepsUp(retry) ? "retry" : null;
}

/** The model and effort an Implement run with this Step-up reason runs on. */
export function implementSettings(reason: StepUpReason | null, config: KitConfig): KitConfig["roles"]["stepUp"] {
  const { implement, stepUp } = config.roles;
  return reason === null ? { model: implement.model, effort: implement.effort } : stepUp;
}

/**
 * Which retry an Execution flaw calls for, given the Verdicts posted before it:
 * one more than the earlier Execution flaws. Verdicts from a Request-changes
 * run or a conflict-only run (#304) don't count, nor does one that gave way to
 * an undelivered Request changes (#341), and an Infrastructure failure posts
 * no Verdict at all.
 */
export function retryNumber(earlier: readonly VerdictRecord[]): number {
  return (
    1 +
    earlier.filter(
      (record) => record.verdict === "execution-flaw" && !record.requestChanges && record.conflictRun !== true && record.requestChangesFirst === undefined,
    ).length
  );
}

/**
 * What an Execution flaw on this PR does next: its retry and a line saying so,
 * or null when its retries are used up, so the flaw counts as a Design flaw.
 */
export function retryAfterFlaw(pullRequest: PullRequestSnapshot): { readonly line: string; readonly actions: Action[] } | null {
  const retry = retryNumber(pullRequest.verdicts);
  if (retry > MAX_RETRIES || pullRequest.ticket === null) return null;
  return {
    line: `Retry ${retry} of ${MAX_RETRIES} starts now${stepUpReasonFor(retry, pullRequest.ticketLabels) === null ? "" : ", stepped up"}: the Implementer fixes these findings on the same branch.`,
    // A fresh agent:implement on the Ticket resumes the PR's Implement run (src/loop/implement.ts). It notifies nobody.
    actions: [{ kind: "add-labels", issue: pullRequest.ticket, labels: [DISPATCH_LABEL] }],
  };
}

/** The Implement run an agent PR's latest Verdict, or the Operator's review, called for, that hasn't pushed yet. */
export type RunInFlight =
  /** A Retry, numbered, for the Execution flaw on this head: a Verdict is given once per head, so it names the flaw. */
  | { readonly kind: "retry"; readonly retry: number; readonly flaw: string }
  | { readonly kind: "request-changes"; readonly review: number }
  /** A conflict-only run (#304), started for this default branch head. */
  | { readonly kind: "conflict"; readonly main: string };

/**
 * The run in flight on this PR, read from its comments alone, or null. A
 * Retry is in flight from the Execution flaw that calls for it until a Retry
 * outcome: its push, or its empty-diff Verdict (which may call for the next
 * one). A Request-changes run is in flight from the Kit's note that started
 * it, or the Execution flaw that gave way to it, until its push, its Verdict
 * or its ended note, or until the PR leaves draft (#341). An Infrastructure
 * failure posts no outcome, so the run stays in flight until agent:implement
 * resumes it; a trust-root refusal closes the PR, or, for a Request-changes
 * run told to merge main in, ends it. A conflict-only run (#304) is in flight
 * from the Kit's note that started it until its push, or its note that it
 * ended without one.
 */
export function runInFlight(pullRequest: PullRequestSnapshot): RunInFlight | null {
  const review = pullRequest.requestChangesRunInFlight;
  if (review !== null) return { kind: "request-changes", review };
  if (pullRequest.conflictRunInFlight !== null) return { kind: "conflict", main: pullRequest.conflictRunInFlight };
  const latest = pullRequest.verdicts.at(-1);
  if (latest === undefined || pullRequest.pushedSinceVerdict || latest.verdict !== "execution-flaw") return null;
  // A Retry works on a draft: once the PR has left draft since the flaw, as when the Operator took it back or the Kit
  // handed it to them, none is in flight, even after something turns the PR to draft again.
  if (!pullRequest.draft || pullRequest.leftDraftSinceVerdict) return null;
  // One that gave way to the Operator's Request changes (#341) called for no Retry, and never owes one: its
  // Request-changes run fixes its findings, and if the Operator dismisses those reviews, the PR is theirs.
  if (latest.requestChangesFirst !== undefined) return null;
  const retry = retryNumber(pullRequest.verdicts.slice(0, -1));
  return retry > MAX_RETRIES ? null : { kind: "retry", retry, flaw: latest.headSha };
}

/** How the Kit's comments name a run in flight, at the start of a sentence. */
export function runName(run: RunInFlight): string {
  switch (run.kind) {
    case "retry":
      return `Retry ${run.retry} of ${MAX_RETRIES}`;
    case "request-changes":
      return "The Operator's Request-changes run";
    case "conflict":
      return "The conflict-only run";
  }
}

/** Why a Review on this PR posts no Verdict, while a run is in flight on it; otherwise null. */
export function whyAwaitingRun(pullRequest: PullRequestSnapshot): string | null {
  const run = runInFlight(pullRequest);
  if (run === null) return null;
  return `${runName(run)} on #${pullRequest.number} is still in flight, so ${pullRequest.headSha.slice(0, 7)} gets no Verdict: the run's push starts the next Review`;
}

/**
 * The retry an agent draft PR is owed: the one in flight, on whatever head the
 * PR is at now, the Operator's pushes included; otherwise null. The first
 * retry runs on the Implementer's model and the second Steps up, for this PR
 * only, and every one Steps up while its Ticket carries fabrik:step-up. An
 * Infrastructure failure posts no Verdict, so resuming after one runs the
 * same retry again and uses none up.
 */
export function owedRetry(
  pullRequest: PullRequestSnapshot,
  ticketLabels: readonly string[],
  config: KitConfig,
): Extract<Action, { kind: "start-agent-run" }> | null {
  if (whyNotReviewable(pullRequest) !== null || pullRequest.ticket === null) return null;
  const run = runInFlight(pullRequest);
  if (run?.kind !== "retry") return null;
  const { implement } = config.roles;
  // Never a cheaper model, and never a skipped Step-up, whatever the weekly pool says. The one
  // deliberate exception is the Operator taking fabrik:step-up off the Ticket (ADR-0014).
  const stepUpReason = stepUpReasonFor(run.retry, ticketLabels);
  const { model, effort } = implementSettings(stepUpReason, config);
  return {
    kind: "start-agent-run",
    role: "implement",
    issue: pullRequest.ticket,
    pullRequest: pullRequest.number,
    model,
    effort,
    timeoutMinutes: implement.timeoutMinutes,
    retry: run.retry,
    retryFlaw: run.flaw,
    stepUp: stepUpReason !== null,
    stepUpReason,
  };
}
