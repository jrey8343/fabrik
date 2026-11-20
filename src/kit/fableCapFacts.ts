// What the Kit job reads of the fabrik-runs store for the Fable cap (ADR-0034),
// in a Product repo that opted in to Fable: the Fable cap readings in the
// store's newest Run records, read the way the Replay reads each
// Subscription's weekly-limit reading (src/kit/replayFacts.ts). A run due on a
// role naming Fable then starts on a Subscription with Fable left, or on Opus,
// with no refusal first (src/loop/fableCap.ts). Pure, no I/O.
import { type FableCapReading, UNTIMED_CAP_MS } from "../loop/fableCap.ts";
import { lastMonthStart, subscriptionReadingsOf } from "./replayFacts.ts";
import type { RunRecord } from "./runRecord.ts";

/**
 * The newest Fable cap reading on each Subscription among these Run records,
 * of every Product repo, a Replay arm's included, from the store's last two
 * months, by Subscription name: a run's `fable-cap` Infrastructure failure,
 * until the reset its refusal gave. A reading with no reset counts until its
 * Subscription's weekly-limit reset, from the store's newest weekly-limit
 * reading on it, or, with none known after the run ended, for UNTIMED_CAP_MS
 * from then. Whether a reading is still in force is the reader's to tell (inForce).
 */
export function storeFableCaps(records: readonly RunRecord[], now: string): FableCapReading[] {
  const from = lastMonthStart(now);
  const newest: Record<string, RunRecord> = {};
  for (const record of records) {
    const at = Date.parse(record.endedAt);
    const seen = newest[record.subscription];
    if (record.infrastructureFailure !== "fable-cap" || at < from) continue;
    if (seen === undefined || at > Date.parse(seen.endedAt)) newest[record.subscription] = record;
  }
  const weekly = new Map(subscriptionReadingsOf(records, now).map(({ subscription, resetsAt }) => [subscription, resetsAt]));
  return Object.values(newest)
    .map(({ subscription, endedAt, refusal }) => {
      const reset = refusal?.resetsAt ?? null;
      const week = weekly.get(subscription) ?? null;
      const until =
        reset !== null
          ? new Date(reset * 1000).toISOString()
          : week !== null && Date.parse(week) > Date.parse(endedAt)
            ? week
            : new Date(Date.parse(endedAt) + UNTIMED_CAP_MS).toISOString();
      return { subscription, until };
    })
    .toSorted((a, b) => (a.subscription < b.subscription ? -1 : a.subscription > b.subscription ? 1 : 0));
}

/**
 * What the Kit job checks out of the store, at `now`, as git's non-cone
 * sparse-checkout patterns: every Product repo's Run records from the store's
 * last two months, which storeFableCaps reads, since a Subscription's Fable
 * cap is reached by whichever repo runs on it. A record sits under the month
 * it ended, by UTC (runStoreName in src/kit/runRecord.ts).
 */
export function fableStorePaths(now: string): string[] {
  const month = (at: number) => new Date(at).toISOString().slice(0, 7);
  return [`/runs/*/*/${month(Date.parse(now))}/`, `/runs/*/*/${month(lastMonthStart(now))}/`];
}
