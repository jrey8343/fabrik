// How the Kit tells its own PRs apart: the Implementer's push job opens each
// one, as the Fabrik App, from the Ticket's agent branch.

const AGENT_BRANCH_PREFIX = "fabrik/ticket-";

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
