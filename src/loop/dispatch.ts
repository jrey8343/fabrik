// Dispatch (ADR-0001): the Kit, not a person, decides when a Ticket starts.
import { DISPATCH_LABEL, READY_FOR_AGENT } from "./labels.ts";
import type { DispatchSnapshot, KitConfig, Plan, TicketSnapshot } from "./types.ts";

/**
 * Releases eligible Tickets to Implementers, lowest number first, up to the free slots.
 * A max_in_flight of 0 pauses it; resuming an agent PR's run doesn't go through here.
 * `held` names the Tickets whose Implement run is held (src/loop/heldRun.ts):
 * dispatched already, each keeps its slot until the scheduled tick resumes it.
 */
export function dispatch(snapshot: DispatchSnapshot, config: KitConfig, held: readonly number[] = []): Plan {
  const tickets = [...snapshot.tickets].sort((a, b) => a.number - b.number);
  const ineligible: string[] = [];
  const eligible: number[] = [];
  for (const ticket of tickets) {
    const why = held.includes(ticket.number) && ticket.open ? `#${ticket.number} is held` : whyNotEligible(ticket);
    if (why === null) eligible.push(ticket.number);
    else ineligible.push(why);
  }
  if (eligible.length === 0) {
    const why = ineligible.length === 0 ? "none is ready-for-agent" : ineligible.join("; ");
    return { kind: "nothing", reason: `No Ticket can be dispatched: ${why}` };
  }

  if (config.maxInFlight === 0) {
    return { kind: "nothing", reason: `Dispatch is paused because max_in_flight is 0, so ${list(eligible, "and")} wait` };
  }

  // A Ticket already given the label is waiting for its Implement run to start,
  // which removes the label, so it holds a slot too. One with an open PR is
  // resuming that PR's run, whose draft PR already holds its slot.
  const waiting = tickets.filter(
    (ticket) => ticket.open && ticket.labels.includes(DISPATCH_LABEL) && ticket.openLinkedPullRequests.length === 0,
  ).length;
  // A held Implement run's Ticket has had agent:implement taken off, and has no run in progress.
  // One with an open PR is a held retry, whose draft PR already holds its slot.
  const heldTickets = tickets.filter(
    (ticket) =>
      held.includes(ticket.number) &&
      ticket.open &&
      !ticket.labels.includes(DISPATCH_LABEL) &&
      ticket.openLinkedPullRequests.length === 0,
  ).length;
  const inFlight = snapshot.openAgentDraftPullRequests + snapshot.implementRunsInProgress + waiting + heldTickets;
  const free = Math.max(0, config.maxInFlight - inFlight);
  if (free === 0) {
    const counts = [
      count(snapshot.openAgentDraftPullRequests, "open agent draft PR", "open agent draft PRs"),
      count(snapshot.implementRunsInProgress, "Implement run in progress", "Implement runs in progress"),
      `${waiting} dispatched and waiting`,
      ...(heldTickets === 0 ? [] : [`${heldTickets} held`]),
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
  if (!ticket.labels.includes(READY_FOR_AGENT)) return `${name} isn't ${READY_FOR_AGENT}`;
  if (ticket.openBlockers.length > 0) return `${name} is blocked by ${list(ticket.openBlockers)}`;
  // A blocker closed as not planned never landed its work, so it blocks until the Operator removes the edge.
  if (ticket.notPlannedBlockers.length > 0) {
    return `${name} is blocked by ${list(ticket.notPlannedBlockers)}, closed as not planned`;
  }
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
