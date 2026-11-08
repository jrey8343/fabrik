// Execution-flaw retries: an Execution flaw on an agent PR re-runs the
// Implementer on the same branch with the findings as input, then Review runs
// again. Retries are counted from the PR's earlier Verdict comments alone, and
// stay silent: no mention, assignment or review request. While one is in
// flight, no other head gets a Verdict, so each flaw starts exactly one
// Implementer attempt (ADR-0006).
import { whyNotReviewable } from "./agentPullRequest.ts";
import { DISPATCH_LABEL, READY_FOR_AGENT, STEP_UP_LABEL } from "./labels.ts";
import { RETRY_ENDED_MARKER } from "./markers.ts";
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
 * one more than the earlier Execution flaws that each called for one. A
 * Request-changes run uses no retry, but a flaw on its push calls for one like
 * any other, so it counts (#393). A conflict-only run's Verdict (#304), a
 * flaw that gave way to an undelivered Request changes (#341) and one on a
 * Ticket that had left the Loop (#416) call for none, so they don't, and an
 * Infrastructure failure posts no Verdict at all.
 */
export function retryNumber(earlier: readonly VerdictRecord[]): number {
  return (
    1 +
    earlier.filter(
      (record) =>
        record.verdict === "execution-flaw" && record.conflictRun !== true && record.requestChangesFirst === undefined && record.leftLoop !== true,
    ).length
  );
}

/**
 * Whether this PR's Ticket has left the Loop, as the snapshot read its labels:
 * it's no longer `ready-for-agent`, so agent:implement on it starts nothing
 * (src/loop/implement.ts) and no Retry can start (#416).
 */
export function ticketLeftLoop(pullRequest: PullRequestSnapshot): boolean {
  return !pullRequest.ticketLabels.includes(READY_FOR_AGENT);
}

/**
 * What an Execution flaw on this PR does next: its retry and a line saying so,
 * or null when its retries are used up, so the flaw counts as a Design flaw.
 * On a Ticket that has left `ready-for-agent`, as when the Operator relabelled
 * it during the Review, it says so and starts nothing, marked `leftLoop` (#416).
 */
export function retryAfterFlaw(
  pullRequest: PullRequestSnapshot,
): { readonly line: string; readonly actions: Action[]; readonly leftLoop?: true } | null {
  const { ticket } = pullRequest;
  const retry = retryNumber(pullRequest.verdicts);
  if (retry > MAX_RETRIES || ticket === null) return null;
  if (ticketLeftLoop(pullRequest)) {
    return { line: leftLoopLine(pullRequest.number, ticket), actions: [], leftLoop: true };
  }
  return {
    line: `Retry ${retry} of ${MAX_RETRIES} starts now${stepUpReasonFor(retry, pullRequest.ticketLabels) === null ? "" : ", stepped up"}: the Implementer fixes these findings on the same branch.`,
    // A fresh agent:implement on the Ticket resumes the PR's Implement run (src/loop/implement.ts). It notifies nobody.
    actions: [{ kind: "add-labels", issue: ticket, labels: [DISPATCH_LABEL] }],
  };
}

/** What the Kit says when a Retry can't start because the Ticket has left the Loop (#416). */
export function leftLoopLine(pullRequest: number, ticket: number): string {
  return `#${ticket} is no longer \`ready-for-agent\`, so it has left the Loop and no Retry starts. #${pullRequest} stays in draft: push to it to have it reviewed again, or take it out of draft to take it over.`;
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
 * it, or the Execution flaw that gave way to it, until its push, its Verdict,
 * its ended note or its note that it committed nothing (#388), or until the
 * PR leaves draft (#341). An Infrastructure
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
  // One on a Ticket that had left the Loop called for no Retry, and one the Kit has since ended for that reason has none in flight (#416).
  if (latest.leftLoop === true || pullRequest.retryEndedSinceVerdict) return null;
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

/**
 * A Retry in flight that nothing is working (#416), and what the conflict
 * check does about it, or null. Its Verdict announced it, but what followed
 * the comment failed, so agent:implement never reached the Ticket, and a re-run
 * of the Review job lands nothing on a head that already has a Verdict. It is
 * stalled once its Verdict is older than the Implement job's timeout
 * (`runMinutes`) with no Implement job under way anywhere in the repo, as for a
 * stalled Request-changes run (src/loop/undelivered.ts); a check that couldn't
 * read the jobs leaves it alone. The check re-adds agent:implement on the
 * Ticket, which resumes it, or, if the Ticket has left `ready-for-agent`, says
 * so once with the Operator mentioned, which ends it.
 */
export function stalledRetry(
  pullRequest: PullRequestSnapshot,
  operator: string,
  now: string,
  runMinutes: number,
  implementJobUnderWay: boolean | null,
): Action[] | null {
  const { ticket, verdictPostedAt } = pullRequest;
  if (!pullRequest.isAgent || ticket === null || !pullRequest.open || implementJobUnderWay !== false || verdictPostedAt === null) return null;
  const run = runInFlight(pullRequest);
  if (run?.kind !== "retry") return null;
  if (Date.parse(now) - Date.parse(verdictPostedAt) < runMinutes * 60_000) return null;
  if (!ticketLeftLoop(pullRequest)) return [{ kind: "add-labels", issue: ticket, labels: [DISPATCH_LABEL] }];
  return [
    {
      kind: "comment",
      issue: pullRequest.number,
      body: [RETRY_ENDED_MARKER, `@${operator} ${runName(run)} on #${pullRequest.number} never started. ${leftLoopLine(pullRequest.number, ticket)}`].join("\n"),
    },
  ];
}
