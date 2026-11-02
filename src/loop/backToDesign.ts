// Back to design: a Ticket that can't be built as designed goes back to the
// Operator. A Design flaw, or a third Execution flaw, closes the agent PR
// unmerged (its branch stays) and moves the Ticket from ready-for-agent to
// needs-design, which starts a Design session. The Kit's note on the Ticket
// links the closed PR and its Verdict, so that session's round 1 can too.
import { agentBranchFor } from "./agentPullRequest.ts";
import { NEEDS_DESIGN, READY_FOR_AGENT } from "./labels.ts";
import type { Action, PostedComment, PullRequestSnapshot } from "./types.ts";

/** Why the PR goes back: the Reviewer said so, or its retries ran out. */
export type BackToDesignReason = "design-flaw" | "retries-used-up";

/** The agent PR a Ticket was sent back to design from, as the Kit's note on the Ticket records it. */
export interface SentBack {
  readonly pullRequest: number;
  /** The URL of the Verdict comment that sent it back, or null when the Operator did, from the Merge gate. */
  readonly verdictUrl: string | null;
}

const MARKER = /^<!-- fabrik:back-to-design ([1-9][0-9]*) (https:\/\/\S+|operator) -->/;

/** The Kit's note that a Ticket came back from this PR, read from a comment's first line; null if it isn't one. */
export function sentBackIn(body: string): SentBack | null {
  const match = MARKER.exec(body);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { pullRequest: Number(match[1]), verdictUrl: match[2] === "operator" ? null : match[2] };
}

/**
 * The Operator added needs-design to an agent PR: the Design-flaw route,
 * without a Verdict. The PR closes unmerged, keeping its branch, and its
 * Ticket goes back to design. None of it notifies anyone: the Design
 * session's round 1 does.
 */
export function sentBackByOperator(pullRequest: PullRequestSnapshot): Action[] {
  const close: Action = { kind: "close-pull-request", pullRequest: pullRequest.number };
  const ticket = pullRequest.ticket;
  if (ticket === null) return [close];
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
    // Starts the Design session; it goes on last, so that session sees the rest.
    { kind: "add-labels", issue: ticket, labels: [NEEDS_DESIGN] },
  ];
}

/** The line the Verdict comment ends with when its PR goes back to design. */
export function backToDesignLine(pullRequest: PullRequestSnapshot, reason: BackToDesignReason): string {
  const ticket = pullRequest.ticket;
  const why =
    reason === "design-flaw" ? "" : "This is the PR's third Execution flaw, which counts as a Design flaw. ";
  const branch = ticket === null ? "" : `, keeping its branch \`${agentBranchFor(ticket)}\``;
  const back = ticket === null ? "" : `, and #${ticket} goes back to design`;
  return `${why}This PR closes unmerged${branch}${back}.`;
}

/**
 * Closes the PR and sends its Ticket back to design, after the Verdict comment
 * posted as `verdict`. None of it notifies anyone: the Design session's round
 * 1 @-mentions the Operator, the event's one notification.
 */
export function backToDesignActions(
  pullRequest: PullRequestSnapshot,
  reason: BackToDesignReason,
  verdict: PostedComment,
): Action[] {
  const close: Action = { kind: "close-pull-request", pullRequest: pullRequest.number };
  const ticket = pullRequest.ticket;
  if (ticket === null) return [close];
  const what =
    reason === "design-flaw"
      ? `The Reviewer gave #${pullRequest.number} a Design flaw`
      : `#${pullRequest.number} had its third Execution flaw, which counts as a Design flaw`;
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
    // Starts the Design session; it goes on last, so that session sees the rest.
    { kind: "add-labels", issue: ticket, labels: [NEEDS_DESIGN] },
  ];
}
