// A held run: with rotation on, an agent run the Kit doesn't start, or start
// again, while every listed Subscription is used up. What names it is a held
// marker on a Kit-owned weekly-limit issue: the issue or PR it's on, its role,
// the trigger label that resumes it and its place in the order held runs
// resume in. No new issue kind, label or shared state. Pure, no I/O.
import { DESIGN_LABEL, DISPATCH_LABEL, type Label, NEEDS_TRIAGE, REVIEW_LABEL, WEEKLY_LIMIT_LABEL } from "./labels.ts";
import type { Action, AgentRole, KitIssueSnapshot } from "./types.ts";

/** A run the Kit holds. */
export interface HeldRun {
  readonly role: AgentRole;
  /** The issue or PR its trigger label lives on, or the pending Audit for an Auditor run. */
  readonly issue: number;
  /** The trigger label that resumes it, or null for an Auditor run, which has none. */
  readonly label: Label | null;
  /**
   * Its place in the order held runs resume in, from the first time it was
   * held: a run held again keeps it (heldInOrder). Null for a marker left
   * before held runs were numbered, which resumes after every numbered one,
   * in the order its markers come.
   */
  readonly order?: number | null;
}

/** Where a weekly-limit issue's body or comment names a held run, as JSON. */
export const HELD_MARKER = "<!-- fabrik:held";

/** The held marker for a run, such as `<!-- fabrik:held {"issue":7,"role":"triage","label":"needs-triage"} -->`. */
export function heldMarker({ issue, role, label, order = null }: HeldRun): string {
  return `${HELD_MARKER} ${JSON.stringify(order === null ? { issue, role, label } : { issue, role, label, order })} -->`;
}

/**
 * The label whose adding starts each role's run again: its trigger label, and
 * agent:design for a Design-session turn, whichever round it was
 * (src/loop/design.ts). An Auditor run has none: its pending Audit is all it needs.
 */
export const RESUME_LABELS = {
  triage: NEEDS_TRIAGE,
  design: DESIGN_LABEL,
  implement: DISPATCH_LABEL,
  review: REVIEW_LABEL,
  audit: null,
} as const satisfies Readonly<Record<AgentRole, Label | null>>;

/** How the Kit names each role's run, as in "The Triage run on #7", in its comments and step summaries alike. */
export const RUN_NAMES: Readonly<Record<AgentRole, string>> = {
  triage: "Triage",
  design: "Design-session turn",
  implement: "Implement",
  review: "Review",
  audit: "Audit",
};

/**
 * The run a start-agent-run action would have started, held. A Review's run
 * is on its PR, where agent:review lives; an Implement run's, a Retry's
 * included, on its Ticket, where agent:implement resumes it.
 */
export function heldRunOf(start: Extract<Action, { kind: "start-agent-run" }>): HeldRun {
  return { role: start.role, issue: start.issue, label: RESUME_LABELS[start.role] };
}

/** The held runs a weekly-limit issue's body or comment names, in the order its held markers come. */
export function heldRunsIn(text: string): HeldRun[] {
  return markersIn(text, HELD_MARKER).flatMap((value): HeldRun[] => {
    const role = roleOf(value["role"]);
    const { issue } = value;
    return role === null || typeof issue !== "number"
      ? []
      : [{ role, issue, label: RESUME_LABELS[role], order: orderOf(value["order"]) }];
  });
}

/**
 * Where a weekly-limit issue's comment says the scheduled tick resumed, or
 * dropped, a held run: how many of that issue's held markers for it the tick
 * has dealt with, so that only a later held marker holds it again (src/loop/resume.ts).
 */
export const RESUMED_MARKER = "<!-- fabrik:resumed";

/**
 * A held run the tick resumed or dropped, how many of its issue's held
 * markers for it that covers, and its place in the order, which a resumed
 * marker carries so that a run held again keeps it once the issue its first
 * held marker was on has closed.
 */
export interface ResumedRun {
  readonly role: AgentRole;
  readonly issue: number;
  readonly held: number;
  readonly order?: number | null;
}

/** The resumed marker for a run, such as `<!-- fabrik:resumed {"issue":7,"role":"triage","held":1,"order":3} -->`. */
export function resumedMarker({ issue, role, held, order = null }: ResumedRun): string {
  return `${RESUMED_MARKER} ${JSON.stringify(order === null ? { issue, role, held } : { issue, role, held, order })} -->`;
}

/** The resumed runs a weekly-limit issue's body or comment names. */
export function resumedRunsIn(text: string): ResumedRun[] {
  return markersIn(text, RESUMED_MARKER).flatMap((value): ResumedRun[] => {
    const role = roleOf(value["role"]);
    const { issue, held } = value;
    return role === null || typeof issue !== "number" || typeof held !== "number"
      ? []
      : [{ role, issue, held, order: orderOf(value["order"]) }];
  });
}

function roleOf(value: unknown): AgentRole | null {
  return typeof value === "string" && Object.hasOwn(RESUME_LABELS, value) ? (value as AgentRole) : null;
}

function orderOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** A held run still waiting, and how many held markers for it each open weekly-limit issue carries. */
export interface Waiting {
  readonly run: HeldRun;
  readonly markers: ReadonlyMap<number, number>;
}

/**
 * The held runs still waiting on the open weekly-limit issues, in the order
 * they resume: by their place, the first time each was held, and a run left
 * unnumbered after every numbered one. An issue's held markers for a run past
 * the count its last resumed marker covers still hold it. Issues are read
 * oldest first, each body before its comments.
 */
export function waitingHeldRuns(kitIssues: readonly KitIssueSnapshot[]): Waiting[] {
  const limits = kitIssues.filter((issue) => issue.labels.includes(WEEKLY_LIMIT_LABEL));
  const first = new Map<string, HeldRun>();
  const counts = new Map<string, Map<number, { held: number; resumed: number }>>();
  const orders = ordersOn(kitIssues);
  for (const issue of limits) {
    for (const text of [issue.body, ...issue.comments]) {
      for (const run of heldRunsIn(text)) {
        const key = keyOf(run);
        if (!first.has(key)) first.set(key, { ...run, order: orders.get(key) ?? null });
        countOn(counts, key, issue.number).held += 1;
      }
      for (const run of resumedRunsIn(text)) {
        const count = countOn(counts, keyOf(run), issue.number);
        count.resumed = Math.max(count.resumed, run.held);
      }
    }
  }
  const waiting = [...first].flatMap(([key, run]): Waiting[] => {
    const onIssues = [...(counts.get(key) ?? new Map<number, { held: number; resumed: number }>())];
    if (!onIssues.some(([, count]) => count.held > count.resumed)) return [];
    return [{ run, markers: new Map(onIssues.map(([number, count]) => [number, count.held])) }];
  });
  // A stable sort, so runs with no place keep the order their markers come in.
  return waiting.sort((a, b) => (a.run.order ?? Number.POSITIVE_INFINITY) - (b.run.order ?? Number.POSITIVE_INFINITY));
}

/**
 * The issues and PRs a held run of this role still waits on: it holds the
 * slot it had under Dispatch's max_in_flight cap or the Design session cap,
 * so that resuming it never runs more than the caps allow.
 */
export function heldOf(role: AgentRole, kitIssues: readonly KitIssueSnapshot[]): number[] {
  return waitingHeldRuns(kitIssues).flatMap(({ run }) => (run.role === role ? [run.issue] : []));
}

/**
 * Each run's place, from the held and resumed markers on the open
 * weekly-limit issues: the earliest any of them gives it.
 */
function ordersOn(kitIssues: readonly KitIssueSnapshot[]): Map<string, number> {
  const orders = new Map<string, number>();
  for (const issue of kitIssues) {
    if (!issue.labels.includes(WEEKLY_LIMIT_LABEL)) continue;
    for (const text of [issue.body, ...issue.comments]) {
      for (const run of [...heldRunsIn(text), ...resumedRunsIn(text)]) {
        if (run.order === null || run.order === undefined) continue;
        const key = keyOf(run);
        orders.set(key, Math.min(orders.get(key) ?? run.order, run.order));
      }
    }
  }
  return orders;
}

/**
 * These runs, about to be held, each given its place: the one an open
 * weekly-limit issue's held or resumed marker already gives it, if it was held
 * before, else the next after every place given so far, in the order given.
 */
export function heldInOrder(runs: readonly HeldRun[], kitIssues: readonly KitIssueSnapshot[]): HeldRun[] {
  const orders = ordersOn(kitIssues);
  let next = Math.max(0, ...orders.values()) + 1;
  return runs.map((run) => {
    const key = keyOf(run);
    const known = orders.get(key);
    if (known !== undefined) return { ...run, order: known };
    orders.set(key, next);
    return { ...run, order: next++ };
  });
}

function keyOf({ role, issue }: Pick<HeldRun, "role" | "issue">): string {
  return `${role}:${issue}`;
}

function countOn(
  counts: Map<string, Map<number, { held: number; resumed: number }>>,
  key: string,
  issue: number,
): { held: number; resumed: number } {
  const byIssue = counts.get(key) ?? new Map<number, { held: number; resumed: number }>();
  counts.set(key, byIssue);
  const count = byIssue.get(issue) ?? { held: 0, resumed: 0 };
  byIssue.set(issue, count);
  return count;
}

/** The JSON object each `<marker> {…} -->` line in the text holds, in order, skipping any that doesn't parse. */
function markersIn(text: string, marker: string): Record<string, unknown>[] {
  return text.split("\n").flatMap((line) => {
    const start = line.indexOf(marker);
    const end = start === -1 ? -1 : line.indexOf("-->", start);
    if (end === -1) return [];
    try {
      const value: unknown = JSON.parse(line.slice(start + marker.length, end));
      return typeof value === "object" && value !== null ? [value as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
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
