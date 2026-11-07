// An undelivered Request changes (#341, ADR-0014): GitHub starts no workflow
// for a pull_request-family event while a PR conflicts with its base, so the
// Operator's Request changes on such a PR reaches the Loop through no event.
// The conflict check, on a push to main and on the hourly tick, finds one
// GitHub didn't deliver, says so on the PR once, and starts its
// Request-changes run, which merges main in when the PR conflicts. The note
// itself marks that run in flight (src/loop/retry.ts), so neither check ever
// notes the same review twice, and the conflict check leaves the PR to it.
import { DISPATCH_LABEL } from "./labels.ts";
import { undeliveredMarker } from "./markers.ts";
import type { Action, ConflictCandidate, PullRequestSnapshot, UnbuiltChangesRequest } from "./types.ts";

/** How long a Request changes waits for GitHub to deliver it before the Kit counts it as undelivered. */
export const UNDELIVERED_GRACE_MINUTES = 10;

/**
 * The Operator's Request changes on this PR that no Request-changes run has
 * built and no Kit note names yet, oldest first, whatever their age. Anyone
 * else's review starts nothing, as on the event path.
 */
export function unnotedChangesRequests(pullRequest: PullRequestSnapshot, operator: string): UnbuiltChangesRequest[] {
  const noted = new Set(pullRequest.undeliveredNotices.flat());
  return pullRequest.unbuiltChangesRequests.filter(
    ({ review, reviewer, reviewerIsBot }) => !reviewerIsBot && reviewer === operator && !noted.has(review),
  );
}

/** Those of them older than the grace period, so a delivery that's merely slow isn't counted. */
function undeliveredChangesRequests(pullRequest: PullRequestSnapshot, operator: string, now: string): UnbuiltChangesRequest[] {
  const cutoff = Date.parse(now) - UNDELIVERED_GRACE_MINUTES * 60_000;
  return unnotedChangesRequests(pullRequest, operator).filter(({ submittedAt }) => Date.parse(submittedAt) <= cutoff);
}

/**
 * Whether the PR is where an undelivered Request changes is acted on: an open
 * agent PR for a Ticket, either at the Merge gate (out of draft, where no run
 * is ever in flight), or a draft whose latest Verdict gave way to the Request
 * changes and has had no run since. A draft with a Review, Retry or
 * conflict-only run in flight waits for that run to land (ADR-0006).
 */
function actsOn(pullRequest: PullRequestSnapshot): boolean {
  if (!pullRequest.isAgent || pullRequest.ticket === null || !pullRequest.open) return false;
  if (pullRequest.conflictRunInFlight !== null || pullRequest.undeliveredNotices.length > 0) return false;
  if (!pullRequest.draft) return true;
  return pullRequest.verdicts.at(-1)?.requestChangesFirst === true && !pullRequest.pushedSinceVerdict;
}

/**
 * What the conflict check does about this PR's undelivered Request changes,
 * or null when it has none to act on: one note naming every one of them, the
 * PR back to draft, and agent:implement on the Ticket, which starts the
 * Request-changes run for the latest (src/loop/implement.ts). That run reads
 * all the Operator's Request changes, and, when the PR conflicts with main,
 * merges main in.
 */
export function actOnUndelivered({ pullRequest, mergeable }: ConflictCandidate, operator: string, now: string): Action[] | null {
  if (!actsOn(pullRequest)) return null;
  const reviews = undeliveredChangesRequests(pullRequest, operator, now);
  if (reviews.length === 0) return null;
  const { number } = pullRequest;
  const links = reviews.map(({ review }) => `[review ${review}](#pullrequestreview-${review})`).join(", ");
  const body = [
    undeliveredMarker(reviews.map(({ review }) => review)),
    `GitHub started no run for your Request changes on #${number} (${links}), so the Kit didn't hear about ${reviews.length === 1 ? "it" : "them"} until now.`,
    ...(mergeable === false ? ["", `#${number} conflicts with \`main\`, and GitHub doesn't start workflows for reviews while a pull request conflicts with its base.`] : []),
    "",
    `The Kit is starting the Request-changes run now${mergeable === false ? ", merging `main` in to resolve the conflict," : ""} so there's nothing for you to resubmit. It uses no retry. The PR is back in draft, and Review runs again on the run's push.`,
  ].join("\n");
  return [
    { kind: "comment", issue: number, body },
    ...(pullRequest.draft ? [] : [{ kind: "convert-to-draft" as const, pullRequest: number }]),
    // A fresh agent:implement on the Ticket starts the run the note put in flight on its open PR. It notifies nobody.
    { kind: "add-labels", issue: pullRequest.ticket as number, labels: [DISPATCH_LABEL] },
  ];
}
