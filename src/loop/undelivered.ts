// An undelivered Request changes (#341, ADR-0015): GitHub starts no workflow
// for a pull_request-family event while a PR conflicts with its base, so the
// Operator's Request changes on such a PR reaches the Loop through no event.
// The conflict check, on a push to main and on the hourly tick, finds one no
// run was started for, says so on the PR once, and starts its Request-changes
// run, which merges main in when the PR conflicts. Every Request-changes run
// the Kit starts is marked on the PR by the note that started it
// (src/github/threads.ts), so neither check ever notes the same review twice,
// and the conflict check leaves the PR to that run.
import { heldUntilReset } from "./hold.ts";
import { DISPATCH_LABEL } from "./labels.ts";
import { undeliveredMarker } from "./markers.ts";
import type { Action, ConflictCandidate, PullRequestSnapshot, UnbuiltChangesRequest } from "./types.ts";

/** How long a Request changes waits for GitHub to deliver it before the Kit counts it as undelivered. */
export const UNDELIVERED_GRACE_MINUTES = 10;

/**
 * The Operator's Request changes on this PR that nothing has settled, oldest
 * first: no Request-changes run has pushed or been given a Verdict since, and
 * no Review has passed it. Anyone else's review starts nothing, as on the
 * event path.
 */
export function operatorChangesRequests(pullRequest: PullRequestSnapshot, operator: string): UnbuiltChangesRequest[] {
  return pullRequest.unbuiltChangesRequests.filter(({ reviewer, reviewerIsBot }) => !reviewerIsBot && reviewer === operator);
}

/** Those of them no Request-changes run was started for yet, whatever their age. */
export function unnotedChangesRequests(pullRequest: PullRequestSnapshot, operator: string): UnbuiltChangesRequest[] {
  return operatorChangesRequests(pullRequest, operator).filter(({ review }) => !pullRequest.notedChangesRequests.includes(review));
}

/** Links to these reviews on the PR, absolute, so they lead there from the notification email too. */
export function reviewLinks(pullRequest: PullRequestSnapshot, reviews: readonly number[]): string {
  return reviews.map((review) => `[review ${review}](${pullRequest.url}#pullrequestreview-${review})`).join(", ");
}

/**
 * Whether the PR is where an undelivered Request changes is acted on: an open
 * agent PR for a Ticket at the Merge gate, out of draft, with no
 * Request-changes or conflict-only run in flight. On a draft, a Review, Retry
 * or conflict-only run is in flight, and lands first (ADR-0006): an Execution
 * flaw it gives starts the Request-changes run itself (src/loop/review.ts).
 */
function actsOn(pullRequest: PullRequestSnapshot): boolean {
  if (!pullRequest.isAgent || pullRequest.ticket === null || !pullRequest.open || pullRequest.draft) return false;
  return pullRequest.requestChangesRunInFlight === null && pullRequest.conflictRunInFlight === null;
}

/**
 * What the conflict check does about this PR's undelivered Request changes,
 * or null when it has none to act on. Once one is older than the grace
 * period, so a delivery that's merely slow isn't counted, the Kit posts one
 * note naming every review no run was started for, which puts their
 * Request-changes run in flight for the latest of them, turns the PR back to
 * draft, and adds agent:implement on the Ticket, which starts that run
 * (src/loop/implement.ts). The run reads all the Operator's Request changes,
 * and, when the PR conflicts with main, merges main in. The note goes first:
 * if the rest fails, the next check, or re-adding agent:implement, still
 * starts the run.
 */
export function actOnUndelivered(
  { pullRequest, mergeable }: ConflictCandidate,
  operator: string,
  now: string,
  held: number | null = null,
  runMinutes: number = UNDELIVERED_GRACE_MINUTES,
  implementJobUnderWay: boolean | null = null,
): Action[] | null {
  const stalled = stalledRequestChangesRun(pullRequest, now, implementJobUnderWay);
  if (stalled !== null) return stalled;
  if (!actsOn(pullRequest)) return null;
  const unnoted = unnotedChangesRequests(pullRequest, operator);
  // GitHub delivers a review on a PR that merges cleanly, so a run may be working for it whose claim never noted it:
  // the Kit waits until that run can't still be working (`runMinutes`, the Implement job's timeout) before starting
  // another. A PR that conflicts, or may, had none started.
  const grace = mergeable === true ? Math.max(runMinutes, UNDELIVERED_GRACE_MINUTES) : UNDELIVERED_GRACE_MINUTES;
  const cutoff = Date.parse(now) - grace * 60_000;
  if (!unnoted.some(({ submittedAt }) => Date.parse(submittedAt) <= cutoff)) return null;
  const reviews = unnoted.map(({ review }) => review);
  const { number } = pullRequest;
  const links = reviewLinks(pullRequest, reviews);
  const why = "GitHub doesn't start workflows for reviews while a pull request conflicts with its base";
  // A PR that merges cleanly most likely had a run start that came to nothing, as when its claim failed.
  const opening =
    mergeable === false
      ? `GitHub started no run for your Request changes on #${number} (${links}): #${number} conflicts with \`main\`, and ${why}.`
      : mergeable === null
        ? `GitHub started no run for your Request changes on #${number} (${links}). #${number} may conflict with \`main\`, which GitHub hasn't worked out yet, and ${why}.`
        : `No Request-changes run is under way for your Request changes on #${number} (${links}).`;
  // GitHub hadn't worked out whether it conflicts: the run's own check decides, so the note says either may happen.
  const merging =
    mergeable === false
      ? ", merging `main` in first to resolve the conflict,"
      : mergeable === null
        ? `, merging \`main\` in first if #${number} conflicts with it,`
        : "";
  const body = [
    undeliveredMarker(reviews),
    opening,
    "",
    held === null
      ? `The Kit is starting the Request-changes run now${merging} so there's nothing for you to resubmit. It runs on the Step-up model and uses no retry. The PR is back in draft, and Review runs again on the run's push.`
      : `The Kit has put the Request-changes run in flight${merging} so there's nothing for you to resubmit, but ${heldUntilReset(held)}. It runs on the Step-up model and uses no retry. The PR is back in draft, and Review runs again on the run's push.`,
  ].join("\n");
  return [
    { kind: "comment", issue: number, body },
    // A fresh agent:implement on the Ticket starts the run the note put in flight on its open PR. It notifies nobody.
    { kind: "add-labels", issue: pullRequest.ticket as number, labels: [DISPATCH_LABEL] },
    { kind: "convert-to-draft", pullRequest: number },
  ];
}

/**
 * A Request-changes run in flight that no job is working, or null. The check
 * starts it with a fresh agent:implement, which turns a PR still out of draft
 * to draft first. A note younger than the grace period is left alone either
 * way. It is stalled when:
 * - The PR is still out of draft: the Kit noted the run, but what followed the
 *   note failed, so the PR was never turned to draft and the run never started
 *   (#341). Only that leaves one so: the PR leaving draft ends the run in
 *   flight. The job that posted the note turns the PR to draft moments later.
 * - The PR is a draft and no Implement job is under way anywhere in the repo
 *   (#387): the claim noted the run with no Implement job behind it, as when
 *   the Operator re-ran only a claim that had failed after its Implement job
 *   ran. A run that is genuinely working has its Implement job, or the push
 *   job that lands it, under way, so the check leaves it alone. So does a
 *   check that couldn't read the jobs.
 */
function stalledRequestChangesRun(pullRequest: PullRequestSnapshot, now: string, implementJobUnderWay: boolean | null): Action[] | null {
  const { ticket, requestChangesRunSince: since } = pullRequest;
  if (!pullRequest.isAgent || ticket === null || !pullRequest.open) return null;
  if (pullRequest.draft && implementJobUnderWay !== false) return null;
  if (pullRequest.requestChangesRunInFlight === null || since === null) return null;
  if (Date.parse(now) - Date.parse(since) < UNDELIVERED_GRACE_MINUTES * 60_000) return null;
  return [{ kind: "add-labels", issue: ticket, labels: [DISPATCH_LABEL] }];
}
