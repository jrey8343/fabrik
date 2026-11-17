// Yield (#735): of the Implement runs of one kind, first runs, Retry 1s or
// Retry 2s, whose push got its first Verdict in a week, the share where that
// Verdict was a pass. A run is paired with its first Verdict through the pull
// request and head its Run record says it pushed. Pure, no I/O.
import { isLive, type RunRecord } from "./runRecord.ts";
import { type MetricFacts, verdictsOn, type Window, within } from "./retroEvidence.ts";

/** The kinds of Implement run a Yield is worked out for, in the order the Weekly summary shows them. */
export const YIELD_KINDS = ["first", "retry1", "retry2"] as const;

export type YieldKind = (typeof YIELD_KINDS)[number];

/** Of the runs of one kind judged in a week, how many passed. */
export interface YieldShare {
  readonly passed: number;
  readonly judged: number;
}

export type Yields = Readonly<Record<YieldKind, YieldShare>>;

/** The Run-record schema that added `pushed`. */
const PUSHED_SCHEMA = 10;

/** A run that counts toward its kind's Yield: whether it passed, and when it counts, the week it falls in. */
interface JudgedRun {
  readonly kind: YieldKind;
  readonly passed: boolean;
  /** ISO 8601: when its first Verdict was posted, or when an empty diff's or Broken run's record ended. */
  readonly at: string;
}

/**
 * Each kind's Yield in the window: every live Implement record, whatever week
 * it ended in, counted in the week its first Verdict was posted.
 */
export function yieldsOf(window: Window, records: readonly RunRecord[], facts: readonly MetricFacts[]): Yields {
  const judged = records.flatMap((record) => {
    const run = judgedRunOf(record, facts);
    return run === null || !within(window, run.at) ? [] : [run];
  });
  const shareOf = (kind: YieldKind): YieldShare => {
    const runs = judged.filter((run) => run.kind === kind);
    return { passed: runs.filter((run) => run.passed).length, judged: runs.length };
  };
  return { first: shareOf("first"), retry1: shareOf("retry1"), retry2: shareOf("retry2") };
}

/**
 * The kind of a live Implement run a Yield counts, or null for one it never
 * does: a first run is Retry 0 with no PR it was planned against, a Kept-branch
 * start, a Stepped-up start and the first run after a Back to design included;
 * a Retry 1 or Retry 2 goes by its Retry number. A Request-changes run, a
 * conflict-only run (Retry 0, planned against its PR), a Touch-up (#754), a
 * Replay arm and a record of an Infrastructure failure are none. The first run
 * whose Verdict called for a Touch-up still counts, as not passing: that
 * Verdict is an Execution flaw.
 */
function yieldKindOf(record: RunRecord): YieldKind | null {
  if (record.role !== "implement" || !isLive(record) || record.infrastructureFailure !== null || record.requestChanges || record.touchUp > 0) return null;
  if (record.retry === 0) return record.pullRequest === null ? "first" : null;
  if (record.retry === 1) return "retry1";
  if (record.retry === 2) return "retry2";
  return null;
}

/**
 * How a run counts toward its kind's Yield, or null when it's left out. An
 * empty diff or a Broken run landed nothing, so it fails, in the week its record
 * ended. Any other run counts by the first Verdict, from the Reviewer or a red
 * Required check, on the head it pushed: a pass passes, though a later Request
 * changes find a Review miss in it, and a flaw fails. A run that pushed
 * nothing, whose head never got a Verdict, or whose first Verdict was counted
 * back as a Flaky check is left out. So is every run whose record was stored
 * before pushes were recorded (schema 1 to 9): its passing runs name no push,
 * so counting only its failures would read as a Yield of none.
 */
function judgedRunOf(record: RunRecord, facts: readonly MetricFacts[]): JudgedRun | null {
  const kind = yieldKindOf(record);
  if (kind === null || (record.storedSchema !== undefined && record.storedSchema < PUSHED_SCHEMA)) return null;
  if (record.emptyDiff || record.brokenRun !== null) return { kind, passed: false, at: record.endedAt };
  const { pushed } = record;
  if (pushed === null) return null;
  const repo = facts.find((each) => each.repo === record.repo);
  const pullRequest = [...(repo?.pullRequests ?? []), ...(repo?.openPullRequests ?? [])].find(({ number }) => number === pushed.pullRequest);
  if (pullRequest === undefined) return null;
  // In the order the PR's comments came, since a red check's Execution flaw exists only as its marker.
  const first = verdictsOn(pullRequest.comments).find(
    ({ record: verdict }) => (verdict.source === "reviewer" || verdict.source === "ci") && verdict.headSha === pushed.headSha,
  );
  if (first === undefined || first.record.flaky === true) return null;
  return { kind, passed: first.record.verdict === "pass", at: first.at };
}
