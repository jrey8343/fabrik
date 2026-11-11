// The Weekly summary's Loop health line (#460): per Product repo, when its
// Tick last started, as the daily Tick check reads it (#461), and how many of
// its caller workflow's runs in the week never started or failed, from the
// Actions API. A run GitHub refuses at startup has no jobs, so it leaves no
// Run record, check run or comment: only the Actions API sees it. Pure, no
// I/O: src/kit/weekly-main.ts reads the facts.
import { readable } from "../loop/readable.ts";
import { CALLER_PATH } from "../setup/shims.ts";
import { type StartedTick, tickIsDead } from "./deadTick.ts";

/** One of the caller workflow's runs, as the Actions API lists it. */
export interface WorkflowRunFacts {
  /** Such as `startup_failure`, `failure` or `success`; null while it runs. */
  readonly conclusion: string | null;
  /** ISO 8601. */
  readonly createdAt: string;
}

/** The repo's last started Tick, as the daily Tick check reads it, or why it couldn't be read. */
export type TickHealthRead =
  | {
      readonly kind: "read";
      /** When `fabrik.yml` came to main, or null when no commit brings it. */
      readonly callerSince: string | null;
      readonly lastTick: StartedTick | null;
      /** The Fabrik App's open Dead-tick issue in the repo, or null. */
      readonly deadTickIssue: number | null;
    }
  | { readonly kind: "unread"; readonly why: string };

/** The caller workflow's recent runs, or why they couldn't be read. */
export type RunsHealthRead =
  | { readonly kind: "read"; readonly runs: readonly WorkflowRunFacts[] }
  /** The Actions token couldn't be minted: the Operator hasn't accepted Actions: read. */
  | { readonly kind: "no-permission" }
  | { readonly kind: "unread"; readonly why: string };

/** What the Weekly summary read of one Product repo's Loop. */
export interface RepoHealthFacts {
  /** `owner/name`. */
  readonly repo: string;
  readonly tick: TickHealthRead;
  readonly runs: RunsHealthRead;
}

/** One Product repo's Loop, as the Weekly summary shows it. */
export interface LoopHealth {
  readonly repo: string;
  readonly tick: TickHealthRead;
  /** Whether no Tick has started in the last 25 hours, as the daily Tick check decides it. */
  readonly tickDead: boolean;
  /** The week's counts, or why they're unread. */
  readonly runs: { readonly kind: "counted"; readonly neverStarted: number; readonly failed: number } | { readonly kind: "no-permission" } | { readonly kind: "unread"; readonly why: string };
}

/** A run that GitHub refused at startup: it never ran a job. */
const NEVER_STARTED = "startup_failure";
/** Runs that started and failed. A `cancelled` run isn't one: concurrency groups cancel runs routinely. */
const FAILED = new Set(["failure", "timed_out"]);

/** One repo's Loop health in the week from `start` to `end`, in milliseconds, as of `now`. */
export function loopHealthOf({ repo, tick, runs }: RepoHealthFacts, week: { readonly start: number; readonly end: number }, now: string): LoopHealth {
  const inWeek = (run: WorkflowRunFacts) => {
    const at = Date.parse(run.createdAt);
    return at >= week.start && at < week.end;
  };
  const counted = (read: RunsHealthRead): LoopHealth["runs"] => {
    if (read.kind !== "read") return read;
    const week = read.runs.filter(inWeek);
    return {
      kind: "counted",
      neverStarted: week.filter((run) => run.conclusion === NEVER_STARTED).length,
      failed: week.filter((run) => run.conclusion !== null && FAILED.has(run.conclusion)).length,
    };
  };
  return { repo, tick, tickDead: tick.kind === "read" && tickIsDead(tick, now), runs: counted(runs) };
}

/** Whether the Loop's health alone keeps a week from being quiet: a dead Tick, a run that never started or failed, or anything unread. */
export function loopNeedsLook({ tick, tickDead, runs }: LoopHealth): boolean {
  if (tickDead || tick.kind === "unread") return true;
  return runs.kind !== "counted" || runs.neverStarted > 0 || runs.failed > 0;
}

/**
 * The repo section's health lines: the sentence a dead Tick leads with, and
 * the health line itself. The section puts both first when the Tick is dead.
 */
export function loopHealthLines({ repo, tick, tickDead, runs }: LoopHealth, timeZone: string): { readonly lead: string | null; readonly line: string } {
  const workflow = `https://github.com/${repo}/actions/workflows/${CALLER_PATH.slice(CALLER_PATH.lastIndexOf("/") + 1)}`;
  const counts = (() => {
    switch (runs.kind) {
      case "counted": {
        const never = `${runs.neverStarted} ${runs.neverStarted === 1 ? "run" : "runs"} never started`;
        const failed = runs.failed === 0 ? "0 failed" : `[${runs.failed} failed](${workflow}?query=${encodeURIComponent("is:failure")})`;
        return `${never} · ${failed}`;
      }
      case "no-permission":
        return "run counts unread: the Fabrik App lacks Actions: read, so accept it in the App's settings, as the release notes say";
      case "unread":
        return `run counts unread: ${runs.why}`;
    }
  })();
  const last = (() => {
    if (tick.kind === "unread") return `the last Tick couldn't be read: ${tick.why}`;
    if (tick.lastTick === null) return "no Tick has started yet";
    return `the last Tick started at ${readable(tick.lastTick.at, timeZone)} ([its run](${tick.lastTick.url}))`;
  })();
  const line = `**Loop:** ${counts} · ${last}`;
  if (!tickDead || tick.kind !== "read") return { lead: null, line };
  const since = tick.lastTick?.at ?? tick.callerSince ?? "";
  const issue = tick.deadTickIssue === null ? "" : `: see [#${tick.deadTickIssue}](https://github.com/${repo}/issues/${tick.deadTickIssue})`;
  return { lead: `The Tick hasn't run since ${readable(since, timeZone)}, so the waits below include time the Loop was down${issue}.`, line };
}
