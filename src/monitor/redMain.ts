// Red main (#148): from the default branch's newest commits and their check
// runs, whether `main` is red or green, and what the Monitor files, rewrites
// or closes for it. The Monitor core (./core.ts) composes this part of its
// plan beside production errors'. Pure, no I/O: the program
// (src/monitor/main.ts) reads the commits and check runs.
import { CALLER_JOBS } from "../kit/caller.ts";
import type { KitConfig } from "../kit/config.ts";
import { MONITOR_LABEL } from "../loop/labels.ts";
import { monitorMarkerLine, RED_MAIN_GREEN_MARKER } from "../loop/markers.ts";
import { ascending, bodyCode, monitorBlock, type MonitorIssue, type MonitorPlan, newestByMarker, withMonitorBlock } from "./issues.ts";

/** What red main's part of the plan reads of the Monitor core's input (./core.ts). */
export interface RedMainInput {
  readonly monitor: Pick<KitConfig["monitor"], "redMain">;
  /** What reading the default branch's commits and their check runs gave this tick, or null when `monitor.redMain` is off and they weren't read. */
  readonly mainChecks: MainChecksRead | null;
  /** The Kit config's `sandbox.checks`: when it lists any, the only checks that decide whether the default branch is red. */
  readonly gatingChecks: readonly string[];
  /** Every issue in the Product repo carrying fabrik:monitor, open or closed. */
  readonly issues: readonly MonitorIssue[];
}

export type MainChecksRead =
  /** The default branch's newest commits, newest first back to the program's bound, each with its check runs. */
  | { readonly kind: "read"; readonly commits: readonly MainCommit[] }
  /** GitHub refused the check runs: the Fabrik App hasn't been granted Checks: read. */
  | { readonly kind: "no-permission" }
  /** GitHub's rate limit stopped the read, with GitHub's error. */
  | { readonly kind: "rate-limited"; readonly error: string };

/** A commit on the default branch. */
export interface MainCommit {
  readonly sha: string;
  /** The commit's page on GitHub. */
  readonly url: string;
  /** Every check run on it, as GitHub lists them. */
  readonly checkRuns: readonly CheckRun[];
}

/** A check run on a commit, as GitHub gives it. */
export interface CheckRun {
  /** GitHub's id for it, higher for a newer run, such as a re-run. */
  readonly id: number;
  readonly name: string;
  /** GitHub's status: `completed` once it has finished, else such as `queued` or `in_progress`. */
  readonly status: string;
  /** GitHub's conclusion once it has completed, such as `success` or `failure`; null before. */
  readonly conclusion: string | null;
  /** ISO 8601, or null while it hasn't completed. */
  readonly completedAt: string | null;
  /** The run's page on GitHub. */
  readonly url: string;
}

/**
 * Red main's part of the plan. The newest decided commit on the default
 * branch is its state: red with no open red-main issue files one, unless the
 * Operator's close of the newest still holds; red with one open rewrites its
 * details; green with one open closes it with the Monitor's note, its only
 * comment and only close. With no decided commit, or `monitor.red_main` off,
 * it does nothing. Its issue never counts toward the cap on error issues.
 */
export function redMainPlan({ monitor, mainChecks, gatingChecks, issues }: RedMainInput): MonitorPlan {
  const nothing = { open: [], rewrite: [], close: [], summary: [] };
  if (!monitor.redMain || mainChecks === null) return nothing;
  if (mainChecks.kind === "rate-limited") {
    return {
      ...nothing,
      summary: [`Warning: GitHub's rate limit stopped red main reading the default branch's checks, so it did nothing this tick: ${mainChecks.error}`],
    };
  }
  if (mainChecks.kind === "no-permission") {
    return {
      ...nothing,
      summary: [
        "Red main is dormant: the Fabrik App needs Checks: read. Accept the App's request for it on this repo's installation (the setup wizard walks through it) to have the Monitor watch the default branch's CI.",
      ],
    };
  }
  const decided = mainChecks.commits.flatMap((commit) => decisionOf(commit, gatingChecks) ?? []);
  const state = decided[0];
  if (state === undefined) return { ...nothing, summary: [undecidedNote(mainChecks.commits.length, gatingChecks)] };
  const { commit } = state;
  const issue = newestByMarker(issues).redMain;
  if (state.kind === "green") {
    if (issue?.open === true) return { ...nothing, close: [{ issue: issue.number, comment: greenNoteFor(commit) }] };
    return { ...nothing, summary: [`Red main: the default branch is green at ${shortSha(commit)}.`] };
  }
  if (issue?.open === true) {
    const body = withMonitorBlock(issue, detailsOf(commit, state.failed));
    if (body !== null) {
      return { ...nothing, rewrite: [{ kind: "red-main", issue: issue.number, body, summary: `Refreshed red main's details on #${issue.number}.` }] };
    }
    return { ...nothing, summary: [`Red main: the default branch is still red at ${shortSha(commit)}, as #${issue.number} says.`] };
  }
  if (issue !== null && heldClosed(issue, decided)) {
    return {
      ...nothing,
      summary: [
        `Red main: the default branch is red at ${shortSha(commit)}, but #${issue.number} stays closed until it's seen green, as someone other than the Monitor closed it.`,
      ],
    };
  }
  return {
    ...nothing,
    open: [{ sentryGroup: null, title: RED_MAIN_TITLE, body: redMainBodyOf(commit, state.failed), labels: [MONITOR_LABEL] }],
  };
}

/** The quiet note that no commit within the bound is decided, naming the gating checks `sandbox.checks` lists. */
function undecidedNote(commits: number, gatingChecks: readonly string[]): string {
  const named = gatingChecks.length === 0 ? "" : ` (${gatingChecks.map((name) => bodyCode(name, CHECK_NAME_MAX)).join(", ")})`;
  return `Red main is undecided: none of the default branch's ${commits} newest commits has finished its gating checks${named} with a pass or a failure.`;
}

/**
 * Whether the newest red-main issue, closed by someone other than the Monitor
 * (the Operator, or the Loop for them), stays closed: the default branch
 * hasn't been seen green since. Once it has, a red files a new issue.
 */
function heldClosed(issue: MonitorIssue, decided: readonly Decided[]): boolean {
  if (issue.closedByMonitor || issue.closedAt === null) return false;
  const closedAt = Date.parse(issue.closedAt);
  return !decided.some((commit, i) => commit.kind === "green" && commit.decidedAt > closedAt && decidedFirst(commit, decided.slice(0, i)));
}

/**
 * Whether the commit was decided before every one newer than it in branch
 * order, so it was the newest decided commit, the default branch's state,
 * when it was decided. A green re-run of an older commit while a newer one
 * stays red never makes the default branch green.
 */
function decidedFirst(commit: Decided, newer: readonly Decided[]): boolean {
  return newer.every((other) => other.decidedAt > commit.decidedAt);
}

/**
 * A commit whose gating checks decided it: red, naming the ones that failed,
 * or green. It was decided when the last of them completed, which can be
 * after a newer commit landed, or after a close.
 */
type Decided =
  | { readonly kind: "red"; readonly commit: MainCommit; readonly decidedAt: number; readonly failed: readonly CheckRun[] }
  | { readonly kind: "green"; readonly commit: MainCommit; readonly decidedAt: number };

/** What failed or timed out makes a commit red; nothing else does. */
const FAILING = ["failure", "timed_out"];

/**
 * How the commit's gating checks decided it, or null while they haven't: once
 * every one on it has completed, it's red if any failed or timed out, else
 * green if any passed. Cancelled, skipped, neutral, action_required and stale
 * checks decide nothing, so a commit whose checks all ended that way, or that
 * carries none of them, is undecided.
 */
function decisionOf(commit: MainCommit, gatingChecks: readonly string[]): Decided | null {
  const runs = newestRunOfEach(commit.checkRuns).filter((run) => gates(run.name, gatingChecks));
  if (runs.some((run) => run.status !== "completed")) return null;
  const failed = runs.filter((run) => run.conclusion !== null && FAILING.includes(run.conclusion));
  const decidedAt = lastCompleted(runs);
  if (failed.length > 0) return { kind: "red", commit, decidedAt, failed };
  return runs.some((run) => run.conclusion === "success") ? { kind: "green", commit, decidedAt } : null;
}

/** When the last of these completed runs completed, in milliseconds since the epoch. */
function lastCompleted(runs: readonly CheckRun[]): number {
  return Math.max(0, ...runs.map((run) => Date.parse(run.completedAt ?? "") || 0));
}

const RED_MAIN_TITLE = "Red main: the default branch's CI is failing";

/** The longest check name the red-main issue quotes. */
const CHECK_NAME_MAX = 100;

/** The red-main issue's body: what it tracks, then the red commit's details in its Monitor block. */
function redMainBodyOf(commit: MainCommit, failed: readonly CheckRun[]): string {
  return [
    monitorMarkerLine({ kind: "red-main" }),
    "The default branch is red: the newest commit on it whose gating checks have all finished failed some of them. The Monitor keeps the details below current while it stays red, and closes this issue itself once the default branch is green again.",
    "",
    ...monitorBlock(detailsOf(commit, failed)),
    "",
    "The gating checks are `sandbox.checks` in `.fabrik/config.json`, or every check but Fabrik's own when it lists none.",
  ].join("\n");
}

/** The red commit and its failed checks, by name, each linked to its run. */
function detailsOf(commit: MainCommit, failed: readonly CheckRun[]): string[] {
  return [
    `- Red at: [${shortSha(commit)}](${commit.url})`,
    "- Failed checks:",
    ...[...failed]
      .sort((a, b) => ascending(a.name, b.name))
      .map((run) => `  - [${bodyCode(run.name, CHECK_NAME_MAX)}](${run.url}) ${run.conclusion === "timed_out" ? "timed out" : "failed"}`),
  ];
}

/**
 * Whether a check gates the default branch: it's one `sandbox.checks` lists,
 * when it lists any, else any check but the ones Fabrik's own jobs report,
 * which run on the default branch's head for every Loop event and tick.
 */
function gates(name: string, gatingChecks: readonly string[]): boolean {
  if (gatingChecks.length > 0) return gatingChecks.includes(name);
  return !CALLER_JOBS.some((job) => name === job || name.startsWith(`${job} / `));
}

/**
 * The newest run of each check, by id: a re-run replaces the run before it,
 * and GitHub lists every suite's runs, not just the newest of each name.
 */
function newestRunOfEach(runs: readonly CheckRun[]): CheckRun[] {
  const newest = new Map<string, CheckRun>();
  for (const run of runs) {
    const seen = newest.get(run.name);
    if (seen === undefined || run.id > seen.id) newest.set(run.name, run);
  }
  return [...newest.values()];
}

/** The Monitor's note closing its red-main issue: its only comment, and its marker tells its close apart from anyone else's. */
function greenNoteFor(commit: MainCommit): string {
  return [
    RED_MAIN_GREEN_MARKER,
    `Green at [${shortSha(commit)}](${commit.url}): its gating checks passed, so the default branch is no longer red and the Monitor closes this issue as completed.`,
  ].join("\n");
}

/** The commit's short sha, as code. */
function shortSha(commit: MainCommit): string {
  return `\`${commit.sha.slice(0, 7)}\``;
}
