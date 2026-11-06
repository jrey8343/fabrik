// A held run: with rotation on, an agent run the Kit doesn't start, or start
// again, while every listed Subscription is used up. What names it is a held
// marker on a Kit-owned weekly-limit issue: the issue or PR it's on, its role
// and the trigger label that resumes it. No new issue kind, label or shared
// state. Pure, no I/O.
import { DESIGN_LABEL, DISPATCH_LABEL, type Label, NEEDS_TRIAGE, REVIEW_LABEL } from "./labels.ts";
import type { Action, AgentRole } from "./types.ts";

/** A run the Kit holds. */
export interface HeldRun {
  readonly role: AgentRole;
  /** The issue or PR its trigger label lives on, or the pending Audit for an Auditor run. */
  readonly issue: number;
  /** The trigger label that resumes it, or null for an Auditor run, which has none. */
  readonly label: Label | null;
}

/** Where a weekly-limit issue's body or comment names a held run, as JSON. */
export const HELD_MARKER = "<!-- fabrik:held";

/** The held marker for a run, such as `<!-- fabrik:held {"issue":7,"role":"triage","label":"needs-triage"} -->`. */
export function heldMarker({ issue, role, label }: HeldRun): string {
  return `${HELD_MARKER} ${JSON.stringify({ issue, role, label })} -->`;
}

/**
 * The label whose adding starts each role's run again: its trigger label, and
 * agent:design for a Design-session turn, whichever round it was
 * (src/loop/design.ts). An Auditor run has none: its pending Audit is all it needs.
 */
export const RESUME_LABELS: Readonly<Record<AgentRole, Label | null>> = {
  triage: NEEDS_TRIAGE,
  design: DESIGN_LABEL,
  implement: DISPATCH_LABEL,
  review: REVIEW_LABEL,
  audit: null,
};

/** How the Kit names each role's run, as in "The Triage run on #7". */
export const RUN_NAMES: Readonly<Record<AgentRole, string>> = {
  triage: "Triage",
  design: "Design-session turn",
  implement: "Implement",
  review: "Review",
  audit: "Auditor",
};

/**
 * The run a start-agent-run action would have started, held. A Review's run
 * is on its PR, where agent:review lives; an Implement run's, a Retry's
 * included, on its Ticket, where agent:implement resumes it.
 */
export function heldRunOf(start: Extract<Action, { kind: "start-agent-run" }>): HeldRun {
  return { role: start.role, issue: start.issue, label: RESUME_LABELS[start.role] };
}

/**
 * The Plan's actions that hold a run: its trigger label off, so that adding it
 * back is a fresh label event, and the hold itself, which changes nothing on GitHub.
 */
export function holding(held: HeldRun, until: string | null): Action[] {
  return [
    ...(held.label === null ? [] : [{ kind: "remove-label" as const, issue: held.issue, label: held.label }]),
    { kind: "hold-agent-run", role: held.role, issue: held.issue, label: held.label, until },
  ];
}
