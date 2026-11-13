// Back to design: a Ticket that can't be built as designed goes back to the
// Operator. A Design flaw, or a third Execution flaw, closes the agent PR
// unmerged (its branch stays) and moves the Ticket from ready-for-agent to
// needs-design, which starts a Design session. The Kit's note on the Ticket
// links the closed PR and its Verdict, so that session's round 1 can too.
// While the Ticket is closed no Design session can start, so it declines
// instead: the PR stays open and the Ticket is left as it is (#585).
import { agentBranchFor } from "./agentPullRequest.ts";
import { declineTrigger } from "./declineTrigger.ts";
import { KEPT_BRANCH_LABEL, NEEDS_DESIGN, READY_FOR_AGENT } from "./labels.ts";
import type { Action, PostedComment, PullRequestSnapshot } from "./types.ts";

/** Why the PR goes back: the Reviewer said so, or its retries ran out. */
export type BackToDesignReason = "design-flaw" | "retries-used-up";

/** The agent PR a Ticket was sent back to design from, as the Kit's note on the Ticket records it. */
export interface SentBack {
  readonly pullRequest: number;
  /** The URL of the Verdict comment that sent it back, or null when the Operator did, from the Merge gate. */
  readonly verdictUrl: string | null;
}


/**
 * The Operator added needs-design to an agent PR: the Design-flaw route,
 * without a Verdict. The PR closes unmerged, keeping its branch, and its
 * Ticket goes back to design. None of it notifies anyone: the Design
 * session's round 1 does. While the Ticket is closed it declines, taking
 * needs-design back off the PR and saying why there.
 */
export function sentBackByOperator(pullRequest: PullRequestSnapshot): Action[] {
  const close: Action = { kind: "close-pull-request", pullRequest: pullRequest.number };
  const ticket = pullRequest.ticket;
  if (ticket === null) return [close];
  if (ticketClosed(pullRequest)) {
    const why = `the Ticket #${ticket} is closed, so no Design session can start on it and #${pullRequest.number} stays open; to Send it back, reopen #${ticket} and add \`${NEEDS_DESIGN}\` to #${pullRequest.number} again`;
    return declineTrigger(pullRequest.number, NEEDS_DESIGN, why);
  }
  return [
    close,
    {
      kind: "comment",
      issue: ticket,
      body: [
        `<!-- fabrik:back-to-design ${pullRequest.number} operator -->`,
        `**Back to design.** The Operator added \`${NEEDS_DESIGN}\` to #${pullRequest.number}, so the Kit closed it unmerged, keeping its branch \`${agentBranchFor(ticket)}\`. A Design session on this Ticket starts now.`,
      ].join("\n"),
    },
    { kind: "remove-label", issue: ticket, label: READY_FOR_AGENT },
    keptBranchOff(ticket),
    // Starts the Design session; it goes on last, so that session sees the rest.
    { kind: "add-labels", issue: ticket, labels: [NEEDS_DESIGN] },
  ];
}

/**
 * Takes the Kept-branch start mark off the Ticket (#536), whether or not it's on:
 * every Design session starts with it off, and decides afresh whether the
 * next run carries on the Kept branch, so none inherits a stale mark.
 */
export function keptBranchOff(ticket: number): Action {
  return { kind: "remove-label", issue: ticket, label: KEPT_BRANCH_LABEL };
}

/** The line the Verdict comment ends with when its PR goes back to design, or why it doesn't while the Ticket is closed. */
export function backToDesignLine(pullRequest: PullRequestSnapshot, reason: BackToDesignReason): string {
  const ticket = pullRequest.ticket;
  const why =
    reason === "design-flaw" ? "" : "This is the Ticket's third Execution flaw, which counts as a Design flaw. ";
  if (ticketClosed(pullRequest)) return `${why}The Ticket #${ticket} is closed, so this PR stays open and no Design session starts.`;
  const branch = ticket === null ? "" : `, keeping its branch \`${agentBranchFor(ticket)}\``;
  const back = ticket === null ? "" : `, and #${ticket} goes back to design`;
  return `${why}This PR closes unmerged${branch}${back}.`;
}

/**
 * Closes the PR and sends its Ticket back to design, after the Verdict comment
 * posted as `verdict`. None of it notifies anyone: the Design session's round
 * 1 @-mentions the Operator, the event's one notification. Nothing, while
 * the Ticket is closed: the Verdict's line says why.
 */
export function backToDesignActions(
  pullRequest: PullRequestSnapshot,
  reason: BackToDesignReason,
  verdict: PostedComment,
): Action[] {
  if (ticketClosed(pullRequest)) return [];
  const close: Action = { kind: "close-pull-request", pullRequest: pullRequest.number };
  const ticket = pullRequest.ticket;
  if (ticket === null) return [close];
  const what =
    reason === "design-flaw"
      ? `The Reviewer gave #${pullRequest.number} a Design flaw`
      : `#${pullRequest.number} brought this Ticket's third Execution flaw, which counts as a Design flaw`;
  return [
    close,
    {
      kind: "comment-linking",
      issue: ticket,
      body: [
        `<!-- fabrik:back-to-design ${pullRequest.number} `,
        verdict,
        " -->\n",
        `**Back to design.** ${what} ([the Verdict](`,
        verdict,
        `)), so the Kit closed it unmerged, keeping its branch \`${agentBranchFor(ticket)}\`. A Design session on this Ticket starts now.`,
      ],
    },
    { kind: "remove-label", issue: ticket, label: READY_FOR_AGENT },
    keptBranchOff(ticket),
    // Starts the Design session; it goes on last, so that session sees the rest.
    { kind: "add-labels", issue: ticket, labels: [NEEDS_DESIGN] },
  ];
}

/** Whether GitHub reports the PR's Ticket closed, so no Design session can start on it; an unlinked one is never taken for closed. */
function ticketClosed(pullRequest: PullRequestSnapshot): boolean {
  return pullRequest.ticket !== null && pullRequest.ticketState === "closed";
}
