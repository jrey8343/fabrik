// The Fable cap readings in the fabrik-runs store's Run records (ADR-0034),
// read the way the Replay reads each Subscription's weekly-limit reading
// (src/kit/replayFacts.ts), and what the Kit job checks out of the store for
// them in a Product repo that opted in to Fable. The Kit job's snapshot weighs
// them, so a run due on a role naming Fable starts on a Subscription with
// Fable left, or on Opus, with no refusal first (src/loop/fableCap.ts); the
// Weekly summary shows each Subscription's Fable reset from them
// (src/kit/weeklySummary.ts). Pure, no I/O.
import { type FableCapReading, UNTIMED_CAP_MS } from "../loop/fableCap.ts";
import { lastMonthStart } from "./replayFacts.ts";
import { type RunRecord, WEEKLY_LIMIT } from "./runRecord.ts";

/**
 * Every Fable cap reading these Run records give, in force or not, in their
 * order: one for each run refused on its Subscription's Fable cap, of any
 * Product repo, a Replay arm's included, since the cap is the Subscription's
 * whatever run reached it, or only those `counted` keeps; any record's
 * weekly-limit reading gives a reset. Whether one is still in force is the
 * reader's to tell (inForce).
 */
export function fableCapReadingsOf(records: readonly RunRecord[], counted: (record: RunRecord) => boolean = () => true): FableCapReading[] {
  return records
    .filter((record) => record.infrastructureFailure === "fable-cap" && counted(record))
    .map((record) => ({ subscription: record.subscription, until: fableCapUntil(record, records) }));
}

/**
 * Until when a run refused on its Fable cap holds that cap, ISO 8601: its
 * refusal's reset; else the reset of its Subscription's newest weekly-limit
 * reading by then, among `records`, when that is still ahead of the refusal;
 * else UNTIMED_CAP_MS from when it ended.
 */
function fableCapUntil(refused: RunRecord, records: readonly RunRecord[]): string {
  const at = Date.parse(refused.endedAt);
  const resetsAt = refused.refusal?.resetsAt ?? null;
  if (resetsAt !== null) return new Date(resetsAt * 1000).toISOString();
  const weekly = records
    .filter((record) => record.subscription === refused.subscription && Date.parse(record.endedAt) <= at && record.rateLimit?.rateLimitType === WEEKLY_LIMIT)
    .toSorted((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt))
    .at(-1)?.rateLimit?.resetsAt;
  if (weekly !== undefined && weekly !== null && weekly * 1000 > at) return new Date(weekly * 1000).toISOString();
  return new Date(at + UNTIMED_CAP_MS).toISOString();
}

/**
 * What the Kit job checks out of the store, at `now`, as git's non-cone
 * sparse-checkout patterns: every Product repo's Run records from the store's
 * last two months, which fableCapReadingsOf reads, since a Subscription's
 * Fable cap is reached by whichever repo runs on it, and no cap outlasts a
 * week. A record sits under the month it ended, by UTC (runStoreName in
 * src/kit/runRecord.ts).
 */
export function fableStorePaths(now: string): string[] {
  const month = (at: number) => new Date(at).toISOString().slice(0, 7);
  return [`/runs/*/*/${month(Date.parse(now))}/`, `/runs/*/*/${month(lastMonthStart(now))}/`];
}
