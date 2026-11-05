// Small builders for red main's tests (src/monitor/redMain.ts): the default
// branch's commits, their check runs and the Monitor's red-main issue,
// matching ./monitor.ts: say only what a test cares about.
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import type { MonitorInput, MonitorIssue } from "../monitor/core.ts";
import type { CheckRun, MainCommit } from "../monitor/redMain.ts";

/** A commit's page on GitHub, in the `acme/clinic` Product repo. */
export function commitUrl(sha: string): string {
  return `https://github.com/acme/clinic/commit/${sha}`;
}

/** A check run's page on GitHub: an Actions job in run 7. */
export function runUrl(id: number): string {
  return `https://github.com/acme/clinic/actions/runs/7/job/${id}`;
}

/** Check run 900, `build`, completed as a success at 07:00 UTC on the day the tick runs. */
export function aCheckRun(overrides: Partial<CheckRun> = {}): CheckRun {
  const id = overrides.id ?? 900;
  return {
    id,
    name: "build",
    status: "completed",
    conclusion: "success",
    completedAt: "2026-11-06T07:00:00Z",
    url: runUrl(id),
    ...overrides,
  };
}

/** A commit on the default branch carrying these check runs. */
export function aCommit(sha: string, checkRuns: readonly CheckRun[]): MainCommit {
  return { sha, url: commitUrl(sha), checkRuns };
}

/**
 * A tick with production errors off and red main on, gated by every check (as
 * `sandbox.checks` lists none), the default branch read as these commits,
 * newest first, and no Monitor issues.
 */
export function redMainInput(commits: readonly MainCommit[], overrides: Partial<MonitorInput> = {}): MonitorInput {
  return {
    monitor: { ...DEFAULT_KIT_CONFIG.monitor, redMain: true },
    sentry: null,
    issues: [],
    gatingChecks: [],
    mainChecks: { kind: "read", commits },
    now: "2026-11-06T08:00:00Z",
    ...overrides,
  };
}

/** The details block's lines for commit `badc0de`'s `test` check, run 901, failing. */
export const RED_DETAILS: readonly string[] = [
  "- Red at: [`badc0de`](https://github.com/acme/clinic/commit/badc0de4a1b2c3d4e5f60718293a4b5c6d7e8f90)",
  "- Failed checks:",
  "  - [`test`](https://github.com/acme/clinic/actions/runs/7/job/901) failed",
];

/** A red-main issue's body, its details block holding these lines, with a note Triage added below it. */
export function aRedMainBody(details: readonly string[] = RED_DETAILS): string {
  return [
    "<!-- fabrik:monitor red-main -->",
    "The default branch is red.",
    "",
    "<!-- fabrik:monitor-stats -->",
    ...details,
    "<!-- /fabrik:monitor-stats -->",
    "",
    "Triage: the fix is a one-line revert.",
  ].join("\n");
}

/**
 * Open issue 41, the Fabrik App's red-main issue, labelled fabrik:monitor and
 * sorted onto the Fast path, its details block naming commit `badc0de`.
 */
export function aRedMainIssue(overrides: Partial<MonitorIssue> = {}): MonitorIssue {
  return {
    number: 41,
    open: true,
    stateReason: null,
    closedAt: null,
    labels: ["fabrik:monitor", "bug", "ready-for-agent"],
    byApp: true,
    body: aRedMainBody(),
    closedByMonitor: false,
    ...overrides,
  };
}
