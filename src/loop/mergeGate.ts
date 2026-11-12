// The Merge gate: only the Operator merges an agent PR. Short of merging, they
// can request changes, which starts one Request-changes run on the Step-up
// model with their review as input (it isn't a retry), or add needs-design to
// the PR, which sends its Ticket back to design as a Design flaw does.
import { sentBackByOperator } from "./backToDesign.ts";
import { gateUnopened } from "./digest.ts";
import { heldOn, heldUntilReset } from "./hold.ts";
import { DIGEST_LABEL, REVIEW_LABEL } from "./labels.ts";
import { requestChangesRunStartedMarker } from "./markers.ts";
import { runInFlight, runName } from "./retry.ts";
import { reviewLinks, unnotedChangesRequests } from "./undelivered.ts";
import type { Action, KitConfig, LoopEvent, Plan, PullRequestSnapshot, Snapshot } from "./types.ts";

type ChangesRequested = Extract<LoopEvent, { kind: "pull-request-changes-requested" }>;

/**
 * The Operator's Request changes on an agent PR at the Merge gate. The PR goes
 * back to draft, so the run's push starts a Review, and a pass requests the
 * Operator's review again. A conflict with main after another PR merged
 * doesn't need it: the Kit resolves that itself (src/loop/conflicts.ts,
 * ADR-0011), and hands the PR back here only when it can't.
 *
 * One on a passed draft whose gate has yet to open (`gateWaits`), as while
 * its Digest is being written, is acted on the same way, at once (ADR-0022):
 * the PR is a draft already and stays one, and `agent:digest` comes off. The
 * note puts the run in flight, so the Digest attempt under way is dropped
 * when it lands (src/loop/digest.ts), and the pass on the run's push brings
 * the next Digest.
 */
export function requestChanges(event: ChangesRequested, snapshot: Snapshot, config: KitConfig): Plan {
  const { pullRequest, operator } = snapshot;
  if (pullRequest === null) {
    return { kind: "fail", failure: "infrastructure", reason: "The snapshot is missing the pull request" };
  }
  if (event.reviewerIsBot || event.reviewer !== operator) {
    const reason = `${event.reviewer} isn't the Operator, so their review on #${pullRequest.number} starts nothing`;
    // A person's on an open agent PR gets one line saying so, mentioning nobody (#436); a bot's, or one on any other PR, gets none.
    if (event.reviewerIsBot || !pullRequest.isAgent || !pullRequest.open) return { kind: "nothing", reason };
    const body = `Only the Operator's reviews start runs on an agent PR, so the Request changes from ${event.reviewer} on #${pullRequest.number} starts nothing.`;
    return { kind: "act", actions: [{ kind: "comment", issue: pullRequest.number, body }] };
  }
  if (pullRequest.deferredChangesRequests.includes(event.review)) return deferredDuringRetry(pullRequest, event.review);
  const why = whyNotAtMergeGate(pullRequest);
  if (why !== null || pullRequest.ticket === null) return { kind: "nothing", reason: why ?? "" };
  const { number } = pullRequest;
  // A draft here is one whose gate has yet to open: it stays in draft, and the Digest being written for this head is thrown away.
  const waiting = pullRequest.draft;
  // Any earlier one of the Operator's no run was started for, as one GitHub never delivered, goes in this run too:
  // the run reads every Request changes of theirs, so neither check notes that one later.
  const earlier = unnotedChangesRequests(pullRequest, operator)
    .map(({ review }) => review)
    .filter((review) => review !== event.review);
  const reviews = [...earlier, event.review];
  const held = heldOn(snapshot.kitIssues, config);
  const starting =
    held === null
      ? `The Kit is starting the Request-changes run for your Request changes on #${number} (${reviewLinks(pullRequest, reviews)}).`
      : `The Kit has put the Request-changes run for your Request changes on #${number} (${reviewLinks(pullRequest, reviews)}) in flight, but ${heldUntilReset(held)}.`;
  return {
    kind: "act",
    actions: [
      // Marks the run in flight on the PR itself (#341), so the conflict check never notes these reviews as undelivered,
      // and a Review of a head the Operator pushes meanwhile waits for the run (ADR-0006). It mentions nobody.
      {
        kind: "comment",
        issue: number,
        body: [
          requestChangesRunStartedMarker(reviews),
          `${starting} It runs on the Step-up model and uses no retry. ${waiting ? "The PR stays in draft, with no Digest for this head" : "The PR is back in draft"}, and Review runs again on the run's push.`,
        ].join("\n"),
      },
      waiting ? { kind: "remove-label", issue: number, label: DIGEST_LABEL } : { kind: "convert-to-draft", pullRequest: number },
      requestChangesRun(pullRequest.ticket, number, event.review, config),
    ],
  };
}

/**
 * The Operator's Request changes on the draft while a Retry is in flight
 * (#427): the Kit says it defers it, mentioning nobody, and starts nothing. The
 * Retry's Review judges against the Ticket without it, and a pass or an
 * Execution flaw that ends the Retry starts its Request-changes run
 * (src/loop/review.ts), so it never costs a Retry (ADR-0010).
 */
function deferredDuringRetry(pullRequest: PullRequestSnapshot, review: number): Plan {
  const { number } = pullRequest;
  // Once the Retry has pushed, none is in flight, though its Review may still be working.
  const run = runInFlight(pullRequest);
  const retry = run?.kind === "retry" ? runName(run) : "the Retry";
  return {
    kind: "act",
    actions: [
      {
        kind: "comment",
        issue: number,
        body: `Your Request changes on #${number} (${reviewLinks(pullRequest, [review])}) came in while ${retry} was in flight, so the Kit defers it until the Verdict on that Retry's push. Its Review judges #${number} against the Ticket without it. On a pass or an Execution flaw, the Request-changes run for it starts then, on the Step-up model, using no retry; a Design flaw sends the Ticket back to design, closing #${number}.`,
      },
    ],
  };
}

function requestChangesRun(
  ticket: number,
  pullRequest: number,
  review: number,
  config: KitConfig,
): Extract<Action, { kind: "start-agent-run" }> {
  const { implement, stepUp } = config.roles;
  return {
    kind: "start-agent-run",
    role: "implement",
    issue: ticket,
    pullRequest,
    requestChanges: { review },
    model: stepUp.model,
    effort: stepUp.effort,
    timeoutMinutes: implement.timeoutMinutes,
    stepUp: true,
    stepUpReason: "request-changes",
  };
}

/**
 * The Request-changes run an agent PR is still owed, with what starts it, or
 * null: the one in flight on it (#341), which the Kit's note started, or an
 * Execution flaw that gave way to it, and which hasn't pushed or ended. It
 * resumes on whatever head the PR is at now, the Operator's pushes included.
 * A PR that never went back to draft, because that step failed after the
 * note, goes back to draft first: leaving draft would have ended the run.
 * One that ended in an Infrastructure failure gets a fresh started note as
 * the Operator's re-add resumes it (#424): the failure notice left it marked
 * failed, which keeps the conflict check from restarting it, and the note
 * clears that, so the resumed run is rescued if it stalls in turn (#387).
 */
export function owedRequestChangesRun(pullRequest: PullRequestSnapshot, config: KitConfig): Action[] | null {
  if (!pullRequest.isAgent || pullRequest.ticket === null || !pullRequest.open) return null;
  const run = runInFlight(pullRequest);
  if (run === null) return orphanedRequestChangesRun(pullRequest, config);
  if (run.kind !== "request-changes") return null;
  const { number, requestChangesRunReviews: reviews } = pullRequest;
  const start = requestChangesRun(pullRequest.ticket, number, run.review, config);
  const resumed: Action[] = pullRequest.requestChangesRunFailed
    ? [
        {
          kind: "comment",
          issue: number,
          body: [
            requestChangesRunStartedMarker(reviews),
            `The Kit is starting the Request-changes run for your Request changes on #${number} (${reviewLinks(pullRequest, reviews)}) again, after it failed. It runs on the Step-up model and uses no retry, and Review runs again on its push.`,
          ].join("\n"),
        },
      ]
    : [];
  return [...resumed, ...(pullRequest.draft ? [] : [{ kind: "convert-to-draft", pullRequest: number } as const]), start];
}

/** Whether the PR is still at the head its latest Verdict judged. */
function atLatestVerdict(pullRequest: PullRequestSnapshot): boolean {
  return pullRequest.verdicts.at(-1)?.headSha === pullRequest.headSha;
}

/**
 * The PR back from a Request-changes run the Operator dismissed every review
 * of, with nothing else owed (#341), after `lead`: at the Merge gate, while
 * it's still at the head its latest Verdict judged. A head that moved since,
 * as the Operator's own push, gets a Review instead, through agent:review:
 * one pushed while the run was in flight, or at the Merge gate, had none, and
 * one pushed since gets only the one Verdict a head is given.
 */
export function handBack(pullRequest: PullRequestSnapshot, lead: string): Action[] {
  const { number } = pullRequest;
  return atLatestVerdict(pullRequest)
    ? [
        { kind: "comment", issue: number, body: `${lead} #${number} is back at the Merge gate.` },
        { kind: "mark-ready-for-review", pullRequest: number },
      ]
    : [
        { kind: "comment", issue: number, body: `${lead} Review runs on #${number}'s head, which moved since its last Verdict.` },
        // It notifies nobody, and takes itself off as the Review starts.
        { kind: "add-labels", issue: number, labels: [REVIEW_LABEL] },
      ];
}

/**
 * The run owed for the Operator's Request changes on the draft once the run
 * the Kit put it in draft for had every review dismissed, with no outcome
 * since (#341), as when that run failed or was held: the Kit notes the new
 * run, which marks it in flight, and starts it. Null when there's none.
 */
function orphanedRequestChangesRun(pullRequest: PullRequestSnapshot, config: KitConfig): Action[] | null {
  const reviews = pullRequest.orphanedChangesRequests;
  if (!pullRequest.draft || pullRequest.ticket === null) return null;
  const { number } = pullRequest;
  // None of theirs is owed: the run the Kit put the PR in draft for is over, so the PR goes back to them.
  if (reviews.length === 0) {
    return pullRequest.requestChangesRunDismissed && !pullRequest.pushedSinceVerdict
      ? handBack(pullRequest, `You dismissed the Request changes the Kit put #${number} in draft for, so no run is owed for it.`)
      : null;
  }
  return [
    {
      kind: "comment",
      issue: number,
      body: [
        requestChangesRunStartedMarker(reviews),
        `The Kit is starting the Request-changes run for your Request changes on #${number} (${reviewLinks(pullRequest, reviews)}), as you dismissed the reviews the run it replaces was for. It runs on the Step-up model and uses no retry, and Review runs again on its push.`,
      ].join("\n"),
    },
    requestChangesRun(pullRequest.ticket, number, Math.max(...reviews), config),
  ];
}

/**
 * needs-design added to an agent PR sends its Ticket back to design, as a
 * Design flaw does, whether the PR waits at the Merge gate or is still in the Loop.
 */
export function sendBackToDesign(pullRequest: PullRequestSnapshot): Plan {
  if (!pullRequest.isAgent) return { kind: "nothing", reason: `#${pullRequest.number} isn't an agent PR` };
  if (!pullRequest.open) return { kind: "nothing", reason: `#${pullRequest.number} is closed` };
  return { kind: "act", actions: sentBackByOperator(pullRequest) };
}


/**
 * Why this PR isn't an open agent PR where the Operator's Request changes is
 * acted on, or null when it is: one waiting at the Merge gate, or a passed
 * draft whose gate has yet to open (`gateWaits`).
 */
function whyNotAtMergeGate(pullRequest: PullRequestSnapshot): string | null {
  if (!pullRequest.isAgent) return `#${pullRequest.number} isn't an agent PR`;
  if (pullRequest.ticket === null) return `#${pullRequest.number}'s branch names no Ticket`;
  if (!pullRequest.open) return `#${pullRequest.number} is closed`;
  if (pullRequest.draft && !gateWaits(pullRequest)) return `#${pullRequest.number} is still a draft in the Loop, not at the Merge gate`;
  return null;
}

/**
 * Whether the PR is a passed draft waiting for its Merge gate to open, as it
 * does while its Digest is written and in the moment after that attempt
 * ends (ADR-0022): a draft whose latest Verdict is a pass on its head, which
 * has not left draft since that pass (`gateUnopened`) and has no run in
 * flight on it. So never a draft with no pass on its head; nor one the
 * Operator put back in draft after the gate opened; nor one a pass kept in
 * draft for a run, to be brought up to date with main or for a Request
 * changes deferred during a Retry.
 */
function gateWaits(pullRequest: PullRequestSnapshot): boolean {
  return gateUnopened(pullRequest) && runInFlight(pullRequest) === null;
}
