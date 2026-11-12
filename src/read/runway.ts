// The runway (#625): at this pace, how long runs keep going, and how long
// they are then held. One pure function, the Kit's one rule for it, so it can
// change in one place. It takes no clock of its own: the time is passed in.
import { lastMonthStart } from "../kit/replayFacts.ts";
import { type RunRecord, WEEKLY_LIMIT } from "../kit/runRecord.ts";

/** How long runs keep going at this pace, and how long they are then held. */
export type Runway =
  /** Every Subscription is used up: held until the first frees, or null when none is timed. */
  | { readonly kind: "held"; readonly until: string | null }
  /** Runs run out at `at`, then are held until the first reset or freeing, or null when none is known. */
  | { readonly kind: "runs-out"; readonly at: string; readonly heldUntil: string | null }
  /** No limit is reached before a reset. */
  | { readonly kind: "all-week" }
  /** Too few readings to tell. */
  | { readonly kind: "unknown" };

/** A Subscription that is used up now, with when it frees: null when that isn't known. A reader has it from their Standings. */
export interface UsedUpSubscription {
  readonly subscription: string;
  readonly until: string | null;
}

/**
 * How long runs keep going at this pace, and how long they are then held,
 * from the Run records of the store's last two months and the Subscriptions
 * used up at `now`.
 */
export function runwayOf(records: readonly RunRecord[], usedUp: readonly UsedUpSubscription[], now: string): Runway {
  const from = lastMonthStart(now);
  const known = new Set([...records.filter((record) => Date.parse(record.endedAt) >= from).map(({ subscription }) => subscription), ...usedUp.map(({ subscription }) => subscription)]);
  const spent = new Set(usedUp.map(({ subscription }) => subscription));
  if (known.size > 0 && [...known].every((subscription) => spent.has(subscription))) return { kind: "held", until: earliest(usedUp.map(({ until }) => until)) };

  const readings = weeklyReadingsOf(records, from).filter(({ subscription }) => !spent.has(subscription));
  const newest = readings.at(-1);
  if (newest === undefined) return { kind: "unknown" };
  const first = readings.find(({ subscription, resetsAt, at }) => subscription === newest.subscription && resetsAt === newest.resetsAt && at >= newest.at - DAY);
  if (first === undefined || newest.at - first.at < HOUR) return { kind: "unknown" };
  const rise = newest.share - first.share;
  if (rise <= 0) return { kind: "all-week" };

  const presentWeeks = [...known].filter((subscription) => !spent.has(subscription)).map((subscription) => presentWeekOf(readings, subscription, now));
  const room = presentWeeks.reduce((sum, week) => sum + (week === null ? 1 : Math.max(0, 1 - week.share)), 0);
  const at = newest.at + Math.round((room / rise) * (newest.at - first.at));
  const resets = presentWeeks.flatMap((week) => (week === null ? [] : [week.resetsAt]));
  if (resets.some((reset) => reset < at)) return { kind: "all-week" };
  return { kind: "runs-out", at: new Date(at).toISOString(), heldUntil: earliest([...usedUp.map(({ until }) => until), ...resets.map((reset) => new Date(reset).toISOString())]) };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A weekly-limit reading with a share and a reset, as times in ms. */
interface WeeklyReading {
  readonly subscription: string;
  readonly share: number;
  /** When the run that read it ended. */
  readonly at: number;
  /** When its week resets: two readings on one Subscription with the same reset are of the same week. */
  readonly resetsAt: number;
}

/** Every weekly-limit reading with a share and a reset among the records that ended from `from`, oldest first. */
function weeklyReadingsOf(records: readonly RunRecord[], from: number): WeeklyReading[] {
  return records
    .flatMap(({ subscription, endedAt, rateLimit }): WeeklyReading[] => {
      const at = Date.parse(endedAt);
      if (rateLimit?.rateLimitType !== WEEKLY_LIMIT || rateLimit.utilization === null || rateLimit.resetsAt === null || !(at >= from)) return [];
      return [{ subscription, share: rateLimit.utilization, at, resetsAt: rateLimit.resetsAt * 1000 }];
    })
    .toSorted((a, b) => a.at - b.at);
}

/** The newest reading of a Subscription's present week: null when it has none, or its week has reset since. */
function presentWeekOf(readings: readonly WeeklyReading[], subscription: string, now: string): WeeklyReading | null {
  const newest = readings.findLast((reading) => reading.subscription === subscription);
  return newest === undefined || newest.resetsAt <= Date.parse(now) ? null : newest;
}

/** The earliest of these times, as given; null when none is a time. */
function earliest(times: readonly (string | null)[]): string | null {
  let first: string | null = null;
  for (const time of times) if (time !== null && (first === null || Date.parse(time) < Date.parse(first))) first = time;
  return first;
}
