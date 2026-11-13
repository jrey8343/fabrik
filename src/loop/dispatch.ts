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
    .filter((ticket) => stopsForGoneKeptBranch(ticket, snapshot.implementRunTickets) && !(held.implement.includes(ticket.number) && ticket.open))
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
function stopsForGoneKeptBranch(ticket: TicketSnapshot, runTickets: readonly number[]): boolean {
  return keptBranchGone(ticket.labels, ticket.keptBranch) && whyNotEligibleBesidesKeptBranch(ticket, runTickets) === null;
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
  const gate = mergeGateLoadOf(snapshot, held, config.caps.mergeGate);
  // Lowest issue number first: a research Decision takes a max_in_flight slot, a Ticket one under each cap.
  let free = Math.max(0, config.maxInFlight - inFlight.total);
  let gateFree = gate.free;
  const released = eligible.filter(({ label }) => {
    const ticket = label === DISPATCH_LABEL;
    if (free === 0 || (ticket && gateFree === 0)) return false;
    free -= 1;
    if (ticket) gateFree -= 1;
    return true;
  });
  if (released.length > 0) {
    return { kind: "act", actions: released.map(({ number, label }) => ({ kind: "add-labels", issue: number, labels: [label] })) };
  }
  const reasons = [
    ...(config.maxInFlight - inFlight.total > 0 ? [] : [maxInFlightReason(config.maxInFlight, inFlight)]),
    ...(gate.free > 0 || !eligible.some(({ label }) => label === DISPATCH_LABEL) ? [] : [mergeGateReason(gate)]),
  ];
  return { kind: "nothing", reason: `${reasons.join("; ")}, so ${list(waitingNumbers, "and")} wait` };
}

/** What a full max_in_flight says: the cap and what fills it. */
function maxInFlightReason(maxInFlight: number, inFlight: InFlight): string {
  const counts = [
    count(inFlight.openAgentDraftPullRequests, "open agent draft PR", "open agent draft PRs"),
    count(inFlight.implementRuns, "Implement run in progress", "Implement runs in progress"),
    ...(inFlight.researchRuns === 0 ? [] : [count(inFlight.researchRuns, "Research run in progress", "Research runs in progress")]),
    `${inFlight.waiting.length} dispatched and waiting`,
    ...(inFlight.held.length === 0 ? [] : [`${inFlight.held.length} held`]),
  ].join(", ");
  return `max_in_flight is ${maxInFlight} and ${inFlight.total} are in flight (${counts})`;
}

/** What a full caps.merge_gate says: the cap, the PRs at the gate, and the Ticket work on its way there. */
function mergeGateReason(gate: MergeGateLoad): string {
  if (gate.cap === 0) return "Dispatch holds Tickets while any agent PR is at or on its way to the Merge gate (caps.merge_gate is 0)";
  const at = gate.atGate.length === 0 ? null : `${list(gate.atGate)} ${gate.atGate.length === 1 ? "is" : "are"} at the Merge gate`;
  const runs = gate.implementRuns === 0 ? null : count(gate.implementRuns, "Implement run in progress", "Implement runs in progress");
  const numbers = [...gate.drafts, ...gate.tickets];
  const named = numbers.length === 0 ? null : list(numbers);
  const onItsWay = named === null || runs === null ? (named ?? runs) : `${named} and ${runs}`;
  const one = numbers.length + gate.implementRuns === 1;
  const way = onItsWay === null ? null : `${onItsWay} ${one ? "is on its way" : "are on their way"}${at === null ? " to the Merge gate" : ""}`;
  return `caps.merge_gate is ${gate.cap} and ${[at, way].filter((part) => part !== null).join(" and ")}`;
}

/**
 * The Gate load under caps.merge_gate, as a Dispatch check counts it
 * (#459, ADR-0023): the agent PRs out of draft, at the gate, and the Ticket
 * work on its way there, so a released Ticket's PR always has room. Research
 * runs and Decisions never reach the gate, so they count for neither.
 */
export interface MergeGateLoad {
  readonly cap: number;
  /** The open agent PRs out of draft, lowest number first. */
  readonly atGate: readonly number[];
  /** The open agent draft PRs, lowest number first: Ticket work on its way to the gate. */
  readonly drafts: readonly number[];
  /** The Tickets dispatched and waiting for their Implement run, or held, lowest number first. */
  readonly tickets: readonly number[];
  /** Implement runs in progress with no open agent PR for their Ticket, which the snapshot counts but doesn't name. */
  readonly implementRuns: number;
  /** Everything at or on its way to the gate. */
  readonly load: number;
  /** How many more Tickets it lets go: a cap of 0 lets one go while nothing is at or on its way to the gate. */
  readonly free: number;
}

export function mergeGateLoadOf(snapshot: DispatchSnapshot, held: HeldDispatched, cap: number): MergeGateLoad {
  const tickets = [...snapshot.tickets].sort((a, b) => a.number - b.number);
  const atGate = [...snapshot.openAgentPullRequestsAtMergeGate].sort((a, b) => a - b);
  const drafts = [...snapshot.openAgentDraftPullRequests].sort((a, b) => a - b);
  const onItsWay = [...waitingTicketsOf(tickets), ...heldTicketsOf(tickets, held)].sort((a, b) => a - b);
  const implementRuns = snapshot.implementRunsWithoutPullRequest;
  const load = atGate.length + drafts.length + onItsWay.length + implementRuns;
  const free = cap === 0 ? (load === 0 ? 1 : 0) : Math.max(0, cap - load);
  return { cap, atGate, drafts, tickets: onItsWay, implementRuns, load, free };
}

/**
 * The open agent PRs split by where they stand: drafts, Ticket work on its way
 * to the Merge gate, and those out of draft, at it, lowest number first in each.
 */
export function agentPullRequestsByGate(
  pullRequests: readonly { readonly number: number; readonly draft: boolean }[],
): Pick<DispatchSnapshot, "openAgentDraftPullRequests" | "openAgentPullRequestsAtMergeGate"> {
  const numbers = (draft: boolean) => pullRequests.flatMap((pullRequest) => (pullRequest.draft === draft ? [pullRequest.number] : [])).sort((a, b) => a - b);
  return { openAgentDraftPullRequests: numbers(true), openAgentPullRequestsAtMergeGate: numbers(false) };
}

/** A Ticket given the label waits for its Implement run to start; one with an open PR resumes that PR's run, whose draft PR holds its slot. */
function waitingTicketsOf(tickets: readonly TicketSnapshot[]): number[] {
  return tickets
    .filter((ticket) => ticket.open && ticket.labels.includes(DISPATCH_LABEL) && ticket.openLinkedPullRequests.length === 0)
    .map(({ number }) => number);
}

/** A held run's Ticket has had its trigger label taken off; one with an open PR is a held retry, whose draft PR holds its slot. */
function heldTicketsOf(tickets: readonly TicketSnapshot[], held: HeldDispatched): number[] {
  return tickets
    .filter(
      (ticket) =>
        held.implement.includes(ticket.number) &&
        ticket.open &&
        !ticket.labels.includes(DISPATCH_LABEL) &&
        ticket.openLinkedPullRequests.length === 0,
    )
    .map(({ number }) => number);
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
    ...waitingTicketsOf(tickets),
    ...decisions
      .filter((decision) => decision.labels.includes(RESEARCH_LABEL) && whyNotResearchable(decision) === null)
      .map(({ number }) => number),
  ].sort((a, b) => a - b);
  // A held run's Ticket or Decision has had its trigger label taken off, and has no run in progress.
  // A Ticket with an open PR is a held retry, whose draft PR already holds its slot.
  const heldRuns = [
    ...heldTicketsOf(tickets, held),
    ...decisions
      .filter((decision) => held.research.includes(decision.number) && decision.open && !decision.labels.includes(RESEARCH_LABEL))
      .map(({ number }) => number),
  ].sort((a, b) => a - b);
  const { implementRunsInProgress: implementRuns, researchRunsInProgress: researchRuns } = snapshot;
  const openAgentDraftPullRequests = snapshot.openAgentDraftPullRequests.length;
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
  snapshot: DispatchCandidates,
  held: HeldDispatched,
): number[] {
  return candidatesOf(snapshot, held).flatMap(({ number, why }) => (why === null ? [number] : []));
}

/** What Dispatch weighs releasing, slots aside: the candidates, and the Tickets an Implement run under way already holds (#578). */
export type DispatchCandidates = Pick<DispatchSnapshot, "tickets" | "researchDecisions" | "implementRunTickets">;

/** Every issue Dispatch weighs, lowest issue number first, with why it can't be released, or null. */
function candidatesOf(snapshot: DispatchCandidates, held: HeldDispatched): Candidate[] {
  return [
    ...snapshot.tickets.map((ticket): Candidate => ({
      number: ticket.number,
      label: DISPATCH_LABEL,
      why: held.implement.includes(ticket.number) && ticket.open ? `#${ticket.number} is held` : whyNotEligible(ticket, snapshot.implementRunTickets),
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
function whyNotEligible(ticket: TicketSnapshot, runTickets: readonly number[]): string | null {
  const why = whyNotEligibleBesidesKeptBranch(ticket, runTickets);
  if (why !== null) return why;
  return keptBranchGone(ticket.labels, ticket.keptBranch) ? `#${ticket.number}'s Kept branch is gone` : null;
}

/** whyNotEligible, leaving out a gone Kept branch, which Dispatch weighs last (#536). */
function whyNotEligibleBesidesKeptBranch(ticket: TicketSnapshot, runTickets: readonly number[]): string | null {
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
  // Between its claim taking the label off and its push job opening the draft PR, only the run holds it (#578).
  if (runTickets.includes(ticket.number)) return `${name} has an Implement run under way`;
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
