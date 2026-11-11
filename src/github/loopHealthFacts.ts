// The Weekly summary's reads of one Product repo's Loop (#460), for the pure
// src/kit/loopHealth.ts: its caller workflow's runs from the Actions API, and
// its last started Tick as the daily Tick check reads it (src/github/tickFacts.ts).
import type { ProductTickRead } from "../kit/deadTick.ts";
import type { RunsHealthRead, TickHealthRead } from "../kit/loopHealth.ts";
import { DEAD_TICK_MARKER } from "../loop/kitIssueMarks.ts";
import { CALLER_PATH } from "../setup/shims.ts";
import { allPages, type GitHub, GitHubError, gitHubMessageOf, type Repo } from "./client.ts";

interface ListedRun {
  readonly conclusion: string | null;
  readonly created_at: string;
}

/** `fabrik.yml`'s runs created since `since`, ISO 8601, on every event, or why GitHub wouldn't list them. */
export async function readCallerRuns(github: Pick<GitHub, "rest">, repo: Repo, since: string): Promise<RunsHealthRead> {
  const workflow = CALLER_PATH.slice(CALLER_PATH.lastIndexOf("/") + 1);
  const path = `/repos/${repo.owner}/${repo.name}/actions/workflows/${workflow}/runs?created=${encodeURIComponent(`>=${since}`)}&exclude_pull_requests=true`;
  try {
    const runs = await allPages<ListedRun>(github, path, (page) => (page as { workflow_runs: ListedRun[] }).workflow_runs);
    return { kind: "read", runs: runs.map((run) => ({ conclusion: run.conclusion, createdAt: run.created_at })) };
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    // No fabrik.yml on the default branch: nothing to count, and the Tick's line says why.
    if (error.status === 404) return { kind: "read", runs: [] };
    return { kind: "unread", why: gitHubMessageOf(error) };
  }
}

/** The daily Tick check's read of a repo, as the health line reads it. */
export function tickHealthOf(read: ProductTickRead): TickHealthRead {
  if (read.kind !== "read") return { kind: "unread", why: read.error };
  const { callerSince, lastTick, issues } = read.facts;
  const issue = issues.find((issue) => issue.byApp && issue.body.includes(DEAD_TICK_MARKER));
  return { kind: "read", callerSince, lastTick, deadTickIssue: issue?.number ?? null };
}
