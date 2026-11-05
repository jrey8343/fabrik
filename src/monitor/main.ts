// The Monitor's program (#148): reads the Product repo's Kit config from the
// default branch and checks it as the Loop does, lists every fabrik:monitor
// issue, the Sentry project's unresolved `error` and `fatal` groups and the
// default branch's newest commits with their check runs, plans with the
// Monitor core (src/monitor/core.ts), files, rewrites and closes what the plan
// says, and writes the step summary. It talks to GitHub and Sentry through
// their APIs alone: it never checks out or runs Product code, makes no model
// call and writes no Run record. The scheduled tick runs it hourly, in its own
// Monitor job (.github/workflows/schedule.yml).
//   node src/monitor/main.ts
// Reads FABRIK_APP_TOKEN, the Fabrik App's token on the Product repo, and
// FABRIK_APP_SLUG, the App's slug, which names the issues it opened. When
// monitor.errors is set, FABRIK_SENTRY_TOKEN is the Sentry token, empty when
// its 1Password item is missing or couldn't be read. A Sentry API error is a
// warning in the step summary, never a failed run, and red main still runs.
// Red main reads check runs through the App's Checks: read; while the App
// lacks it, GitHub refuses them and red main is a quiet dormant note.
import { appendFile } from "node:fs/promises";
import { GitHub, GitHubError, type Repo } from "../github/client.ts";
import { readKitConfigSources } from "../github/snapshot.ts";
import { callerWorkflowPath, checkKit } from "../kit/caller.ts";
import { type KitConfig, type MonitorErrors, resolveKitConfig } from "../kit/config.ts";
import { MONITOR_LABEL } from "../loop/labels.ts";
import { RED_MAIN_GREEN_MARKER, RED_MAIN_MARKER } from "../loop/markers.ts";
import { type MonitorInput, type MonitorIssue, type MonitorPlan, monitorPlanFor, newestByMarker, type SentryRead } from "./core.ts";
import type { CheckRun, MainChecksRead, MainCommit } from "./redMain.ts";
import { type GroupFacts, groupFactsOf, type RawSentryEvent, type RawSentryGroup, withLatestEvent } from "./sentry.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function report(lines: readonly string[]): Promise<void> {
  const text = lines.map((line) => `- ${line}`).join("\n");
  console.log(text);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") await appendFile(summary, `### Monitor\n\n${text}\n`);
}

/**
 * Loads and checks the Product repo's Kit config and caller workflow at the
 * commit this run is for, the default branch's head on the scheduled tick, as
 * the Loop does (src/main.ts). Returns null, having reported why, when either is invalid.
 */
async function loadKit(github: GitHub, repo: Repo): Promise<KitConfig | null> {
  const ref = required("GITHUB_SHA");
  const path = callerWorkflowPath(required("GITHUB_WORKFLOW_REF"), repo);
  const [sources, text] = await Promise.all([readKitConfigSources(github, repo, ref), github.fileText(repo, path, ref)]);
  const check = checkKit(resolveKitConfig(sources), { path, text });
  if (!check.ok) {
    for (const error of check.errors) console.log(`::error title=Invalid Kit config::${error}`);
    await report([`The Kit config is invalid, so the Monitor did nothing: ${check.errors.join("; ")}`]);
    return null;
  }
  return check.config;
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
async function monitorIssues(github: GitHub, repo: Repo, appLogin: string): Promise<MonitorIssue[]> {
  const issues: MonitorIssue[] = [];
  for (let page = 1; ; page++) {
    const batch = (await github.rest(
      "GET",
      `/repos/${repo.owner}/${repo.name}/issues?labels=${encodeURIComponent(MONITOR_LABEL)}&state=all&per_page=100&page=${page}`,
    )) as RawIssue[];
    for (const issue of batch) {
      if (issue.pull_request !== undefined) continue;
      issues.push({
        number: issue.number,
        open: issue.state === "open",
        stateReason: issue.state_reason,
        closedAt: issue.closed_at,
        labels: issue.labels.map((label) => label.name),
        byApp: issue.user?.login === appLogin,
        body: issue.body ?? "",
        closedByMonitor: false,
      });
    }
    if (batch.length < 100) return issues;
  }
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
 * runs, or no-permission when GitHub refuses the check runs because the
 * Fabrik App hasn't been granted Checks: read. Every other error fails the run.
 */
async function readMainChecks(github: GitHub, repo: Repo, gatingChecks: readonly string[]): Promise<MainChecksRead> {
  // With no sha, GitHub lists the default branch's commits.
  const listed = (await github.rest("GET", `/repos/${repo.owner}/${repo.name}/commits?per_page=${MAIN_COMMITS}`)) as RawCommit[];
  const commits: MainCommit[] = [];
  for (const commit of listed) {
    try {
      commits.push({ sha: commit.sha, url: commit.html_url, checkRuns: await checkRunsOf(github, repo, commit, gatingChecks) });
    } catch (error) {
      if (error instanceof GitHubError && error.status === 403) return { kind: "no-permission" };
      throw error;
    }
  }
  return { kind: "read", commits };
}

/**
 * A commit's check runs: those named in `sandbox.checks`, asked for by name,
 * when it lists any, else every one. Fabrik's own jobs add runs to the
 * default branch's head every hour, so asking by name keeps the read short.
 */
async function checkRunsOf(github: GitHub, repo: Repo, commit: RawCommit, gatingChecks: readonly string[]): Promise<CheckRun[]> {
  const byName = gatingChecks.length === 0 ? [""] : gatingChecks.map((name) => `&check_name=${encodeURIComponent(name)}`);
  const runs: CheckRun[] = [];
  for (const filter of byName) {
    for (let page = 1; ; page++) {
      const { check_runs: batch } = (await github.rest(
        "GET",
        `/repos/${repo.owner}/${repo.name}/commits/${commit.sha}/check-runs?per_page=100&page=${page}${filter}`,
      )) as { check_runs: RawCheckRun[] };
      for (const run of batch) {
        runs.push({
          id: run.id,
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          completedAt: run.completed_at,
          url: run.html_url ?? commit.html_url,
        });
      }
      if (batch.length < 100) break;
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
async function withRedMainCloser(github: GitHub, repo: Repo, issues: readonly MonitorIssue[], appLogin: string): Promise<MonitorIssue[]> {
  const newest = newestByMarker(issues).get(RED_MAIN_MARKER);
  if (newest === undefined || newest.open) return [...issues];
  let noted = false;
  let byMonitor = false;
  for (let page = 1; ; page++) {
    const batch = (await github.rest(
      "GET",
      `/repos/${repo.owner}/${repo.name}/issues/${newest.number}/timeline?per_page=100&page=${page}`,
    )) as RawTimelineEvent[];
    for (const entry of batch) {
      if (entry.event === "commented") {
        if (entry.user?.login === appLogin && (entry.body ?? "").startsWith(RED_MAIN_GREEN_MARKER)) noted = true;
      } else if (entry.event === "reopened") {
        noted = false;
      } else if (entry.event === "closed") {
        byMonitor = noted && entry.actor?.login === appLogin;
        noted = false;
      }
    }
    if (batch.length < 100) break;
  }
  return issues.map((issue) => (issue === newest ? { ...issue, closedByMonitor: byMonitor } : issue));
}

/** A failed Sentry API call, with the status it failed with, or null when it got no answer. */
class SentryError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "SentryError";
    this.status = status;
  }
}

type SentryGet = (path: string) => Promise<Response>;

/** GETs from the Sentry host `monitor.errors.url` names, with the token. */
function sentryClient(errors: MonitorErrors, token: string): SentryGet {
  const host = errors.url.replace(/\/+$/, "");
  return async (path) => {
    let response: Response;
    try {
      response = await fetch(`${host}${path}`, { headers: { accept: "application/json", authorization: `Bearer ${token}` } });
    } catch (error) {
      throw new SentryError(`Sentry at ${host} didn't answer: ${error instanceof Error ? error.message : String(error)}`, null);
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      throw new SentryError(`Sentry answered GET ${path.split("?")[0]} with ${response.status}: ${detail}`, response.status);
    }
    return response;
  };
}

/** The most pages of 100 groups the Monitor lists in one tick. */
const LISTING_PAGES = 10;

/** The `next` cursor in a Sentry `Link` header, or null when there are no more results. */
function nextCursor(link: string | null): string | null {
  return /<[^>]*>;\s*rel="next";\s*results="true";\s*cursor="([^"]+)"/.exec(link ?? "")?.[1] ?? null;
}

/** What reading Sentry gave, and any lines for the step summary that the reading itself adds. */
interface SentryReading {
  readonly sentry: SentryRead | null;
  readonly notes: readonly string[];
}

/** The project's unresolved `error` and `fatal` groups, with their 24-hour stats, as group facts. */
async function readGroups(get: SentryGet, errors: MonitorErrors): Promise<SentryReading> {
  const query = new URLSearchParams({ query: "is:unresolved level:[error,fatal]", statsPeriod: "24h", limit: "100" });
  const listing: RawSentryGroup[] = [];
  const notes: string[] = [];
  for (let page = 1; ; page++) {
    const response = await get(`/api/0/projects/${errors.org}/${errors.project}/issues/?${query}`);
    listing.push(...((await response.json()) as RawSentryGroup[]));
    const cursor = nextCursor(response.headers.get("link"));
    if (cursor === null) break;
    if (page === LISTING_PAGES) {
      notes.push(`Warning: Sentry lists more than ${LISTING_PAGES * 100} unresolved \`error\` and \`fatal\` groups, so only the ${LISTING_PAGES * 100} it gave first were read.`);
      break;
    }
    query.set("cursor", cursor);
  }
  const groupsWithoutStats = listing.filter((group) => group.stats?.["24h"] === undefined).length;
  return { sentry: { kind: "read", groups: groupFactsOf(listing), groupsWithoutStats }, notes };
}

/** Reads Sentry when monitor.errors is set, turning a missing or refused token and any API error into what the core reports. */
async function readSentry(errors: MonitorErrors | null): Promise<SentryReading> {
  if (errors === null) return { sentry: null, notes: [] };
  const token = process.env["FABRIK_SENTRY_TOKEN"] ?? "";
  if (token === "") return { sentry: { kind: "no-token" }, notes: [] };
  try {
    return await readGroups(sentryClient(errors, token), errors);
  } catch (error) {
    if (error instanceof SentryError && (error.status === 401 || error.status === 403)) {
      return { sentry: { kind: "token-rejected", status: error.status }, notes: [] };
    }
    const message = error instanceof Error ? error.message : String(error);
    console.log(`::warning title=Sentry unreachable::${message}`);
    return { sentry: { kind: "failed", error: message }, notes: [] };
  }
}

/**
 * The input with the latest event read for each group the first plan files or
 * rewrites the stats of, and only those: a release changes only with a new
 * event, which changes the other stats too. A group whose latest event can't
 * be read is filed without it, or keeps the release its stats block names,
 * with a warning.
 */
async function withLatestEvents(
  input: MonitorInput,
  plan: MonitorPlan,
  errors: MonitorErrors | null,
): Promise<{ readonly input: MonitorInput; readonly notes: readonly string[] }> {
  const filing = new Set(plan.open.flatMap((issue) => (issue.sentryGroup === null ? [] : [issue.sentryGroup])));
  const rewriting = new Set(plan.rewrite.flatMap((rewrite) => (rewrite.kind === "stats" ? [rewrite.sentryGroup] : [])));
  if (errors === null || input.sentry?.kind !== "read" || filing.size + rewriting.size === 0) return { input, notes: [] };
  const get = sentryClient(errors, process.env["FABRIK_SENTRY_TOKEN"] ?? "");
  const notes: string[] = [];
  const groups: GroupFacts[] = [];
  for (const group of input.sentry.groups) {
    if (!filing.has(group.id) && !rewriting.has(group.id)) {
      groups.push(group);
      continue;
    }
    try {
      const response = await get(`/api/0/organizations/${errors.org}/issues/${encodeURIComponent(group.id)}/events/latest/`);
      groups.push(withLatestEvent(group, (await response.json()) as RawSentryEvent));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`::warning title=Sentry unreachable::${message}`);
      const shows = filing.has(group.id) ? "its issue shows no release or frames" : "its issue's stats keep the release they named";
      notes.push(`Warning: the latest event of Sentry's ${group.shortId} couldn't be read, so ${shows}: ${message}`);
      groups.push(group);
    }
  }
  return { input: { ...input, sentry: { ...input.sentry, groups } }, notes };
}

/** Files each issue the plan opens, rewrites each body it rewrites and closes what it closes, returning a step-summary line for each. */
async function apply(github: GitHub, repo: Repo, plan: MonitorPlan): Promise<string[]> {
  const lines: string[] = [];
  for (const issue of plan.open) {
    // Labels go on with the issue, so the issues.opened run it starts already sees them.
    const filed = (await github.rest("POST", `/repos/${repo.owner}/${repo.name}/issues`, {
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
    })) as { number: number };
    lines.push(`Filed #${filed.number}: ${issue.title}`);
  }
  for (const rewrite of plan.rewrite) {
    // Only the body changes: no comment, and an edit is no event the caller's workflow runs on.
    await github.rest("PATCH", `/repos/${repo.owner}/${repo.name}/issues/${rewrite.issue}`, { body: rewrite.body });
    lines.push(rewrite.summary);
  }
  for (const close of plan.close) {
    // The note goes first, so the close right after it reads as the Monitor's own in the issue's timeline.
    await github.rest("POST", `/repos/${repo.owner}/${repo.name}/issues/${close.issue}/comments`, { body: close.comment });
    await github.rest("PATCH", `/repos/${repo.owner}/${repo.name}/issues/${close.issue}`, { state: "closed", state_reason: "completed" });
    lines.push(`Closed #${close.issue} as completed: the default branch is green again.`);
  }
  return lines;
}

async function main(): Promise<void> {
  const [owner, name] = required("GITHUB_REPOSITORY").split("/");
  if (owner === undefined || name === undefined) throw new Error("GITHUB_REPOSITORY is not owner/name");
  const repo: Repo = { owner, name };
  const github = new GitHub(required("FABRIK_APP_TOKEN"), process.env["GITHUB_API_URL"] || undefined);

  const config = await loadKit(github, repo);
  if (config === null) {
    process.exitCode = 1;
    return;
  }
  const appLogin = `${required("FABRIK_APP_SLUG")}[bot]`;
  const { errors, redMain } = config.monitor;
  const gatingChecks = config.sandbox.checks;
  const [listedIssues, reading, mainChecks] = await Promise.all([
    monitorIssues(github, repo, appLogin),
    readSentry(errors),
    redMain ? readMainChecks(github, repo, gatingChecks) : null,
  ]);
  const issues = mainChecks?.kind === "read" ? await withRedMainCloser(github, repo, listedIssues, appLogin) : listedIssues;
  const listed: MonitorInput = {
    monitor: config.monitor,
    sentry: reading.sentry,
    issues,
    gatingChecks,
    mainChecks,
    cap: config.caps.monitorIssues,
    now: new Date().toISOString(),
  };
  const read = await withLatestEvents(listed, monitorPlanFor(listed), errors);
  const plan = monitorPlanFor(read.input);
  const filed = await apply(github, repo, plan);
  await report([...filed, ...reading.notes, ...read.notes, ...plan.summary]);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
