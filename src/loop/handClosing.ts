// Closing by hand (#428): a Ticket closed, by hand or otherwise, closes its
// agent draft PR too, so it frees its max_in_flight slot and gets no more
// Reviews; and an agent PR closed by hand stops its Ticket rather than
// silently starting it again.
import { agentBranchFor } from "./agentPullRequest.ts";
import { READY_FOR_AGENT, READY_FOR_HUMAN } from "./labels.ts";
import type { Action, IssueSnapshot, LoopEvent, PullRequestSnapshot } from "./types.ts";

type PullRequestClosed = Extract<LoopEvent, { kind: "pull-request-closed" }>;

/**
 * Closes each open agent draft PR of a Ticket that has closed, unmerged and
 * keeping its branch, with a comment on the PR saying why. A merge closes
 * the Ticket only once its PR has merged, so this finds none then.
 */
export function closeAgentDraftsOf(ticket: IssueSnapshot): Action[] {
  if (ticket.open) return [];
  return ticket.openAgentDrafts.flatMap((pullRequest): Action[] => [
    {
      kind: "comment",
      issue: pullRequest,
      body: `#${ticket.number} was closed, so the Kit closed this PR unmerged, keeping its branch \`${agentBranchFor(ticket.number)}\`.`,
    },
    { kind: "close-pull-request", pullRequest },
  ]);
}

/**
 * An agent PR the Operator closed unmerged by hand stops its Ticket rather
 * than starting it again: the Ticket swaps ready-for-agent for
 * ready-for-human, whose assignment is the one notification, with a comment
 * saying how to run it again. The Kit's own closes, a merge, a closed Ticket,
 * and a Ticket no longer ready-for-agent, already stopped another way, leave
 * it as it is.
 */
export function stopTicketOf(
  { merged, closedByBot }: PullRequestClosed,
  pullRequest: PullRequestSnapshot,
  operator: string,
): Action[] {
  const ticket = pullRequest.ticket;
  if (merged || closedByBot || ticket === null || !pullRequest.ticketOpen) return [];
  if (!pullRequest.ticketLabels.includes(READY_FOR_AGENT)) return [];
  return [
    {
      kind: "comment",
      issue: ticket,
      body: `#${pullRequest.number} was closed unmerged by hand, so the Kit won't start another Implement run on this Ticket by itself, and its branch \`${agentBranchFor(ticket)}\` stays. To have an Implementer try again, mark it \`${READY_FOR_AGENT}\`: the new run starts from \`main\` and replaces that branch.`,
    },
    { kind: "remove-label", issue: ticket, label: READY_FOR_AGENT },
    { kind: "add-labels", issue: ticket, labels: [READY_FOR_HUMAN] },
    { kind: "assign", issue: ticket, assignee: operator },
  ];
}
