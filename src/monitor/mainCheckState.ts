// How one commit's check runs decide a Main check (ADR-0025): the one rule the
// Monitor reads a Main check by (./mainChecks.ts), and the read library's
// Main checks read with it (src/read/mainChecks.ts), so the Standing at
// Staging (ADR-0038) and the Monitor never disagree about a check. Pure, no
// I/O.
import { type CheckRun, FAILING, newestRunOfEach } from "./redMain.ts";

/**
 * How a commit decides a Main check, with the run that says so: green when
 * its newest run of the check there succeeded, red when it failed or timed
 * out, and undecided otherwise: no run of it there, one still under way, or
 * one that ended cancelled, skipped, neutral, action_required or stale.
 */
export interface MainCheckState {
  readonly is: "green" | "red" | "undecided";
  /** The newest run of the check on the commit, or null when it has none. */
  readonly run: CheckRun | null;
}

/** How `runs`, every check run on one commit, decide the Main check named `check`. */
export function mainCheckOn(check: string, runs: readonly CheckRun[]): MainCheckState {
  const run = newestRunOfEach(runs).find((each) => each.name === check) ?? null;
  if (run === null || run.status !== "completed" || run.conclusion === null) return { is: "undecided", run };
  if (FAILING.includes(run.conclusion)) return { is: "red", run };
  return { is: run.conclusion === "success" ? "green" : "undecided", run };
}
