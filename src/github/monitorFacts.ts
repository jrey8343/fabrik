// The Monitor's GitHub side (#148), beside the Weekly summary's (./facts.ts):
// every fabrik:monitor issue in the Product repo, the default branch's newest
// commits with their check runs, and whether the Monitor itself made the last
// close of the newest red-main issue, as the facts the Monitor core plans from
// (src/monitor/core.ts). Read-only. Its program is src/monitor/main.ts.
import { MONITOR_LABEL } from "../loop/labels.ts";
import { RED_MAIN_GREEN_MARKER } from "../loop/markers.ts";
import { type MonitorIssue, newestByMarker } from "../monitor/issues.ts";
import type { CheckRun, MainChecksRead, MainCommit } from "../monitor/redMain.ts";
import { allPages, type GitHub, GitHubError, type Repo, refusalOf } from "./client.ts";

/** What the Monitor reads of the Product repo on GitHub. */
export interface MonitorGitHubFacts {
  /** Every issue carrying fabrik:monitor, open or closed. */
  readonly issues: readonly MonitorIssue[];
  /** The default branch's newest commits and their check runs, or null when red main is off and they weren't read. */
  readonly mainChecks: MainChecksRead | null;
}

/**
 * Reads the Monitor's GitHub facts: the issues, and with red main on the
 * default branch's commits and their check runs, through the gating checks
 * `sandbox.checks` lists, and who last closed the newest red-main issue.
 * `appLogin` is the Fabrik App's bot login, which names its issues and its own close.
 */
export async function gatherMonitorFacts(
  github: Pick<GitHub, "rest">,
  repo: Repo,
  { appLogin, redMain, gatingChecks }: { readonly appLogin: string; readonly redMain: boolean; readonly gatingChecks: readonly string[] },
): Promise<MonitorGitHubFacts> {
  const [issues, mainChecks] = await Promise.all([
    monitorIssues(github, repo, appLogin),
    redMain ? mainChecksOf(github, repo, gatingChecks) : null,
  ]);
  return { issues: mainChecks?.kind === "read" ? await withRedMainCloser(github, repo, issues, appLogin) : issues, mainChecks };
}

/** An issue in GitHub's REST listing; pull requests come in it too. */
interface RawIssue {
  readonly number: number;
  readonly state: string;
  readonly state_reason: string | null;
  readonly closed_at: string | null;
  readonly labels: readonly { readonly name: string }[];
  readonly user: { readonly login: string } | null;
  readonly body: string | null;
  readonly pull_request?: unknown;
}

/** Every issue carrying fabrik:monitor, open or closed. */
async function monitorIssues(github: Pick<GitHub, "rest">, repo: Repo, appLogin: string): Promise<MonitorIssue[]> {
  const listed = await allPages<RawIssue>(github, `/repos/${repo.owner}/${repo.name}/issues?labels=${encodeURIComponent(MONITOR_LABEL)}&state=all`);
  return listed
    .filter((issue) => issue.pull_request === undefined)
    .map((issue) => ({
      number: issue.number,
      open: issue.state === "open",
      stateReason: issue.state_reason,
      closedAt: issue.closed_at,
      labels: issue.labels.map((label) => label.name),
      authorIsApp: issue.user?.login === appLogin,
      body: issue.body ?? "",
      closedByMonitor: false,
    }));
}

/** How many of the default branch's newest commits red main reads back for a decided one. */
const MAIN_COMMITS = 20;

/** A commit in GitHub's REST listing. */
interface RawCommit {
  readonly sha: string;
  readonly html_url: string;
}

/** A check run in GitHub's REST listing. */
interface RawCheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly completed_at: string | null;
  readonly html_url: string | null;
}

/**
 * The default branch's newest commits, newest first, each with its check
 * runs; no-permission when GitHub refuses the check runs because the Fabrik
 * App hasn't been granted Checks: read, and rate-limited, with a warning,
 * when GitHub's rate limit stops the read. Every other error fails the run.
 */
async function mainChecksOf(github: Pick<GitHub, "rest">, repo: Repo, gatingChecks: readonly string[]): Promise<MainChecksRead> {
  try {
    // With no sha, GitHub lists the default branch's commits.
    const listed = (await github.rest("GET", `/repos/${repo.owner}/${repo.name}/commits?per_page=${MAIN_COMMITS}`)) as RawCommit[];
    const commits: MainCommit[] = [];
    for (const commit of listed) {
      commits.push({ sha: commit.sha, url: commit.html_url, checkRuns: await checkRunsOf(github, repo, commit, gatingChecks) });
    }
    return { kind: "read", commits };
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    switch (refusalOf(error)) {
      case "missing-permission":
        return { kind: "no-permission" };
      case "rate-limited":
        console.log(`::warning title=GitHub rate limit::${error.message}`);
        return { kind: "rate-limited", error: error.message };
      case null:
        throw error;
    }
  }
}

/**
 * A commit's check runs: those named in `sandbox.checks`, asked for by name,
 * when it lists any, else every one. Fabrik's own jobs add runs to the
 * default branch's head every hour, so asking by name keeps the read short.
 */
async function checkRunsOf(github: Pick<GitHub, "rest">, repo: Repo, commit: RawCommit, gatingChecks: readonly string[]): Promise<CheckRun[]> {
  const path = `/repos/${repo.owner}/${repo.name}/commits/${commit.sha}/check-runs`;
  const paths = gatingChecks.length === 0 ? [path] : gatingChecks.map((name) => `${path}?check_name=${encodeURIComponent(name)}`);
  const runs: CheckRun[] = [];
  for (const named of paths) {
    for (const run of await allPages<RawCheckRun>(github, named, (page) => (page as { check_runs: RawCheckRun[] }).check_runs)) {
      runs.push({
        id: run.id,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        completedAt: run.completed_at,
        url: run.html_url ?? commit.html_url,
      });
    }
  }
  return runs;
}

/** An entry in an issue's timeline, as GitHub's REST API gives it. */
interface RawTimelineEvent {
  readonly event?: string;
  readonly actor?: { readonly login: string } | null;
  readonly user?: { readonly login: string } | null;
  readonly body?: string | null;
}

/**
 * The issues, with whether the Monitor itself made the last close of the
 * newest red-main issue, read from its timeline: a close by the Fabrik App
 * that came after the App's green-at note, with no reopen between. The
 * Operator's close, or the Loop's (Triage closing it as wontfix, say, also as
 * the App), comes after no such note.
 */
async function withRedMainCloser(
  github: Pick<GitHub, "rest">,
  repo: Repo,
  issues: readonly MonitorIssue[],
  appLogin: string,
): Promise<MonitorIssue[]> {
  const newest = newestByMarker(issues).redMain;
  if (newest === null || newest.open) return [...issues];
  let noted = false;
  let byMonitor = false;
  for (const entry of await allPages<RawTimelineEvent>(github, `/repos/${repo.owner}/${repo.name}/issues/${newest.number}/timeline`)) {
    if (entry.event === "commented") {
      if (entry.user?.login === appLogin && (entry.body ?? "").startsWith(RED_MAIN_GREEN_MARKER)) noted = true;
    } else if (entry.event === "reopened") {
      noted = false;
    } else if (entry.event === "closed") {
      byMonitor = noted && entry.actor?.login === appLogin;
      noted = false;
    }
  }
  return issues.map((issue) => (issue === newest ? { ...issue, closedByMonitor: byMonitor } : issue));
}
