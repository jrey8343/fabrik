// A Kept-branch start (#536): a Ticket marked fabrik:kept-branch, with no open
// PR, carries on its Kept branch, the agent branch of the PR the Kit closed
// unmerged, instead of starting from main. The mark is the Operator's lever,
// set by a Design session or by hand, and every Back to design takes it off.
import { agentBranchFor } from "./agentPullRequest.ts";
import { KEPT_BRANCH_LABEL, READY_FOR_AGENT, READY_FOR_HUMAN } from "./labels.ts";
import type { Action, KeptBranch } from "./types.ts";

/** Whether the Ticket is marked for a Kept-branch start and its Kept branch is gone, so no run can carry on it. */
export function keptBranchGone(labels: readonly string[], keptBranch: KeptBranch | null | undefined): boolean {
  return labels.includes(KEPT_BRANCH_LABEL) && keptBranch === null;
}

/**
 * Stops a Ticket marked for a Kept-branch start whose Kept branch is gone: its
 * brief was written for that branch, so a run from main would build the wrong
 * thing. It goes to the Operator, as stopTicketOf does a Ticket whose PR they
 * closed by hand (src/loop/handClosing.ts); declining the trigger alone would
 * leave it ready-for-agent, for Dispatch to start again every hour.
 */
export function stopForGoneKeptBranch(ticket: number, operator: string): Action[] {
  const branch = agentBranchFor(ticket);
  return [
    {
      kind: "comment",
      issue: ticket,
      body: `This Ticket is marked \`${KEPT_BRANCH_LABEL}\`, but its Kept branch \`${branch}\` is gone, so the Kit started no Implement run on it. Take \`${KEPT_BRANCH_LABEL}\` off and mark it \`${READY_FOR_AGENT}\` again to start it from \`main\`, or push \`${branch}\` back first to carry on from it.`,
    },
    { kind: "remove-label", issue: ticket, label: READY_FOR_AGENT },
    { kind: "add-labels", issue: ticket, labels: [READY_FOR_HUMAN] },
    // The assignment is ready-for-human's one notification; the comment mentions nobody.
    { kind: "assign", issue: ticket, assignee: operator },
  ];
}
