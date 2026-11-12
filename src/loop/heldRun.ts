// A held run: with rotation on, an agent run the Kit doesn't start, or start
// again, while every listed Subscription is used up. What names it is a held
// marker on a carrier, a Kit-owned weekly-limit, usage-credits or
// token-rotation issue (#470): the issue or PR it's on, its role, the trigger
// label that resumes it and its place in the order held runs resume in. No
// new issue kind, label or shared state. Pure, no I/O.
import {
  DESIGN_LABEL,
  DIGEST_LABEL,
  DISPATCH_LABEL,
  type Label,
  NEEDS_TRIAGE,
  RESEARCH_LABEL,
  REVIEW_LABEL,
} from "./labels.ts";
import { makesUnusable } from "./subscriptions.ts";
import type { Action, AgentRole, KitIssueSnapshot } from "./types.ts";

/** A run the Kit holds. */
export interface HeldRun {
  readonly role: AgentRole;
  /** The issue or PR its trigger label lives on, or the pending Audit for a held marker an Auditor run left before #268. */
  readonly issue: number;
  /** The trigger label that resumes it, or null for a held marker an Auditor run left before #268. */
  readonly label: Label | null;
  /**
   * Its place in the order held runs resume in, from the first time it was
   * held: a run held again keeps it (heldInOrder). Null for a marker left
   * before held runs were numbered, which resumes after every numbered one,
   * in the order its markers come.
   */
  readonly order?: number | null;
  /**
   * Where its held line is (src/loop/heldLine.ts, #471), when that isn't
   * `issue`: an Implement run on an agent PR, as a Retry, says it's held on the
   * PR, while its trigger label lives on the Ticket.
   */
  readonly lineOn?: number;
}

/** A run the Kit holds now: only one with a trigger label, since an Auditor or Retro run is never held. */
export type HoldableRun = HeldRun & { readonly label: Label };

/** Where a carrier's body or comment names a held run, as JSON. */
export const HELD_MARKER = "<!-- fabrik:held";

/** The held marker for a run, such as `<!-- fabrik:held {"issue":7,"role":"triage","label":"needs-triage"} -->`. */
export function heldMarker({ issue, role, label, order = null, lineOn }: HeldRun): string {
  const line = lineOn === undefined || lineOn === issue ? {} : { line: lineOn };
  return `${HELD_MARKER} ${JSON.stringify(order === null ? { issue, role, label, ...line } : { issue, role, label, order, ...line })} -->`;
}

/** The issue or PR a held run's held line is on. */
export function heldLineIssue({ issue, lineOn }: HeldRun): number {
  return lineOn ?? issue;
}

/**
 * The label whose adding starts each role's run again: its trigger label, and
 * agent:design for a Design-session turn, whichever round it was
 * (src/loop/design.ts). An Auditor run and a Retro run have none, and neither
 * is held: its Audit or Retro fails instead (src/loop/failures.ts). Only a held
 * marker an Auditor run left before that (#268) is still read, and its Audit
 * fails at the reset (src/loop/resume.ts). A Digest run's is agent:digest,
 * on its PR, as a Review's is agent:review.
 */
export const RESUME_LABELS = {
  triage: NEEDS_TRIAGE,
  design: DESIGN_LABEL,
  implement: DISPATCH_LABEL,
  review: REVIEW_LABEL,
  audit: null,
  retro: null,
  research: RESEARCH_LABEL,
  digest: DIGEST_LABEL,
} as const satisfies Readonly<Record<AgentRole, Label | null>>;

/** How the Kit names each role's run, as in "The Triage run on #7", in its comments and step summaries alike (runNamed). */
export const RUN_NAMES: Readonly<Record<AgentRole, string>> = {
  triage: "Triage",
  design: "Design-session turn",
  implement: "Implement",
  review: "Review",
  audit: "Audit",
  retro: "Retro",
  research: "Research",
  digest: "Digest",
};

/** A role's run named in full, as in "The Triage run on #7": a Design session's is "Design-session turn", never "turn run" (#436). */
export function runNamed(role: AgentRole): string {
  return role === "design" ? RUN_NAMES.design : `${RUN_NAMES[role]} run`;
}

/**
 * The run a start-agent-run action would have started, held. A Review's run
 * is on its PR, where agent:review lives; an Implement run's, a Retry's
 * included, on its Ticket, where agent:implement resumes it, though one on an
 * agent PR has its held line there. An Auditor or
 * Retro run never gets here: its pending issue fails before it's planned
 * (src/loop/weeklyRuns.ts).
 */
export function heldRunOf(start: Extract<Action, { kind: "start-agent-run" }>): HoldableRun {
  const label = RESUME_LABELS[start.role];
  if (label === null) throw new Error(`The ${runNamed(start.role)} on #${start.issue} has no trigger label, so it can't be held`);
  return { role: start.role, issue: start.issue, label, ...(start.pullRequest === undefined ? {} : { lineOn: start.pullRequest }) };
}

/**
 * A carrier: an open Kit-owned issue that makes a Subscription unusable, a
 * weekly-limit, usage-credits or token-rotation issue, which held markers go on (#470).
 */
export function isCarrier(issue: KitIssueSnapshot): boolean {
  return makesUnusable(issue.labels);
}

/** Whether a carrier names any held run, in its body or a comment. */
export function carriesHeldMarkers(issue: KitIssueSnapshot): boolean {
  return [issue.body, ...issue.comments].some((text) => heldRunsIn(text).length > 0);
}

/** The held runs a carrier's body or comment names, in the order its held markers come. */
export function heldRunsIn(text: string): HeldRun[] {
  return markersIn(text, HELD_MARKER).flatMap((value): HeldRun[] => {
    const role = roleOf(value["role"]);
    const { issue } = value;
    return role === null || typeof issue !== "number"
      ? []
      : [{ role, issue, label: RESUME_LABELS[role], order: orderOf(value["order"]), ...lineOf(value["line"]) }];
  });
}

/**
 * Where a carrier's comment says the Kit resumed, or
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

/** The resumed runs a carrier's body or comment names. */
export function resumedRunsIn(text: string): ResumedRun[] {
  return markersIn(text, RESUMED_MARKER).flatMap((value): ResumedRun[] => {
    const role = roleOf(value["role"]);
    const { issue, held } = value;
    return role === null || typeof issue !== "number" || typeof held !== "number"
      ? []
      : [{ role, issue, held, order: orderOf(value["order"]) }];
  });
}

/** The role a marker's JSON names, or null for anything that isn't one. */
export function roleOf(value: unknown): AgentRole | null {
  return typeof value === "string" && Object.hasOwn(RESUME_LABELS, value) ? (value as AgentRole) : null;
}

function lineOf(value: unknown): { lineOn?: number } {
  return typeof value === "number" && Number.isInteger(value) ? { lineOn: value } : {};
}

function orderOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** A held run still waiting, and how many held markers for it each open carrier carries. */
export interface Waiting {
  readonly run: HeldRun;
  readonly markers: ReadonlyMap<number, number>;
  /** When its newest held marker was posted, or null when any of its markers' times wasn't read. */
  readonly heldAt: string | null;
  /** Its newest held marker: the weekly-limit issue it's on, and where it put the run's held line (#471). */
  readonly newest: { readonly on: number; readonly lineOn: number };
}

/**
 * The held runs still waiting on the open carriers, in the order
 * they resume: by their place, the first time each was held, and a run left
 * unnumbered after every numbered one. An issue's held markers for a run past
 * the count its last resumed marker covers still hold it. Issues are read
 * oldest first, each body before its comments.
 */
export function waitingHeldRuns(kitIssues: readonly KitIssueSnapshot[]): Waiting[] {
  const limits = kitIssues.filter(isCarrier);
  const first = new Map<string, HeldRun>();
  const counts = new Map<string, Map<number, { held: number; resumed: number }>>();
  const heldAt = new Map<string, string | null>();
  const newest = new Map<string, { on: number; lineOn: number }>();
  const orders = ordersOn(kitIssues);
  for (const issue of limits) {
    const times = [issue.createdAt, ...issue.comments.map((_, at) => issue.commentedAt?.[at])];
    for (const [at, text] of [issue.body, ...issue.comments].entries()) {
      for (const run of heldRunsIn(text)) {
        const key = keyOf(run);
        if (!first.has(key)) first.set(key, { ...run, order: orders.get(key) ?? null });
        countOn(counts, key, issue.number).held += 1;
        newest.set(key, { on: issue.number, lineOn: heldLineIssue(run) });
        heldAt.set(key, newer(heldAt.has(key) ? (heldAt.get(key) ?? null) : undefined, times[at] ?? null));
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
    return [
      {
        run,
        markers: new Map(onIssues.map(([number, count]) => [number, count.held])),
        heldAt: heldAt.get(key) ?? null,
        // Every run waiting has a held marker, so its newest is always known.
        newest: newest.get(key) ?? { on: onIssues[0]?.[0] ?? run.issue, lineOn: run.issue },
      },
    ];
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
 * carriers: the earliest any of them gives it.
 */
function ordersOn(kitIssues: readonly KitIssueSnapshot[]): Map<string, number> {
  const orders = new Map<string, number>();
  for (const issue of kitIssues) {
    if (!isCarrier(issue)) continue;
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
 * carrier's held or resumed marker already gives it, if it was held
 * before, else the next after every place given so far, in the order given.
 */
export function heldInOrder<Run extends HeldRun>(runs: readonly Run[], kitIssues: readonly KitIssueSnapshot[]): Run[] {
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

/** The later of two times, null once either is unknown; undefined for no time seen yet. */
function newer(seen: string | null | undefined, time: string | null): string | null {
  if (seen === undefined) return time;
  if (seen === null || time === null) return null;
  return Date.parse(time) > Date.parse(seen) ? time : seen;
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
export function holding(held: HoldableRun, until: string | null): Action[] {
  return [
    { kind: "remove-label", issue: held.issue, label: held.label },
    { kind: "hold-agent-run", role: held.role, issue: held.issue, label: held.label, until },
  ];
}
