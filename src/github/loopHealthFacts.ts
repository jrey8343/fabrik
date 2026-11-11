// The Weekly summary's reads of one Product repo's Loop (#460), for the pure
// src/kit/loopHealth.ts: its caller workflow's runs from the Actions API. Its
// last Tick is read as the daily Tick check reads it, by src/github/tickFacts.ts.
import type { RunsHealthRead } from "../kit/loopHealth.ts";
import { CALLER_FILE } from "../setup/shims.ts";
import { allPages, type GitHub, GitHubError, gitHubMessageOf, type Repo } from "./client.ts";

interface ListedRun {
  readonly conclusion: string | null;
  readonly created_at: string;
}

/** `fabrik.yml`'s runs created since `since`, ISO 8601, on every event, or why GitHub wouldn't list them. */
export async function readCallerRuns(github: Pick<GitHub, "rest">, repo: Repo, since: string): Promise<RunsHealthRead> {
  const path = `/repos/${repo.owner}/${repo.name}/actions/workflows/${CALLER_FILE}/runs?created=${encodeURIComponent(`>=${since}`)}&exclude_pull_requests=true`;
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

