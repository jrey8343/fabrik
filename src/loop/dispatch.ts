// Dispatch (ADR-0001): the Kit, not a person, decides when a Ticket starts.
import { DISPATCH_LABEL } from "./labels.ts";
import type { DispatchSnapshot, KitConfig, Plan, TicketSnapshot } from "./types.ts";

/** Releases eligible Tickets to Implementers, lowest number first, up to the free slots. */
export function dispatch(snapshot: DispatchSnapshot, config: KitConfig): Plan {
  const tickets = [...snapshot.tickets].sort((a, b) => a.number - b.number);
  const ineligible: string[] = [];
  const eligible: number[] = [];
  for (const ticket of tickets) {
    const why = whyNotEligible(ticket);
    if (why === null) eligible.push(ticket.number);
    else ineligible.push(why);
  }
  if (eligible.length === 0) {
    const why = ineligible.length === 0 ? "none is ready-for-agent" : ineligible.join("; ");
    return { kind: "nothing", reason: `No Ticket can be dispatched: ${why}` };
  }

  // A Ticket already given the label is waiting for its Implement run to start,
  // which removes the label, so it holds a slot too.
  const waiting = tickets.filter((ticket) => ticket.open && ticket.labels.includes(DISPATCH_LABEL)).length;
  const inFlight = snapshot.openAgentDraftPullRequests + snapshot.implementRunsInProgress + waiting;
  const free = Math.max(0, config.maxInFlight - inFlight);
  if (free === 0) {
    const counts = [
      count(snapshot.openAgentDraftPullRequests, "open agent draft PR", "open agent draft PRs"),
      count(snapshot.implementRunsInProgress, "Implement run in progress", "Implement runs in progress"),
      `${waiting} dispatched and waiting`,
    ].join(", ");
    return {
      kind: "nothing",
      reason: `max_in_flight is ${config.maxInFlight} and ${inFlight} are in flight (${counts}), so ${list(eligible, "and")} wait`,
    };
  }
  return {
    kind: "act",
    actions: eligible.slice(0, free).map((issue) => ({ kind: "add-labels", issue, labels: [DISPATCH_LABEL] })),
  };
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Why this Ticket can't start an Implementer, or null if it can: it must be one
 * open, ready, buildable Ticket that nothing is already working on.
 */
function whyNotEligible(ticket: TicketSnapshot): string | null {
  const name = `#${ticket.number}`;
  if (!ticket.open) return `${name} is closed`;
  if (!ticket.labels.includes("ready-for-agent")) return `${name} isn't ready-for-agent`;
  if (ticket.openBlockers.length > 0) return `${name} is blocked by ${list(ticket.openBlockers)}`;
  if (ticket.subIssues > 0) return `${name} has sub-issues, so it's a Spec`;
  if (ticket.openLinkedPullRequests.length > 0) {
    return `${name} already has the open PR ${list(ticket.openLinkedPullRequests)}`;
  }
  if (ticket.labels.includes(DISPATCH_LABEL)) return `${name} already has ${DISPATCH_LABEL}`;
  return null;
}

/** `#1, #2`, or with a conjunction `#1, #2 and #3`. */
function list(numbers: readonly number[], conjunction?: string): string {
  const names = numbers.map((n) => `#${n}`);
  if (conjunction === undefined || names.length < 2) return names.join(", ");
  return `${names.slice(0, -1).join(", ")} ${conjunction} ${names.at(-1)}`;
}
