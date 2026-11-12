// The join with runs (#621): a repo's kept rows settled against a fresh runs
// read, with no gather, so "Not started" becomes "Running" for the price of a
// runs read (#568). It gives what the Standing rule gives from the same facts
// with that runs read (./rows.ts), whenever every run behind a kept `running`
// row is still in the read: the rule's own pieces (src/kit/standingInFlight.ts)
// word the kind of run and its time. It only ever starts rows running; a run
// that ends is followed by the Kit's own write, and the gather that write
// prompts replaces the row. Pure, no I/O.
import type { RunInFlightFact } from "../github/snapshot.ts";
import { type Standing, standingAt, type StandingNamed, standingOrder } from "../kit/standing.ts";
import { type RunningRun, runningRunOf, runningSince } from "../kit/standingInFlight.ts";
import type { WaitingOnKitSilence } from "../kit/standingSilence.ts";
import type { Row } from "./rows.ts";
import { type RunsRead, runsInFlightFactOf } from "./runs.ts";

/**
 * A repo's kept rows as they stand at `now`, ISO 8601, with these runs in
 * flight: each row whose Standing awaits a run, and whose move is not the
 * Operator's, is `running` while a run of that role is in flight on its work.
 * Every row is then read at `now` as the rule reads a kept Standing
 * (standingAt), so one past its `stuckAt` is Stuck. With the runs unread, only
 * that.
 */
export function joinRuns(rows: readonly Row[], runs: RunsRead, now: string): Row[] {
  const inFlight = runsInFlightFactOf(runs);
  if (inFlight === "unread") return rows.map((row) => ({ ...row, standing: standingAt(row.standing, now) }));
  // A row started running takes its run's time, so the rows are put back in the rule's order.
  return rows.map((row) => ({ ...row, standing: standingAt(settled(row.standing, inFlight), now) })).toSorted((a, b) => standingOrder(a.standing, b.standing));
}

/**
 * A kept Standing settled against the runs in flight: running on the run that
 * counts for it, as the rule counts one (runningStandingsOf), else, for an
 * agent draft, waiting on checks while its Review's wait for them is in
 * flight; else as it was.
 */
function settled(standing: Standing, runs: readonly RunInFlightFact[]): Standing {
  if (standing.awaits === null || standing.move === "operator") return standing;
  const { role } = standing.awaits;
  const counted = runs.filter((run) => run.role === role && run.job !== "waiting-on-checks");
  const named = counted.filter((run) => namesItsWork(run, standing));
  const unnamed = WAITS_ON_ANY_RUN_OF_ITS_ROLE.has(standing.name) ? counted.filter((run) => !run.exact && run.pullRequest === null && (run.role === "review" || run.issue === null)) : [];
  const run = oldest(named) ?? oldest(unnamed);
  if (run !== undefined) return runningOn(standing, run) ?? standing;
  return role === "review" ? waitingOnChecks(standing, runs) : standing;
}

/**
 * The names of a Standing that waits on any run of its role: a run told by its
 * job's name that carries no number counts for it, as the rule counts one for
 * work whose trigger label is on or just claimed. A Held run's work, one a
 * slot holds and a blocked Ticket are not among them.
 */
const WAITS_ON_ANY_RUN_OF_ITS_ROLE: ReadonlySet<Standing["name"]> = new Set(["not-started", "waiting-on-kit", "stuck", "running"]);

/**
 * An agent draft whose Review is waiting for the Required checks on its head,
 * as the rule has it (waitingOnChecksStandingsOf), since the oldest such wait
 * began: an exact wait names its pull request, and one told by its job's name
 * counts for every such draft. A kept row is an agent draft with no Verdict on
 * its head when it waits on the Kit as a quiet draft, or already waits so.
 */
function waitingOnChecks(standing: Standing, runs: readonly RunInFlightFact[]): Standing {
  if (standing.pullRequest === null || !isQuietDraft(standing)) return standing;
  const waits = runs.filter((run) => run.role === "review" && run.job === "waiting-on-checks" && (run.exact ? run.pullRequest === standing.pullRequest : run.pullRequest === null));
  const wait = oldest(waits);
  if (wait === undefined) return standing;
  return {
    ...fieldsOf(standing),
    work: "ticket",
    place: "review",
    name: "waiting-on-checks",
    since: wait.createdAt,
    awaits: { role: "review", on: "pullRequest" },
    detail: { plain: null, check: null, checksUnread: false, ...keptKeysOf(standing) },
  };
}

/** Whether a kept Standing is an agent draft with no Verdict on its head, awaiting its Review. */
function isQuietDraft(standing: Standing): boolean {
  switch (standing.name) {
    case "waiting-on-checks":
      return standing.detail.plain === null;
    case "waiting-on-kit":
    case "stuck":
      return standing.detail.silence === "quiet-draft";
    default:
      return false;
  }
}

/** The fields of a kept Standing of work the Kit moves, which nothing turns Stuck. */
function fieldsOf({ schema, repo, issue, pullRequest }: Standing) {
  return { schema, repo, issue, pullRequest, move: "kit", yours: false, stopsWork: false, stuckAt: null, subscription: null } as const;
}

/** Whether a run names the work a Standing is: a Review's its pull request, any other role's its issue, as the rule counts it. */
function namesItsWork(run: RunInFlightFact, { issue, pullRequest }: Standing): boolean {
  if (run.role === "review") return run.pullRequest !== null && run.pullRequest === pullRequest;
  return run.issue !== null && run.issue === issue && (run.exact || run.role === "implement" || run.role === "design");
}

/** The oldest of these runs, by when Actions created it, as the rule takes it. */
function oldest(runs: readonly RunInFlightFact[]): RunInFlightFact | undefined {
  return runs.toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
}

/** Where a running role's work stands on the Loop, as the rule places a `running` Standing. */
const RUNNING_PLACES = {
  implement: { work: "ticket", place: "implement" },
  review: { work: "ticket", place: "review" },
  design: { work: "design-session", place: "design" },
  triage: { work: "issue", place: "triage" },
  research: { work: "research-decision", place: null },
} as const;

/** A kept Standing running on this run, as the rule words it; null for a run of a role no `running` Standing awaits. */
function runningOn(standing: Standing, run: RunInFlightFact): StandingNamed<"running"> | null {
  const role = run.role;
  if (!(role in RUNNING_PLACES)) return null;
  const { work, place } = RUNNING_PLACES[role as keyof typeof RUNNING_PLACES];
  const kind = runningRunOf(role, run.kind) ?? kindByRole(role as keyof typeof RUNNING_PLACES, standing, run);
  const onIssue = role !== "review" && (role !== "implement" || kind === "implement" || standing.pullRequest === null);
  return {
    ...fieldsOf(standing),
    work,
    place,
    name: "running",
    since: runningSince(run),
    awaits: { role, on: onIssue ? "issue" : "pullRequest" },
    detail: { run: kind, retry: role === "implement" ? run.retry : null, actionsRun: run.run, ...keptKeysOf(standing) },
  };
}

/**
 * The kind of a run that carries none, told by its job's name: a Retry by its
 * number; else the kind the kept row already names, or the run its silence
 * waits for; else a plain run of its role.
 */
function kindByRole(role: keyof typeof RUNNING_PLACES, standing: Standing, run: RunInFlightFact): RunningRun {
  if (role !== "implement") return role;
  if (run.retry !== null) return "retry";
  if (standing.name === "running" && standing.awaits?.role === "implement") return standing.detail.run as RunningRun;
  const silence = waitingOnKitSilenceOf(standing);
  return (silence === null ? undefined : SILENCE_RUNS[silence]) ?? "implement";
}

/** Which silence a kept Standing that waits on the Kit is, Stuck or not; null for any other. */
function waitingOnKitSilenceOf(standing: Standing): WaitingOnKitSilence | null {
  if (standing.name === "waiting-on-kit") return standing.detail.silence;
  if (standing.name === "stuck" && standing.detail.was === "waiting-on-kit") return standing.detail.silence;
  return null;
}

/** The Implement run a silence that waits on the Kit is waiting for, where it names one. */
const SILENCE_RUNS: Partial<Record<WaitingOnKitSilence, RunningRun>> = { "request-changes": "request-changes", "conflicting-draft": "conflict-only" };

/** The keys a Standing's detail keeps whatever its name: its open pull request's head, and a joined Pairing session's name. */
function keptKeysOf({ detail }: Standing): { head?: string; pullRequest?: Standing["name"] } {
  return { ...(detail.head === undefined ? {} : { head: detail.head }), ...(detail.pullRequest === undefined ? {} : { pullRequest: detail.pullRequest }) };
}
