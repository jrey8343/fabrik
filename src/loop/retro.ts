// The Retros in a Product repo (#151), read from the `fabrik:retro` issues the
// Fabrik App opened through their marker lines (src/loop/markers.ts). The
// tick opens each one pending; the Retro's run fills it in or fails it.
import { RETRO_LABEL } from "./labels.ts";
import { retroMarksIn } from "./markers.ts";
import type { IssueSnapshot, RetroIssueSnapshot } from "./types.ts";
import { byAppNewestFirst, DAY } from "./weeklyGate.ts";

/** A Retro as the Kit reads it from its issue. */
export interface Retro {
  readonly number: number;
  readonly open: boolean;
  /** When the tick opened it, as an ISO 8601 time. */
  readonly createdAt: string;
  /** The end of the window it reads, the time of the tick that opened it, from its retro marker; null when its body has none. */
  readonly windowEnd: string | null;
  /** Whether it's still waiting on its run. */
  readonly pending: boolean;
  /** Whether its run failed, which leaves it closed and never the last Retro. */
  readonly failed: boolean;
}

/** How many days a repo's first Retro reads back from its window end: a Kit constant, not Kit config. */
export const FIRST_RETRO_WINDOW_DAYS = 7;

/**
 * The Retros among these `fabrik:retro` issues, newest first. Only an issue
 * the Fabrik App opened is one: a person's issue with the label or a quoted
 * marker counts for nothing.
 */
export function retrosIn(issues: readonly RetroIssueSnapshot[]): Retro[] {
  return byAppNewestFirst(issues).map(({ number, open, createdAt, body }) => ({ number, open, createdAt, ...retroMarksIn(body) }));
}

/**
 * The last Retro: the newest one the Fabrik App opened whose run didn't fail,
 * whatever its state, or null before the first.
 */
export function lastRetro(issues: readonly RetroIssueSnapshot[]): Retro | null {
  return retrosIn(issues).find((retro) => !retro.failed) ?? null;
}

/**
 * Where the window of a Retro opened at `now` starts, as an ISO 8601 time:
 * the last Retro's window end, so nothing falls between two Retros, or
 * FIRST_RETRO_WINDOW_DAYS before `now` on a first run.
 */
export function retroWindowStart(now: string, issues: readonly RetroIssueSnapshot[]): string {
  const last = lastRetro(issues);
  if (last !== null) return retroWindowEnd(last);
  return new Date(Date.parse(now) - FIRST_RETRO_WINDOW_DAYS * DAY).toISOString();
}

/**
 * Where a Retro's window ends, as an ISO 8601 time: its retro marker's time,
 * or when it was opened if its body has lost the marker. The evidence for a
 * pending Retro reads up to it, and the next Retro's window starts there.
 */
export function retroWindowEnd({ windowEnd, createdAt }: Pick<Retro, "windowEnd" | "createdAt">): string {
  return new Date(windowEnd ?? createdAt).toISOString();
}

/**
 * Whether this issue is the Fabrik App's open Retro still waiting on its run:
 * the only issue a Retro run starts for, or fails. A person's issue with the
 * label or a quoted marker never is.
 */
export function isPendingRetro(issue: IssueSnapshot): boolean {
  return issue.open && issue.byApp && issue.labels.includes(RETRO_LABEL) && retroMarksIn(issue.body).pending;
}
