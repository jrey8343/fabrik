// The Merge gate: only the Operator merges an agent PR. Short of merging, they
// can request changes, which starts one Request-changes run on the Step-up
// model with their review as input (it isn't a retry), or add needs-design to
// the PR, which sends its Ticket back to design as a Design flaw does.
import type { KitConfig, LoopEvent, Plan, PullRequestSnapshot, Snapshot } from "./types.ts";
import { verdictsIn } from "./verdict.ts";

type ChangesRequested = Extract<LoopEvent, { kind: "pull-request-changes-requested" }>;

/**
 * The Operator's Request changes on an agent PR at the Merge gate. The PR goes
 * back to draft, so the run's push starts a Review, and a pass requests the
 * Operator's review again. Conflicts after another PR merged take this path
 * too: the Operator asks for the rebase in their review.
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
  const { implement, stepUp } = config.roles;
  return {
    kind: "act",
    actions: [
      { kind: "convert-to-draft", pullRequest: pullRequest.number },
      {
        kind: "start-agent-run",
        role: "implement",
        issue: pullRequest.ticket,
        pullRequest: pullRequest.number,
        requestChanges: { review: event.review },
        model: stepUp.model,
        effort: stepUp.effort,
        timeoutMinutes: implement.timeoutMinutes,
      },
    ],
  };
}

/** The first line of the Kit's note on a PR that a Request-changes run pushed to it. */
export const REQUEST_CHANGES_RUN_MARKER = "<!-- fabrik:request-changes-run -->";

/**
 * Whether a PR's latest push came from a Request-changes run, from the Fabrik
 * App's comments on it, oldest first: its last note of such a push has no
 * Verdict after it yet, so the next Verdict is marked as from that run.
 */
export function requestChangesRunIn(commentBodies: readonly string[]): boolean {
  let latest = false;
  for (const body of commentBodies) {
    if (body.startsWith(REQUEST_CHANGES_RUN_MARKER)) latest = true;
    else if (verdictsIn([body]).length > 0) latest = false;
  }
  return latest;
}

/** Why this PR isn't an open agent PR waiting at the Merge gate, or null when it is. */
function whyNotAtMergeGate(pullRequest: PullRequestSnapshot): string | null {
  if (!pullRequest.isAgent) return `#${pullRequest.number} isn't an agent PR`;
  if (pullRequest.ticket === null) return `#${pullRequest.number}'s branch names no Ticket`;
  if (!pullRequest.open) return `#${pullRequest.number} is closed`;
  if (pullRequest.draft) return `#${pullRequest.number} is still a draft in the Loop, not at the Merge gate`;
  return null;
}
