// Dispatch (ADR-0001): the Kit, not a person, decides when a Ticket starts,
// and when a research Decision does.
import { keptBranchGone, stopForGoneKeptBranch } from "./keptBranch.ts";
import { DISPATCH_LABEL, type Label, READY_FOR_AGENT, RESEARCH_LABEL } from "./labels.ts";
import { mergedReason } from "./mergedTickets.ts";
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
 * dispatched already, each keeps its slot until it resumes once a Subscription is free.
 */
export function dispatch(snapshot: DispatchSnapshot, config: KitConfig, held: HeldDispatched, operator: string): Plan {
  // A Ticket marked to carry on a Kept branch that's gone is never released: it goes to the Operator (#536).
  const stops = snapshot.tickets
    .filter((ticket) => stopsForGoneKeptBranch(ticket) && !(held.implement.includes(ticket.number) && ticket.open))
    .flatMap((ticket) => stopForGoneKeptBranch(ticket.number, operator));
  const plan = releasing(snapshot, config, held);
  if (stops.length === 0) return plan;
  return { kind: "act", actions: [...stops, ...(plan.kind === "act" ? plan.actions : [])] };
}

/**
 * Whether Dispatch stops this Ticket instead of releasing it (#536): it's
 * marked for a Kept-branch start whose Kept branch is gone, and nothing else
 * holds it back.
 */
function stopsForGoneKeptBranch(ticket: TicketSnapshot): boolean {
  return keptBranchGone(ticket.labels, ticket.keptBranch) && whyNotEligibleBesidesKeptBranch(ticket) === null;
}

/** The Dispatch check's releases, with no stopped Ticket. */
function releasing(snapshot: DispatchSnapshot, config: KitConfig, held: HeldDispatched): Plan {
  const decisions = [...snapshot.researchDecisions].sort((a, b) => a.number - b.number);
  const candidates = candidatesOf(snapshot, held);
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

  const inFlight = inFlightOf(snapshot, held);
  const free = Math.max(0, config.maxInFlight - inFlight.total);
  if (free === 0) {
    const counts = [
      count(snapshot.openAgentDraftPullRequests, "open agent draft PR", "open agent draft PRs"),
      count(snapshot.implementRunsInProgress, "Implement run in progress", "Implement runs in progress"),
      ...(inFlight.researchRuns === 0 ? [] : [count(inFlight.researchRuns, "Research run in progress", "Research runs in progress")]),
      `${inFlight.waiting.length} dispatched and waiting`,
      ...(inFlight.held.length === 0 ? [] : [`${inFlight.held.length} held`]),
    ].join(", ");
    return {
      kind: "nothing",
      reason: `max_in_flight is ${config.maxInFlight} and ${inFlight.total} are in flight (${counts}), so ${list(waitingNumbers, "and")} wait`,
    };
  }
  return {
    kind: "act",
    actions: eligible.slice(0, free).map(({ number, label }) => ({ kind: "add-labels", issue: number, labels: [label] })),
  };
}

/** What holds a slot under max_in_flight, as a Dispatch check counts it, and the issues it can name. */
export interface InFlight {
  readonly openAgentDraftPullRequests: number;
  readonly implementRuns: number;
  readonly researchRuns: number;
  /** The Tickets and research Decisions dispatched and waiting for their run to start, lowest number first. */
  readonly waiting: readonly number[];
  /** The Tickets and research Decisions whose run is held, lowest number first. */
  readonly held: readonly number[];
  /** Every slot taken: what a Dispatch check weighs against max_in_flight. */
  readonly total: number;
}

/**
 * The slots taken under max_in_flight, as a Dispatch check counts them, so
 * the Weekly summary's Held and Dispatch can't disagree (#476): open agent
 * draft PRs, Implement and Research runs in progress, Tickets and Decisions
 * dispatched and waiting for their run, and held runs.
 */
export function inFlightOf(snapshot: DispatchSnapshot, held: HeldDispatched): InFlight {
  const tickets = [...snapshot.tickets].sort((a, b) => a.number - b.number);
  const decisions = [...snapshot.researchDecisions].sort((a, b) => a.number - b.number);
  // A Ticket already given the label is waiting for its Implement run to start,
  // which removes the label, so it holds a slot too. One with an open PR is
  // resuming that PR's run, whose draft PR already holds its slot. So is a
  // research Decision given agent:research on a live Map, its Research run
  // still to start; under a closed Map, none ever will.
  const waiting = [
    ...tickets
      .filter((ticket) => ticket.open && ticket.labels.includes(DISPATCH_LABEL) && ticket.openLinkedPullRequests.length === 0)
      .map(({ number }) => number),
    ...decisions
      .filter((decision) => decision.labels.includes(RESEARCH_LABEL) && whyNotResearchable(decision) === null)
      .map(({ number }) => number),
  ].sort((a, b) => a - b);
  // A held run's Ticket or Decision has had its trigger label taken off, and has no run in progress.
  // A Ticket with an open PR is a held retry, whose draft PR already holds its slot.
  const heldRuns = [
    ...tickets
      .filter(
        (ticket) =>
          held.implement.includes(ticket.number) &&
          ticket.open &&
          !ticket.labels.includes(DISPATCH_LABEL) &&
          ticket.openLinkedPullRequests.length === 0,
      )
      .map(({ number }) => number),
    ...decisions
      .filter((decision) => held.research.includes(decision.number) && decision.open && !decision.labels.includes(RESEARCH_LABEL))
      .map(({ number }) => number),
  ].sort((a, b) => a - b);
  const { openAgentDraftPullRequests, implementRunsInProgress: implementRuns, researchRunsInProgress: researchRuns } = snapshot;
  return {
    openAgentDraftPullRequests,
    implementRuns,
    researchRuns,
    waiting,
    held: heldRuns,
    total: openAgentDraftPullRequests + implementRuns + researchRuns + waiting.length + heldRuns.length,
  };
}

/**
 * The Tickets and research Decisions a Dispatch check would release, slots
 * aside, lowest issue number first: what waits for Dispatch, which the replay
 * step lets go first (src/loop/replayGate.ts).
 */
export function waitingForDispatch(
  snapshot: Pick<DispatchSnapshot, "tickets" | "researchDecisions">,
  held: HeldDispatched,
): number[] {
  return candidatesOf(snapshot, held).flatMap(({ number, why }) => (why === null ? [number] : []));
}

/** Every issue Dispatch weighs, lowest issue number first, with why it can't be released, or null. */
function candidatesOf(snapshot: Pick<DispatchSnapshot, "tickets" | "researchDecisions">, held: HeldDispatched): Candidate[] {
  return [
    ...snapshot.tickets.map((ticket): Candidate => ({
      number: ticket.number,
      label: DISPATCH_LABEL,
      why: held.implement.includes(ticket.number) && ticket.open ? `#${ticket.number} is held` : whyNotEligible(ticket),
    })),
    ...snapshot.researchDecisions.map((decision): Candidate => ({
      number: decision.number,
      label: RESEARCH_LABEL,
      why: held.research.includes(decision.number) && decision.open ? `#${decision.number} is held` : whyNotReleasable(decision),
    })),
  ].sort((a, b) => a.number - b.number);
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Why this Ticket can't start an Implementer, or null if it can: it must be one
 * open, ready, buildable Ticket that nothing is already working on, no PR of
 * which has merged, and whose last Implement run didn't fail.
 */
function whyNotEligible(ticket: TicketSnapshot): string | null {
  const why = whyNotEligibleBesidesKeptBranch(ticket);
  if (why !== null) return why;
  return keptBranchGone(ticket.labels, ticket.keptBranch) ? `#${ticket.number}'s Kept branch is gone` : null;
}

/** whyNotEligible, leaving out a gone Kept branch, which Dispatch weighs last (#536). */
function whyNotEligibleBesidesKeptBranch(ticket: TicketSnapshot): string | null {
  const name = `#${ticket.number}`;
  if (!ticket.open) return `${name} is closed`;
  // Its work landed though GitHub left it open: only the scheduled tick closes it, never a run (#543).
  if (ticket.mergedLinkedPullRequests.length > 0) return mergedReason(ticket.number, ticket.mergedLinkedPullRequests);
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
  // A broken Ticket mustn't burn runs on every check, the hourly tick's included (#418):
  // its failure notice tells the Operator to re-add agent:implement, its only resume.
  if (ticket.lastRunFailed) return `${name}'s last Implement run failed, so only adding ${DISPATCH_LABEL} again runs it`;
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
