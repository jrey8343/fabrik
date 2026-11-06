// What the audit gate (#150) and the retro gate (#151) share. On the hourly
// scheduled tick, each opens at most one pending issue a week, an Audit or a
// Retro, whose opening starts its run. Each is due from 00:00 UTC on its day
// of the ISO week, which runs from Monday 00:00 to Monday 00:00 in UTC.
import { AUDIT_DAYS, type AuditDay } from "../kit/config.ts";
import { scheduledTick } from "./kitIssues.ts";
import { WEEKLY_LIMIT_LABEL } from "./labels.ts";
import { readable } from "./readable.ts";
import { resumingHeldRuns } from "./resume.ts";
import type { Action, AuditIssueSnapshot, KitConfig, KitIssueSnapshot, Plan, Snapshot } from "./types.ts";

export const DAY = 24 * 60 * 60 * 1000;

/** How many failed runs a week a gate retries before waiting for the next week. */
const FAILED_RUNS_A_WEEK = 2;

/** A gate the scheduled tick runs: what it opens this tick, or why it opens nothing. */
export type TickGate = (now: string, snapshot: Snapshot, config: KitConfig) => Plan;

/**
 * The scheduled tick with these gates: closes each weekly-limit issue after
 * its reset, as scheduledTick does, and resumes held runs then, alongside
 * each gate's plan.
 */
export function scheduledTickWith(gates: readonly TickGate[], now: string, snapshot: Snapshot, config: KitConfig): Plan {
  // With rotation on, a weekly-limit issue it closes resumes the held runs.
  const tick = resumingHeldRuns(scheduledTick(now, snapshot, config), snapshot, config);
  // A weekly-limit issue this tick closes after its reset no longer holds a gate back.
  const closing = actionsOf(tick).flatMap((action) => (action.kind === "close" ? [action.issue] : []));
  const kitIssues = snapshot.kitIssues.filter((issue) => !closing.includes(issue.number));
  return gates.reduce((plan, gate) => alongside(plan, gate(now, { ...snapshot, kitIssues }, config)), tick);
}

/** Both plans' actions, or why neither acts. */
function alongside(first: Plan, second: Plan): Plan {
  if (first.kind === "fail") return first;
  if (second.kind === "fail") return second;
  if (first.kind === "nothing" && second.kind === "nothing") {
    return { kind: "nothing", reason: `${first.reason}; ${second.reason}` };
  }
  return { kind: "act", actions: [...actionsOf(first), ...actionsOf(second)] };
}

function actionsOf(plan: Plan): readonly Action[] {
  return plan.kind === "act" ? plan.actions : [];
}

/**
 * The ones among a gate's issues, `fabrik:audit` or `fabrik:retro`, that
 * the Fabrik App opened, newest first: only those are read for markers.
 */
export function byAppNewestFirst<Issue extends AuditIssueSnapshot>(issues: readonly Issue[]): Issue[] {
  return issues
    .filter((issue) => issue.byApp)
    .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.number - a.number);
}

/** One of a gate's issues, an Audit or a Retro the Fabrik App opened, as the gate weighs it. */
export interface WeeklyIssue {
  readonly number: number;
  readonly open: boolean;
  /** When the tick opened it, as an ISO 8601 time. */
  readonly createdAt: string;
  /** Whether its run failed, which leaves it closed. */
  readonly failed: boolean;
}

/**
 * Why a gate due from `day` opens nothing on the tick at `now`, or null when
 * nothing here holds it back. It waits for the day's 00:00 UTC, and then
 * opens nothing once one of its issues this week didn't fail, while one is
 * open (pending, filled, or not yet closed by the Operator), while a
 * weekly-limit issue is open if `weeklyLimitHoldsBack`, or after two failed
 * this week. `issues` are the gate's own, newest first, and `name` is what it
 * opens, such as "Audit".
 */
export function heldBack(
  name: string,
  day: AuditDay,
  issues: readonly WeeklyIssue[],
  now: string,
  kitIssues: readonly KitIssueSnapshot[],
  weeklyLimitHoldsBack: boolean,
): string | null {
  const week = weekStart(now);
  const due = week + AUDIT_DAYS.indexOf(day) * DAY;
  if (Date.parse(now) < due) return `The ${name} is due from ${readable(due)}`;

  const thisWeek = issues.filter(({ createdAt }) => Date.parse(createdAt) >= week && Date.parse(createdAt) < week + 7 * DAY);
  const done = thisWeek.find((issue) => !issue.failed);
  if (done !== undefined) return `#${done.number} is this week's ${name}`;
  const open = issues.find((issue) => issue.open);
  if (open !== undefined) return `${name} #${open.number} is still open`;
  const limit = weeklyLimitHoldsBack ? kitIssues.find((issue) => issue.labels.includes(WEEKLY_LIMIT_LABEL)) : undefined;
  if (limit !== undefined) return `The weekly usage limit is reached, as #${limit.number} says`;
  const failed = thisWeek.filter((issue) => issue.failed).reverse();
  if (failed.length >= FAILED_RUNS_A_WEEK) {
    const which = failed.map((issue) => `#${issue.number}`).join(" and ");
    return `${which} failed this week, so the next ${name} waits for next week`;
  }
  return null;
}

/** Monday 00:00 UTC of the ISO week `now` falls in, in milliseconds. */
export function weekStart(now: string): number {
  const at = new Date(now);
  const sinceMonday = (at.getUTCDay() + 6) % 7;
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - sinceMonday * DAY;
}

/** Such as "2026-11-02". */
export function dateOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}
