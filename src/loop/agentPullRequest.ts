// How the Kit tells its own PRs apart: the Implementer's push job opens each
// one, as the Fabrik App, from the Ticket's agent branch.
import type { PullRequestSnapshot } from "./types.ts";

/** What every agent branch's name starts with. */
export const AGENT_BRANCH_PREFIX = "fabrik/ticket-";

/** The branch an Implementer works on for this Ticket. */
export function agentBranchFor(ticket: number): string {
  return `${AGENT_BRANCH_PREFIX}${ticket}`;
}

/** Whether a PR is an agent PR: opened by a bot (the Fabrik App) from an agent branch. */
export function isAgentPullRequest(pullRequest: { readonly headRef: string; readonly authorIsBot: boolean }): boolean {
  return pullRequest.authorIsBot && pullRequest.headRef.startsWith(AGENT_BRANCH_PREFIX);
}

/** The Ticket an agent branch was cut for, or null if it isn't one. */
export function ticketOfAgentBranch(headRef: string): number | null {
  const match = /^fabrik\/ticket-([1-9][0-9]*)$/.exec(headRef);
  return match === null ? null : Number(match[1]);
}

/**
 * Why this PR isn't an open agent draft PR for a Ticket, the only kind the Loop
 * reviews or retries, or null when it is.
 */
export function whyNotReviewable(pullRequest: PullRequestSnapshot): string | null {
  if (!pullRequest.isAgent) return `#${pullRequest.number} isn't an agent PR`;
  if (pullRequest.ticket === null) return `#${pullRequest.number}'s branch names no Ticket`;
  if (!pullRequest.open) return `#${pullRequest.number} is closed`;
  if (!pullRequest.draft) return `#${pullRequest.number} has left draft`;
  return null;
}
