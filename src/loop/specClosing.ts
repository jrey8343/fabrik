// Spec closing: when a Spec's last Ticket closes, the Kit closes the Spec,
// linking the PRs that closed its Tickets. It stays out of the Operator's
// pushes: the comment mentions nobody.
import type { Action, IssueSnapshot, SpecSnapshot } from "./types.ts";

/** What closing this issue does to its Spec: close it once every Ticket is closed; otherwise nothing. */
export function closeSpecAfter(issue: IssueSnapshot, spec: SpecSnapshot | null): Action[] {
  if (issue.parent === null || spec === null || spec.number !== issue.parent) return [];
  if (!spec.open || spec.tickets.length === 0 || spec.tickets.some((ticket) => ticket.open)) return [];
  const body = [
    `**Spec done.** Every Ticket under this Spec is closed, so the Kit closes it.`,
    "",
    ...spec.tickets.map(
      ({ number, pullRequests }) =>
        `- #${number}: ${pullRequests.length === 0 ? "closed without a merged PR" : pullRequests.map((pr) => `#${pr}`).join(", ")}`,
    ),
  ].join("\n");
  return [
    { kind: "comment", issue: spec.number, body },
    { kind: "close", issue: spec.number, reason: "completed" },
  ];
}
