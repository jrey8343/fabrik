// The Spend read (#624): what the factory has used, read straight from the
// fabrik-runs store with the Kit's own reader of a Run record, and runner
// time summed from the records. Each Subscription's last weekly-limit reading
// is the Replay gate's own rule (subscriptionReadingsOf, src/kit/replayFacts.ts).
import type { RunRecord } from "../kit/runRecord.ts";

/** A week's runner time, in whole minutes, with the records that gave no duration. */
export interface RunnerTime {
  readonly minutes: number;
  /** Records with no duration, which add nothing to `minutes`. */
  readonly uncounted: number;
}

/**
 * The runner time of the Run records that ended in a week: each run's
 * duration rounded up to a whole minute, summed, and the count of records
 * with no duration, which add nothing. It counts the agent's own time, not
 * the jobs around it nor jobs that leave no Run record, so it is under the
 * figure GitHub bills.
 */
export function runnerTimeOf(records: readonly RunRecord[]): RunnerTime {
  let minutes = 0;
  let uncounted = 0;
  for (const { durationMs } of records) {
    if (durationMs === null) uncounted += 1;
    else minutes += Math.ceil(durationMs / 60_000);
  }
  return { minutes, uncounted };
}
