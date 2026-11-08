// The Merge gate: only the Operator merges an agent PR. Short of merging, they
// can request changes, which starts one Request-changes run on the Step-up
// model with their review as input (it isn't a retry), or add needs-design to
// the PR, which sends its Ticket back to design as a Design flaw does.
import { sentBackByOperator } from "./backToDesign.ts";
import { heldOn, heldUntilReset } from "./hold.ts";
import { requestChangesRunStartedMarker } from "./markers.ts";
import { runInFlight } from "./retry.ts";
import { reviewLinks, unnotedChangesRequests } from "./undelivered.ts";
import type { Action, KitConfig, LoopEvent, Plan, PullRequestSnapshot, Snapshot } from "./types.ts";

type ChangesRequested = Extract<LoopEvent, { kind: "pull-request-changes-requested" }>;

/**
 * The Operator's Request changes on an agent PR at the Merge gate. The PR goes
 * back to draft, so the run's push starts a Review, and a pass requests the
 * Operator's review again. A conflict with main after another PR merged
 * doesn't need it: the Kit resolves that itself (src/loop/conflicts.ts,
 * ADR-0011), and hands the PR back here only when it can't.
 */
export function requestChanges(event: ChangesRequested, snapshot: Snapshot, config: KitConfig): Plan {
  const { pullRequest, operator } = snapshot;
  if (pullRequest === null) {
    return { kind: "fail", failure: "infrastructure", reason: "The snapshot is missing the pull request" };
  }
  if (event.reviewerIsBot || event.reviewer !== operator) {
    return { kind: "nothing", reason: `${event.reviewer} isn't the Operator, so their review on #${pullRequest.number} starts nothing` };
  }
  const why = whyNotAtMergeGate(pullRequest);
  if (why !== null || pullRequest.ticket === null) return { kind: "nothing", reason: why ?? "" };
  const { number } = pullRequest;
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
          `${starting} It runs on the Step-up model and uses no retry. The PR is back in draft, and Review runs again on the run's push.`,
        ].join("\n"),
      },
      { kind: "convert-to-draft", pullRequest: number },
      requestChangesRun(pullRequest.ticket, number, event.review, config),
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
  };
}

/**
 * The Request-changes run an agent PR is still owed, with what starts it, or
 * null: the one in flight on it (#341), which the Kit's note started, or an
 * Execution flaw that gave way to it, and which hasn't pushed or ended. It
 * resumes on whatever head the PR is at now, the Operator's pushes included.
 * A PR that never went back to draft, because that step failed after the
 * note, goes back to draft first: leaving draft would have ended the run.
 */
export function owedRequestChangesRun(pullRequest: PullRequestSnapshot, config: KitConfig): Action[] | null {
  if (!pullRequest.isAgent || pullRequest.ticket === null || !pullRequest.open) return null;
  const run = runInFlight(pullRequest);
  if (run === null) return orphanedRequestChangesRun(pullRequest, config);
  if (run.kind !== "request-changes") return null;
  const start = requestChangesRun(pullRequest.ticket, pullRequest.number, run.review, config);
  return pullRequest.draft ? [start] : [{ kind: "convert-to-draft", pullRequest: pullRequest.number }, start];
}

/** Whether the PR is still at the head its latest Verdict judged: no push since has a Review to come. */
export function atLatestVerdict(pullRequest: PullRequestSnapshot): boolean {
  return pullRequest.verdicts.at(-1)?.headSha === pullRequest.headSha;
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
  // None of theirs is owed: the run the Kit put the PR in draft for is over, so it goes back to them, unless someone
  // pushed to it since, whose Review then decides.
  if (reviews.length === 0) {
    return pullRequest.requestChangesRunDismissed && !pullRequest.pushedSinceVerdict && atLatestVerdict(pullRequest)
      ? [
          {
            kind: "comment",
            issue: number,
            body: `You dismissed the Request changes the Kit put #${number} in draft for, so no run is owed for it, and #${number} is back at the Merge gate.`,
          },
          { kind: "mark-ready-for-review", pullRequest: number },
        ]
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


/** Why this PR isn't an open agent PR waiting at the Merge gate, or null when it is. */
function whyNotAtMergeGate(pullRequest: PullRequestSnapshot): string | null {
  if (!pullRequest.isAgent) return `#${pullRequest.number} isn't an agent PR`;
  if (pullRequest.ticket === null) return `#${pullRequest.number}'s branch names no Ticket`;
  if (!pullRequest.open) return `#${pullRequest.number} is closed`;
  if (pullRequest.draft) return `#${pullRequest.number} is still a draft in the Loop, not at the Merge gate`;
  return null;
}
