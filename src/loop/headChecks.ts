// A head's check runs, as the tick reads them (src/github/snapshot.ts): which
// conclusions are red, and which of a check's runs is its latest. The Flaky
// check sweep, the gate re-run and the Operator's mention read them the same
// way. Pure.
import type { HeadCheckRun } from "./types.ts";

/** The conclusions of a check run that failed. */
const RED_CONCLUSIONS = ["failure", "timed_out", "cancelled", "action_required", "startup_failure"];

/** Whether a check run ended red. */
export function isRed(run: HeadCheckRun | undefined): run is HeadCheckRun {
  return run !== undefined && run.conclusion !== null && RED_CONCLUSIONS.includes(run.conclusion);
}

/** A check's runs on a head, oldest first, by when each started: a run not yet started is the newest, as GitHub queued it after every run that has. */
export function runsOf(checkRuns: readonly HeadCheckRun[], name: string): HeadCheckRun[] {
  const started = (run: HeadCheckRun) => (run.startedAt === null ? Infinity : Date.parse(run.startedAt));
  return checkRuns.filter((run) => run.name === name).toSorted((a, b) => started(a) - started(b));
}

/** A check's latest run on a head, or undefined when it has none. */
export function latestRun(checkRuns: readonly HeadCheckRun[], name: string): HeadCheckRun | undefined {
  return runsOf(checkRuns, name).at(-1);
}
