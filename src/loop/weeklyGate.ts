// What the audit gate (#150) and the retro gate (#151) share. On the hourly
// scheduled tick, each opens at most one pending issue a week, an Audit or a
// Retro, whose opening starts its run. Each is due from 00:00 UTC on its day
// of the ISO week, which runs from Monday 00:00 to Monday 00:00 in UTC.
import { WEEK_DAYS, type WeekDay } from "../kit/config.ts";
import { carrierOf } from "./hold.ts";
import { weeklyRunName, weeklyRunWaitingMarker, weeklyRunWaitingNoted, type WeeklyRunKind } from "./markers.ts";
import { readable } from "./readable.ts";
import { freeSubscriptions } from "./subscriptions.ts";
import type { KitConfig, Plan, Snapshot, WeeklyIssueSnapshot } from "./types.ts";

export const DAY = 24 * 60 * 60 * 1000;

/** How many failed runs a week a gate retries before waiting for the next week. */
export const FAILED_RUNS_A_WEEK = 2;

/**
 * The ones among a gate's issues, `fabrik:audit` or `fabrik:retro`, that
 * the Fabrik App opened, newest first: only those are read for markers.
 */
export function byAppNewestFirst<Issue extends WeeklyIssueSnapshot>(issues: readonly Issue[]): Issue[] {
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
 * open (pending, filled, or not yet closed by the Operator), or after two
 * failed this week. Whether a Subscription is free is weighed last, after
 * each gate's own reasons (waitingForSubscription). `issues` are the gate's
 * own, newest first, and `name` is what it opens, such as "Audit".
 */
export function heldBack(name: string, day: WeekDay, issues: readonly WeeklyIssue[], now: string): string | null {
  const week = weekStart(now);
  const due = week + WEEK_DAYS.indexOf(day) * DAY;
  if (Date.parse(now) < due) return `The ${name} is due from ${readable(due)}`;

  const thisWeek = openedInWeek(issues, week);
  const done = thisWeek.find((issue) => !issue.failed);
  if (done !== undefined) return `#${done.number} is this week's ${name}`;
  const open = issues.find((issue) => issue.open);
  if (open !== undefined) return `${name} #${open.number} is still open`;
  const failed = failedInWeek(issues, week);
  if (failed.length >= FAILED_RUNS_A_WEEK) {
    const which = failed.map((issue) => `#${issue.number}`).join(" and ");
    return `${which} failed this week, so the next ${name} waits for next week`;
  }
  return null;
}

/**
 * Why a gate that nothing else holds back opens nothing on the tick at `now`:
 * no listed Subscription is free, through any mix of weekly-limit,
 * usage-credits and token-rotation issues, rotation on or off (#442). Null
 * while one is free, and the run its opening starts is given it as any run
 * is. Each gate weighs this last, so it is named only when it alone keeps the
 * week's Audit or Retro from opening. The first tick that finds it so notes
 * the wait on the Carrier, with one quiet line and the week's waiting marker,
 * which the Weekly summary reads; the week's later ticks note nothing more,
 * though the Carrier that holds the note has since closed (weekCarriers).
 */
export function waitingForSubscription(
  kind: WeeklyRunKind,
  now: string,
  { kitIssues, weekCarriers }: Pick<Snapshot, "kitIssues" | "weekCarriers">,
  config: Pick<KitConfig, "subscriptions">,
): Plan | null {
  if (freeSubscriptions(kitIssues, config).length > 0) return null;
  const name = weeklyRunName(kind);
  const reason = `No Subscription is free, so the ${name} waits for one`;
  const monday = dateOf(weekStart(now));
  const noted = [...kitIssues, ...(weekCarriers ?? [])].some((issue) => weeklyRunWaitingNoted([issue.body, ...issue.comments], kind, monday));
  const carrier = carrierOf(kitIssues);
  if (noted || carrier === null) return { kind: "nothing", reason };
  const body = [`This week's ${name} waits for a free Subscription.`, "", weeklyRunWaitingMarker(kind, monday)].join("\n");
  return { kind: "act", actions: [{ kind: "comment", issue: carrier.number, body }], notes: [reason] };
}

/**
 * Those of a gate's issues, an Audit's or a Retro's, opened in the week from
 * `week`, Monday 00:00 UTC in milliseconds, whose runs failed, oldest first:
 * FAILED_RUNS_A_WEEK of them hold the gate back until the next week.
 */
export function failedInWeek<Issue extends Pick<WeeklyIssue, "createdAt" | "failed" | "number">>(issues: readonly Issue[], week: number): Issue[] {
  return openedInWeek(issues, week)
    .filter((issue) => issue.failed)
    .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number);
}

function openedInWeek<Issue extends Pick<WeeklyIssue, "createdAt">>(issues: readonly Issue[], week: number): Issue[] {
  return issues.filter(({ createdAt }) => Date.parse(createdAt) >= week && Date.parse(createdAt) < week + 7 * DAY);
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
