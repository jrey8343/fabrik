// A Ticket whose closing PR merged (#543): its work has landed, so no Implement
// run starts on it again. GitHub sometimes leaves it open after the merge, and
// only the scheduled tick closes it then: right after a merge GitHub may not
// have closed it yet, and the Kit would comment on almost every merge.
import type { Action, Plan, Snapshot, TicketSnapshot } from "./types.ts";

/** Why a Ticket with these merged closing PRs takes no Implement run: `#N's PR #M has merged`. */
export function mergedReason(ticket: number, merged: readonly number[]): string {
  return `#${ticket}'s ${prs(merged)} ${merged.length === 1 ? "has" : "have"} merged`;
}

/**
 * The scheduled tick's step that closes, as completed, each open
 * ready-for-agent Ticket a PR of which has merged, lowest number first, with
 * a comment first naming the PR. Any merged PR that closes it counts, an
 * agent PR or a person's.
 */
export function closeMergedTickets(snapshot: Snapshot): Plan {
  if (snapshot.readyTickets === null) {
    return { kind: "fail", failure: "infrastructure", reason: "The snapshot is missing the ready-for-agent Tickets the scheduled tick weighs" };
  }
  const leftOpen = snapshot.readyTickets
    .filter((ticket) => ticket.open && ticket.mergedLinkedPullRequests.length > 0)
    .sort((a, b) => a.number - b.number);
  if (leftOpen.length === 0) return { kind: "nothing", reason: "No open Ticket has a PR that merged" };
  return { kind: "act", actions: leftOpen.flatMap(closing) };
}

function closing(ticket: TicketSnapshot): Action[] {
  return [
    {
      kind: "comment",
      issue: ticket.number,
      body: `${prs(ticket.mergedLinkedPullRequests)} merged, but GitHub left this Ticket open, so the Kit closed it as completed.`,
    },
    { kind: "close", issue: ticket.number, reason: "completed" },
  ];
}

/** `PR #1`, or `PRs #1, #2 and #3`. */
function prs(numbers: readonly number[]): string {
  const names = numbers.map((n) => `#${n}`);
  return names.length < 2 ? `PR ${names.join("")}` : `PRs ${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
