// The daily Tick check's reads of one Product repo (#461), for the pure
// src/kit/deadTick.ts: the newest Tick that started its jobs on the default
// branch, when `fabrik.yml` came to it, the release it pins now and pinned at
// that Tick's commit, and the repo's open Dead-tick issues. A refusal is
// read as the Fabrik App no longer reaching the repo. For a repo about to get
// its Dead-tick issue, and only that, it also reads its caller workflow's runs
// since the Tick died, with the optional Actions token (#554).
import { checkCallerWorkflow } from "../kit/caller.ts";
import { awaitsDeadTickIssue, type DeadTickIssue, deadSince, type ProductTickRead, type StartedTick } from "../kit/deadTick.ts";
import { DEAD_TICK_LABEL } from "../loop/labels.ts";
import { CALLER_PATH } from "../setup/shims.ts";
import { type GitHub, GitHubError, gitHubMessageOf, type Repo, refusalOf } from "./client.ts";
import { readCallerRuns } from "./loopHealthFacts.ts";

/**
 * The most main commits the walk back reads the check runs of. A scheduled
 * run's checks attach to main's head when it ran, so the newest Tick is on the
 * newest commit carrying any, however many commits came after it.
 */
export const TICK_WALK_COMMITS = 50;

/** A Tick's check runs: the caller's `tick` job's called jobs, such as `tick / Kit`. */
const TICK_CHECK = /^tick \/ /;

interface ListedCommit {
  readonly sha: string;
  readonly commit: { readonly committer: { readonly date: string } | null };
}

interface CheckRun {
  readonly name: string;
  readonly started_at: string | null;
  readonly details_url: string | null;
}

interface ListedIssue {
  readonly number: number;
  readonly body: string | null;
  readonly user: { readonly login: string } | null;
  readonly pull_request?: unknown;
}

/** What the daily check reads of one Product repo, or why it couldn't: GitHub refusing the App, or failing some other way. */
export async function readProductTicks(
  github: Pick<GitHub, "rest" | "fileText">,
  repo: Repo,
  appLogin: string,
): Promise<ProductTickRead> {
  const name = `${repo.owner}/${repo.name}`;
  try {
    const path = `/repos/${repo.owner}/${repo.name}`;
    const { default_branch: branch } = (await github.rest("GET", path)) as { default_branch: string };
    const ref = encodeURIComponent(branch);
    const lastTick = await newestTick(github, repo, ref);
    const callerCommits = (await github.rest("GET", `${path}/commits?sha=${ref}&path=${encodeURIComponent(CALLER_PATH)}&per_page=100`)) as ListedCommit[];
    const callerSince = callerCommits.map(dateOf).filter((date) => date !== "").sort().at(0) ?? null;
    const release = releaseIn(await github.fileText(repo, CALLER_PATH, branch));
    const issues = await openDeadTickIssues(github, name, appLogin);
    return {
      repo: name,
      kind: "read",
      facts: {
        callerSince,
        lastTick: lastTick === null ? null : { ...lastTick.tick, release: releaseIn(await github.fileText(repo, CALLER_PATH, lastTick.commit)) },
        release,
        issues,
      },
    };
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    const refused = refusalOf(error) !== "rate-limited" && [401, 403, 404].includes(error.status);
    return { repo: name, kind: refused ? "refused" : "failed", error: gitHubMessageOf(error) };
  }
}

/**
 * A repo's read with its caller's runs since the Tick died, when the check is
 * about to open its Dead-tick issue; any other read as it was, with no request
 * made. A null `actions`, the Actions token whose mint failed, reads as the App
 * lacking Actions: read.
 */
export async function withCallerRuns(actions: Pick<GitHub, "rest"> | null, repo: Repo, read: ProductTickRead, now: string): Promise<ProductTickRead> {
  if (read.kind !== "read" || !awaitsDeadTickIssue(read.facts, now)) return read;
  const runs = actions === null ? { kind: "no-permission" as const } : await readCallerRuns(actions, repo, deadSince(read.facts), "unread");
  return { ...read, facts: { ...read.facts, runs } };
}

/** A repo's open Dead-tick issues, pull requests left out, each saying whether the Fabrik App opened it. */
export async function openDeadTickIssues(github: Pick<GitHub, "rest">, repo: string, appLogin: string): Promise<DeadTickIssue[]> {
  const issues = (await github.rest("GET", `/repos/${repo}/issues?labels=${encodeURIComponent(DEAD_TICK_LABEL)}&state=open&per_page=100`)) as ListedIssue[];
  return issues
    .filter((issue) => issue.pull_request === undefined)
    .map((issue) => ({ number: issue.number, body: issue.body ?? "", byApp: issue.user?.login === appLogin }));
}

/** The newest Tick on the default branch, walking back from its head, and the commit it ran on. */
async function newestTick(
  github: Pick<GitHub, "rest">,
  repo: Repo,
  ref: string,
): Promise<{ tick: Omit<StartedTick, "release">; commit: string } | null> {
  const path = `/repos/${repo.owner}/${repo.name}`;
  const commits = (await github.rest("GET", `${path}/commits?sha=${ref}&per_page=${TICK_WALK_COMMITS}`)) as ListedCommit[];
  for (const { sha } of commits.slice(0, TICK_WALK_COMMITS)) {
    const { check_runs: runs } = (await github.rest("GET", `${path}/commits/${sha}/check-runs?filter=all&per_page=100`)) as { check_runs: CheckRun[] };
    const ticks = runs.filter((run) => TICK_CHECK.test(run.name) && run.started_at !== null);
    const newest = ticks.reduce<CheckRun | null>((a, b) => (a === null || (b.started_at ?? "") > (a.started_at ?? "") ? b : a), null);
    if (newest?.started_at != null) return { tick: { at: newest.started_at, url: newest.details_url ?? "" }, commit: sha };
  }
  return null;
}

function dateOf(commit: ListedCommit): string {
  return commit.commit.committer?.date ?? "";
}

/** The release a caller workflow pins, or null when it's missing or pins none exactly. */
export function releaseIn(caller: string | null): string | null {
  if (caller === null) return null;
  const check = checkCallerWorkflow(caller);
  return check.ok ? check.release : null;
}
