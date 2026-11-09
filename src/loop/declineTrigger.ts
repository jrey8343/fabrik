// A trigger label a role declines: it comes off, so adding it again fires a
// fresh labeled event, and one comment says why nothing started, so the
// Operator doesn't watch the label vanish with no word (#417). A trigger
// label put on the wrong object, such as agent:review on a Ticket, comes off
// the same way, with one line saying where it goes (#479).
import { DISPATCH_LABEL, type Label, NEEDS_TRIAGE, REVIEW_LABEL } from "./labels.ts";
import type { Action, PullRequestSnapshot } from "./types.ts";

/** Takes `label` off `issue` and says in one line why nothing started. `why` reads as a clause, with no full stop. */
export function declineTrigger(issue: number, label: Label, why: string): Action[] {
  return [
    { kind: "remove-label", issue, label },
    { kind: "comment", issue, body: `${label} came off and nothing started: ${why}.` },
  ];
}

/** agent:review added to an issue: it goes on the Ticket's PR, which the Loop reads it on. */
export function reviewLabelOnIssue(issue: number, openPullRequests: readonly number[]): Action[] {
  const [pullRequest] = openPullRequests;
  const where =
    pullRequest === undefined
      ? `goes on an agent PR, not an issue, and #${issue} has no open PR`
      : `goes on the PR, not the Ticket: add it to #${pullRequest}`;
  return misplaced(issue, REVIEW_LABEL, where);
}

/** agent:implement or needs-triage added to a PR, or null for any other label: each goes on an issue. */
export function issueLabelOnPullRequest(label: string, { number, ticket }: Pick<PullRequestSnapshot, "number" | "ticket">): Action[] | null {
  if (label === DISPATCH_LABEL) {
    const where = ticket === null ? `goes on a Ticket, not a PR, and #${number} isn't on one` : `goes on the Ticket, not the PR: add it to #${ticket}`;
    return misplaced(number, DISPATCH_LABEL, where);
  }
  if (label === NEEDS_TRIAGE) return misplaced(number, NEEDS_TRIAGE, "goes on an issue, not a PR: add it to the issue you want triaged");
  return null;
}

/** Takes `label` off `on`, where the Loop never acts on it, and says in one line where it goes. */
function misplaced(on: number, label: Label, where: string): Action[] {
  return [
    { kind: "remove-label", issue: on, label },
    { kind: "comment", issue: on, body: `\`${label}\` ${where}.` },
  ];
}
