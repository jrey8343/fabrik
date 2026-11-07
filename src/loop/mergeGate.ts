// The Merge gate: only the Operator merges an agent PR. Short of merging, they
// can request changes, which starts one Request-changes run on the Step-up
// model with their review as input (it isn't a retry), or add needs-design to
// the PR, which sends its Ticket back to design as a Design flaw does.
import { whyNotReviewable } from "./agentPullRequest.ts";
import { sentBackByOperator } from "./backToDesign.ts";
import { runInFlight } from "./retry.ts";
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
  return {
    kind: "act",
    actions: [
      { kind: "convert-to-draft", pullRequest: pullRequest.number },
      requestChangesRun(pullRequest.ticket, pullRequest.number, event.review, config),
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
 * The Request-changes run an agent PR is still owed, or null: one the Operator
 * asked for that stalled before it pushed. Its PR went back to draft, the pass
 * it had is still the latest Verdict, and the Operator's review requesting
 * changes is on the head that passed. It resumes on whatever head the PR is at
 * now, the Operator's pushes included.
 */
export function owedRequestChangesRun(
  pullRequest: PullRequestSnapshot,
  operator: string,
  config: KitConfig,
): Extract<Action, { kind: "start-agent-run" }> | null {
  if (whyNotReviewable(pullRequest) !== null || pullRequest.ticket === null) return null;
  const run = runInFlight(pullRequest, operator);
  if (run?.kind !== "request-changes") return null;
  return requestChangesRun(pullRequest.ticket, pullRequest.number, run.review, config);
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
