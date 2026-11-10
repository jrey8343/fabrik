// Execution-flaw retries: an Execution flaw on an agent PR re-runs the
// Implementer on the same branch with the findings as input, then Review runs
// again. A Ticket gets two Retries in all, one pool counted from its empty
// diffs and Broken runs before the PR opened and the PR's earlier Verdicts
// (#415, #434), and they stay silent: no mention, assignment or review
// request. While one is in
// flight, no other head gets a Verdict, so each flaw starts exactly one
// Implementer attempt (ADR-0006).
import { whyNotReviewable } from "./agentPullRequest.ts";
import { type HeldOn, heldUntilThen, startsWhen } from "./hold.ts";
import { DISPATCH_LABEL, READY_FOR_AGENT, STEP_UP_LABEL } from "./labels.ts";
import { RETRY_ENDED_MARKER, RETRY_RESTARTED_MARKER } from "./markers.ts";
import type { Action, KitConfig, PullRequestSnapshot, StepUpReason, VerdictRecord } from "./types.ts";

/** Execution-flaw retries a Ticket gets before the next flaw counts as a Design flaw. */
export const MAX_RETRIES = 2;

/** Whether this retry Steps up: the last one does, while the first run and earlier retries use the Implementer's model. */
function stepsUp(retry: number): boolean {
  return retry >= MAX_RETRIES;
}

/** A stepped-up run that isn't a Retry, whose push a flaw can call for one on: conflict-only (#304) or Request-changes (#393). */
type PrecedingRun = Extract<StepUpReason, "conflict-only" | "request-changes">;

/**
 * Why a first run or a Retry on a Ticket with these labels Steps up, or null
 * when it runs on the Implementer's model. The label is read as the run
 * starts, so adding it mid-chain steps up the next run and removing it drops
 * back (ADR-0014). On a marked Ticket the second Retry says `marked`. A Retry
 * called for by a flaw on a conflict-only or Request-changes run's push,
 * `after`, keeps that run's Step-up and its reason, so it never drops to a
 * cheaper model on the same PR (#464); the last Retry still says `retry`.
 */
export function stepUpReasonFor(
  retry: number,
  ticketLabels: readonly string[],
  after: PrecedingRun | null = null,
): Extract<StepUpReason, "retry" | "marked" | PrecedingRun> | null {
  if (ticketLabels.includes(STEP_UP_LABEL)) return "marked";
  if (stepsUp(retry)) return "retry";
  return after;
}

/** Which stepped-up run, if any, pushed the head this flaw was given on, so the Retry it calls for keeps its Step-up (#464). */
export function precedingRun(flaw: Pick<VerdictRecord, "requestChanges" | "conflictRun">): PrecedingRun | null {
  if (flaw.conflictRun === true) return "conflict-only";
  return flaw.requestChanges ? "request-changes" : null;
}

/** The model and effort an Implement run with this Step-up reason runs on. */
export function implementSettings(reason: StepUpReason | null, config: KitConfig): KitConfig["roles"]["stepUp"] {
  const { implement, stepUp } = config.roles;
  return reason === null ? { model: implement.model, effort: implement.effort } : stepUp;
}

/**
* Which retry an Execution flaw calls for, given the Verdicts posted before it
 * and the Ticket's empty diffs and Broken runs before its PR opened: one more
 * than those and the earlier Execution flaws that each called for one, as they
 * draw on one pool of Retries (#415, #434). A Request-changes run (#393) and a
 * conflict-only run (#304) use no retry, but a flaw on their push calls for one
 * like any other, so it counts. A flaw that gave way to an undelivered Request
 * changes (#341) and one on a Ticket no longer `ready-for-agent` (#416) call
 * for none, so they don't, and an Infrastructure failure posts no Verdict at all,
 * though a Broken Retry posts one, which counts (#434). One from a Flaky check
 * (#462), whose checks have since passed on its head, doesn't count either,
 * though the Retry it called for ran.
 */
export function retryNumber(earlier: readonly VerdictRecord[], landedNothing: number): number {
  return (
    1 +
    landedNothing +
    earlier.filter(
      (record) => record.verdict === "execution-flaw" && record.requestChangesFirst === undefined && record.ticketNotReady !== true && record.flaky !== true,
    ).length
  );
}

/**
 * Whether this PR's Ticket is no longer `ready-for-agent`, as the snapshot
 * read its labels through the PR's closing link (#416): agent:implement on it
 * starts nothing (src/loop/implement.ts), so no Retry can start. A PR that no
 * longer links its Ticket reads no labels, which tells nothing, so it isn't.
 */
export function ticketNotReady(pullRequest: PullRequestSnapshot): boolean {
  const { ticketLabels } = pullRequest;
  return ticketLabels.length > 0 && !ticketLabels.includes(READY_FOR_AGENT);
}

/** What a Verdict leads to beyond its comment: the line it ends with, its actions, and whether its Ticket was no longer `ready-for-agent` (#416). */
export interface VerdictNext {
  readonly line: string;
  readonly actions: Action[];
  readonly ticketNotReady?: true;
}

/**
 * What an Execution flaw on this PR does next: its retry and a line saying so,
 * or null when its retries are used up, so the flaw counts as a Design flaw.
 * On a Ticket no longer `ready-for-agent`, as when the Operator relabelled it
 * during the Review, it says so and starts nothing, marked `ticketNotReady` (#416).
 * `held` is the carrier a run due now is held on, or null (heldOn).
 */
export function retryAfterFlaw(pullRequest: PullRequestSnapshot, held: HeldOn | null): VerdictNext | null {
  const { ticket } = pullRequest;
  // The flaw being given now isn't in the Verdicts yet: the run that pushed the head it judges is on the snapshot.
  const judged = { requestChanges: pullRequest.requestChangesRun, ...(pullRequest.conflictRun ? { conflictRun: true as const } : {}) };
  const retry = retryNumber(pullRequest.verdicts, pullRequest.ticketLandedNothing);
  if (retry > MAX_RETRIES || ticket === null) return null;
  if (ticketNotReady(pullRequest)) {
    return { line: ticketNotReadyLine(pullRequest.number, ticket), actions: [], ticketNotReady: true };
  }
  return {
    line: `Retry ${retry} of ${MAX_RETRIES} ${startsWhen(held)}${stepUpReasonFor(retry, pullRequest.ticketLabels, precedingRun(judged)) === null ? "" : ", stepped up"}: the Implementer fixes these findings on the same branch.${heldUntilThen(held)}`,
    // A fresh agent:implement on the Ticket resumes the PR's Implement run (src/loop/implement.ts). It notifies nobody.
    actions: [{ kind: "add-labels", issue: ticket, labels: [DISPATCH_LABEL] }],
  };
}

/** What the Kit says when a Retry can't start because the Ticket is no longer `ready-for-agent` (#416), and how the Operator goes on. */
function ticketNotReadyLine(pullRequest: number, ticket: number): string {
  return `#${ticket} is no longer \`ready-for-agent\`, so no Retry starts. #${pullRequest} stays in draft: push to it to have it reviewed again, or take it out of draft to take it over.`;
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
 * outcome: its push, or its empty-diff or broken-run Verdict (which may call
 * for the next one, #434). A Request-changes run is in flight from the Kit's note that started
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
  // One on a Ticket no longer ready-for-agent called for no Retry, and one the Kit has since ended for that reason has none in flight (#416).
  if (latest.ticketNotReady === true || pullRequest.retryNoteSinceVerdict === "ended") return null;
  // A Retry works on a draft: once the PR has left draft since the flaw, as when the Operator took it back or the Kit
  // handed it to them, none is in flight, even after something turns the PR to draft again.
  if (!pullRequest.draft || pullRequest.leftDraftSinceVerdict) return null;
  // One that gave way to the Operator's Request changes (#341) called for no Retry, and never owes one: its
  // Request-changes run fixes its findings, and if the Operator dismisses those reviews, the PR is theirs.
  if (latest.requestChangesFirst !== undefined) return null;
  const retry = retryNumber(pullRequest.verdicts.slice(0, -1), pullRequest.ticketLandedNothing);
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
 * only, and every one Steps up while its Ticket carries fabrik:step-up, or
 * when the flaw calling for it was on a conflict-only or Request-changes run's
 * push (#464). An Infrastructure failure posts no Verdict, so resuming after
 * one runs the same retry again and uses none up.
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
  // A Retry in flight is called for by the PR's latest Verdict, so that flaw says which run it followed (#464).
  const flaw = pullRequest.verdicts.at(-1);
  const stepUpReason = stepUpReasonFor(run.retry, ticketLabels, flaw === undefined ? null : precedingRun(flaw));
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
 * What the conflict check does about a Retry in flight that never started
 * (#416), or null. Its Verdict announced it, but what followed the comment
 * failed, so agent:implement never reached the Ticket, and a re-run of the
 * Review job lands nothing on a head that already has a Verdict. The check
 * counts it as never started once its Verdict is older than the Implement
 * job's timeout (`runMinutes`) with no Implement job under way anywhere in the
 * repo, as for a Request-changes run (src/loop/undelivered.ts); a check that
 * couldn't read the jobs leaves it alone. It says so on the PR and re-adds
 * agent:implement on the Ticket, which resumes it, once: if that comes to
 * nothing too, as after an Infrastructure failure, whose notice says the Loop
 * won't run it again, the Retry waits for the Operator (ADR-0006). On a Ticket
 * no longer `ready-for-agent` it instead says once, mentioning the Operator,
 * that no Retry starts, which ends it.
 */
export function unstartedRetry(
  pullRequest: PullRequestSnapshot,
  operator: string,
  now: string,
  runMinutes: number,
  implementJobUnderWay: boolean | null,
): Action[] | null {
  const { number, ticket, verdictPostedAt } = pullRequest;
  if (!pullRequest.isAgent || ticket === null || !pullRequest.open || implementJobUnderWay !== false || verdictPostedAt === null) return null;
  if (pullRequest.retryNoteSinceVerdict !== null) return null;
  const run = runInFlight(pullRequest);
  if (run?.kind !== "retry") return null;
  if (Date.parse(now) - Date.parse(verdictPostedAt) < runMinutes * 60_000) return null;
  if (ticketNotReady(pullRequest)) {
    return [{ kind: "comment", issue: number, body: [RETRY_ENDED_MARKER, `@${operator} ${runName(run)} on #${number} never started. ${ticketNotReadyLine(number, ticket)}`].join("\n") }];
  }
  return [
    {
      kind: "comment",
      issue: number,
      body: [
        RETRY_RESTARTED_MARKER,
        `${runName(run)} on #${number} never started, so the Kit has added \`agent:implement\` to #${ticket} again to start it. It does this once: if the Retry doesn't push this time, re-add \`agent:implement\` on the Ticket (#${ticket}) to resume it, or take #${number} out of draft to take it over.`,
      ].join("\n"),
    },
    // A fresh agent:implement on the Ticket resumes the Retry (src/loop/implement.ts). The note notifies nobody.
    { kind: "add-labels", issue: ticket, labels: [DISPATCH_LABEL] },
  ];
}
