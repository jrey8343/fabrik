// The runway (#625): at this pace, how long runs keep going, and how long
// they are then held. One pure function, the Kit's one rule for it, so it can
// change in one place. It takes no clock of its own: the time is passed in.
import { lastMonthStart } from "../kit/replayFacts.ts";
import type { RunRecord } from "../kit/runRecord.ts";

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
  return { kind: "unknown" };
}

/** The earliest of these times, as given; null when none is a time. */
function earliest(times: readonly (string | null)[]): string | null {
  let first: string | null = null;
  for (const time of times) if (time !== null && (first === null || Date.parse(time) < Date.parse(first))) first = time;
  return first;
}
