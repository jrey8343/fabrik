// The Weekly summary's reads of one Product repo's Loop (#460), for the pure
// src/kit/loopHealth.ts: its caller workflow's runs from the Actions API. Its
// last Tick is read as the daily Tick check reads it, by src/github/tickFacts.ts.
// The daily Tick check reads the same runs for a repo about to get its
// Dead-tick issue (#554), to count those that never started.
import type { RunsHealthRead } from "../kit/loopHealth.ts";
import { CALLER_FILE } from "../setup/shims.ts";
import { allPages, type GitHub, GitHubError, gitHubMessageOf, type Repo } from "./client.ts";

interface ListedRun {
  readonly conclusion: string | null;
  readonly created_at: string;
  readonly event: string;
}

/**
 * `fabrik.yml`'s runs created since `since`, ISO 8601, on every event, or why
 * GitHub wouldn't list them. A 404, no `fabrik.yml` on the default branch,
 * reads as no runs, unless `missing` is "unread", as for the Dead-tick issue,
 * where no runs would read as a disabled workflow.
 */
export async function readCallerRuns(github: Pick<GitHub, "rest">, repo: Repo, since: string, missing: "none" | "unread" = "none"): Promise<RunsHealthRead> {
  const path = `/repos/${repo.owner}/${repo.name}/actions/workflows/${CALLER_FILE}/runs?created=${encodeURIComponent(`>=${since}`)}&exclude_pull_requests=true`;
  try {
    const runs = await allPages<ListedRun>(github, path, (page) => (page as { workflow_runs: ListedRun[] }).workflow_runs);
    return { kind: "read", runs: runs.map((run) => ({ conclusion: run.conclusion, createdAt: run.created_at, event: run.event })) };
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    // No fabrik.yml on the default branch: nothing to count, and the Tick's line says why.
    if (error.status === 404 && missing === "none") return { kind: "read", runs: [] };
    return { kind: "unread", why: gitHubMessageOf(error) };
  }
}

