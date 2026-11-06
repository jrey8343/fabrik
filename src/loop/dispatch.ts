// Dispatch (ADR-0001): the Kit, not a person, decides when a Ticket starts,
// and when a research Decision does.
import { DISPATCH_LABEL, type Label, READY_FOR_AGENT, RESEARCH_LABEL } from "./labels.ts";
import { whyNotResearchable } from "./research.ts";
import type { DispatchSnapshot, KitConfig, Plan, ResearchDecisionSnapshot, TicketSnapshot } from "./types.ts";

/** The issues whose run is held (src/loop/heldRun.ts), by the role Dispatch released them to. */
export interface HeldDispatched {
  readonly implement: readonly number[];
  readonly research: readonly number[];
}

/** An issue Dispatch weighs, the label that releases it, and why it can't be released, or null. */
interface Candidate {
  readonly number: number;
  readonly label: Label;
  readonly why: string | null;
}

/**
 * Releases eligible Tickets to Implementers and eligible research Decisions
 * to the Researcher, lowest issue number first across both, up to the free
 * slots. A max_in_flight of 0 pauses it; resuming an agent PR's run doesn't
 * go through here. `held` names the Tickets and Decisions whose run is held:
 * dispatched already, each keeps its slot until the scheduled tick resumes it.
 */
export function dispatch(snapshot: DispatchSnapshot, config: KitConfig, held: HeldDispatched): Plan {
  const tickets = [...snapshot.tickets].sort((a, b) => a.number - b.number);
  const decisions = [...snapshot.researchDecisions].sort((a, b) => a.number - b.number);
  const candidates: Candidate[] = [
    ...tickets.map((ticket): Candidate => ({
      number: ticket.number,
      label: DISPATCH_LABEL,
      why: held.implement.includes(ticket.number) && ticket.open ? `#${ticket.number} is held` : whyNotEligible(ticket),
    })),
    ...decisions.map((decision): Candidate => ({
      number: decision.number,
      label: RESEARCH_LABEL,
      why: held.research.includes(decision.number) && decision.open ? `#${decision.number} is held` : whyNotReleasable(decision),
    })),
  ].sort((a, b) => a.number - b.number);
  const ineligible = candidates.flatMap(({ why }) => (why === null ? [] : [why]));
  const eligible = candidates.filter(({ why }) => why === null);
  if (eligible.length === 0) {
    const what = decisions.length === 0 ? "Ticket" : "Ticket or research Decision";
    const why = ineligible.length === 0 ? "none is ready-for-agent" : ineligible.join("; ");
    return { kind: "nothing", reason: `No ${what} can be dispatched: ${why}` };
  }
  const waitingNumbers = eligible.map(({ number }) => number);

  if (config.maxInFlight === 0) {
    return { kind: "nothing", reason: `Dispatch is paused because max_in_flight is 0, so ${list(waitingNumbers, "and")} wait` };
  }

  // A Ticket already given the label is waiting for its Implement run to start,
  // which removes the label, so it holds a slot too. One with an open PR is
  // resuming that PR's run, whose draft PR already holds its slot. So is a
  // research Decision given agent:research on a live Map, its Research run
  // still to start; under a closed Map, none ever will.
  const waiting =
    tickets.filter(
      (ticket) => ticket.open && ticket.labels.includes(DISPATCH_LABEL) && ticket.openLinkedPullRequests.length === 0,
    ).length +
    decisions.filter((decision) => decision.labels.includes(RESEARCH_LABEL) && whyNotResearchable(decision) === null)
      .length;
  const researchRuns = snapshot.researchRunsInProgress;
  // A held run's Ticket or Decision has had its trigger label taken off, and has no run in progress.
  // A Ticket with an open PR is a held retry, whose draft PR already holds its slot.
  const heldRuns =
    tickets.filter(
      (ticket) =>
        held.implement.includes(ticket.number) &&
        ticket.open &&
        !ticket.labels.includes(DISPATCH_LABEL) &&
        ticket.openLinkedPullRequests.length === 0,
    ).length +
    decisions.filter(
      (decision) => held.research.includes(decision.number) && decision.open && !decision.labels.includes(RESEARCH_LABEL),
    ).length;
  const inFlight =
    snapshot.openAgentDraftPullRequests + snapshot.implementRunsInProgress + researchRuns + waiting + heldRuns;
  const free = Math.max(0, config.maxInFlight - inFlight);
  if (free === 0) {
    const counts = [
      count(snapshot.openAgentDraftPullRequests, "open agent draft PR", "open agent draft PRs"),
      count(snapshot.implementRunsInProgress, "Implement run in progress", "Implement runs in progress"),
      ...(researchRuns === 0 ? [] : [count(researchRuns, "Research run in progress", "Research runs in progress")]),
      `${waiting} dispatched and waiting`,
      ...(heldRuns === 0 ? [] : [`${heldRuns} held`]),
    ].join(", ");
    return {
      kind: "nothing",
      reason: `max_in_flight is ${config.maxInFlight} and ${inFlight} are in flight (${counts}), so ${list(waitingNumbers, "and")} wait`,
    };
  }
  return {
    kind: "act",
    actions: eligible.slice(0, free).map(({ number, label }) => ({ kind: "add-labels", issue: number, labels: [label] })),
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

/**
 * Why Dispatch can't release this research Decision to the Researcher, or
 * null if it can: it must be a research Decision on a live Map that nobody has
 * claimed, nothing blocks and nothing is already working on, and whose last
 * run didn't fail.
 */
function whyNotReleasable(decision: ResearchDecisionSnapshot): string | null {
  const notResearchable = whyNotResearchable(decision);
  if (notResearchable !== null) return notResearchable;
  const name = `#${decision.number}`;
  // Assigning themselves claims it for the Operator, as in `/wayfinder`.
  if (decision.assignees.length > 0) return `${name} is assigned to ${decision.assignees.join(", ")}`;
  if (decision.openBlockers.length > 0) return `${name} is blocked by ${list(decision.openBlockers)}`;
  if (decision.labels.includes(RESEARCH_LABEL)) return `${name} already has ${RESEARCH_LABEL}`;
  // A broken Decision mustn't burn runs in a loop: the Operator re-adding the label is its only resume.
  if (decision.lastRunFailed) return `${name}'s last Research run failed, so only adding ${RESEARCH_LABEL} again runs it`;
  return null;
}

/** `#1, #2`, or with a conjunction `#1, #2 and #3`. */
function list(numbers: readonly number[], conjunction?: string): string {
  const names = numbers.map((n) => `#${n}`);
  if (conjunction === undefined || names.length < 2) return names.join(", ");
  return `${names.slice(0, -1).join(", ")} ${conjunction} ${names.at(-1)}`;
}
