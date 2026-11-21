// The Main checks read (#855, ADR-0038): for one Product repo, how each Main
// check a reader asks about stands on each commit it asks about, the commits
// a staging Deployment deployed. A merged agent pull request is on staging
// only once every Main check `monitor.main_checks` names is green on the
// commit on staging. Each check is judged by the rule the Monitor reads a
// Main check by (src/monitor/mainCheckState.ts, ADR-0025), not as GitHub
// judges a merge (./requiredChecks.ts), so the two never disagree. It is
// not the Monitor's own read of the default branch's newest commits
// (src/monitor/redMain.ts), which no reader makes. It is made over REST with
// the reader's own credential, which needs Checks read; no Kit job makes it,
// and the Fabrik App gains no permission. It never throws: a commit GitHub
// refuses or fails is "unread", and the others are still given.
import { allPages, type ReadClient } from "../github/client.ts";
import { mainCheckOn } from "../monitor/mainCheckState.ts";
import type { CheckRun } from "../monitor/redMain.ts";

/** What a Main checks read of one repo says about the commits it was asked about. */
export interface MainChecksRead {
  /** The repo read, `owner/name`. */
  readonly repo: string;
  /** When it was read, ISO 8601. */
  readonly readAt: string;
  /** Each commit asked about, by its sha: each Main check asked of it, in the order asked, or unread. */
  readonly commits: Readonly<Record<string, readonly MainCheckOf[] | "unread">>;
}

/** One Main check, as it stands on a commit. */
export interface MainCheckOf {
  readonly name: string;
  /**
   * Green when its newest run there succeeded, red when it failed or timed
   * out, and undecided otherwise: no run of it there, one still under way, or
   * one that ended any other way.
   */
  readonly is: "green" | "red" | "undecided";
  /** That run's page, when it is an `https` address; null with no run. */
  readonly url: string | null;
  /** When that run completed, ISO 8601; null with no run or one still under way. */
  readonly at: string | null;
}

/** One commit a Main checks read is asked about, and the Main checks asked of it. */
export interface CommitToCheck {
  /** The commit's sha. */
  readonly commit: string;
  /** The names of the Main checks to read on it. */
  readonly checks: readonly string[];
}

/**
 * How each Main check asked of each of `commits` stands on it in `repo`, read
 * at `now`: one REST request for each check of each commit while its runs
 * fit a page, the commit's runs of that name, of which the newest decides. A
 * commit asked about twice is read once, for every check asked of it; one
 * asked no checks is read with no request. Asked about no commits, it makes
 * none.
 */
export async function readMainChecks(client: Pick<ReadClient, "rest">, repo: string, commits: readonly CommitToCheck[], now: string): Promise<MainChecksRead> {
  const asked = new Map<string, string[]>();
  for (const { commit, checks } of commits) asked.set(commit, [...new Set([...(asked.get(commit) ?? []), ...checks])]);
  const read = await Promise.all([...asked].map(async ([commit, checks]) => [commit, await checksOn(client, repo, commit, checks)] as const));
  return { repo, readAt: now, commits: Object.fromEntries(read) };
}

/** A check run, as GitHub's REST API lists it on a commit. */
interface RawCheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly completed_at: string | null;
  readonly html_url: string | null;
}

/** How each of `checks` stands on `commit`, in their order; unread when GitHub refused or failed one of them. */
async function checksOn(client: Pick<ReadClient, "rest">, repo: string, commit: string, checks: readonly string[]): Promise<readonly MainCheckOf[] | "unread"> {
  const read: MainCheckOf[] = [];
  try {
    for (const name of checks) {
      const path = `/repos/${repo}/commits/${commit}/check-runs?check_name=${encodeURIComponent(name)}`;
      const runs = await allPages<RawCheckRun>(client, path, (page) => (page as { check_runs: RawCheckRun[] }).check_runs);
      const { is, run } = mainCheckOn(name, runs.map(checkRunOf));
      read.push({ name, is, url: run === null ? null : httpsOrNull(run.url), at: run?.completedAt ?? null });
    }
  } catch {
    return "unread";
  }
  return read;
}

/** A check run as the shared rule reads one. */
function checkRunOf({ id, name, status, conclusion, completed_at, html_url }: RawCheckRun): CheckRun {
  return { id, name, status, conclusion, completedAt: completed_at, url: html_url ?? "" };
}

/** `address` when it is an `https` address, else null: it comes from whoever reported the check. */
function httpsOrNull(address: string): string | null {
  try {
    return new URL(address).protocol === "https:" ? address : null;
  } catch {
    return null;
  }
}
