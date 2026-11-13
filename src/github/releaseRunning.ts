// The Tick's reads and write for saying a newly pinned release is running
// (#548), around the pure src/kit/releaseRunning.ts: the newest commit on main
// that moved the release `fabrik.yml` pins, read with the Kit's own reader of
// the caller pin, the merged pull request it came from and that pull
// request's comments, then the comment the plan asks for, posted with the
// Fabrik App token. Nothing here fails the Tick: a read or write GitHub
// refuses comes back as the step summary's line, and the next Tick tries
// again, which the plan's marker makes safe.
import { splitWorkflowRef } from "../kit/caller.ts";
import { type PinMove, type PullComment, releaseRunningPlan } from "../kit/releaseRunning.ts";
import { CALLER_PATH } from "../setup/shims.ts";
import { allPages, type GitHub, type Repo, whyUnread } from "./client.ts";
import { releaseIn } from "./tickFacts.ts";

export interface ReleaseRunningRun {
  readonly repo: Repo;
  /** The main commit this Tick ran on, GITHUB_SHA. */
  readonly headSha: string;
  /** The Kit workflow ref the caller pinned, such as `jrey8343/fabrik/.github/workflows/schedule.yml@v1.4.0`. */
  readonly kitRef: string;
  /** The Fabrik App's login, `<slug>[bot]`, which tells its comments from anyone else's. */
  readonly appLogin: string;
  readonly runUrl: string;
  /** When this run's first job started, ISO 8601. */
  readonly startedAt: string;
  readonly timeZone: string | null;
}

interface AssociatedPull {
  readonly number: number;
  readonly merged_at: string | null;
  readonly merge_commit_sha?: string | null;
}

interface IssueComment {
  readonly body?: string | null;
  readonly user?: { readonly login: string } | null;
}

/** Says on the pin move's pull request that this Tick's release is running, unless it says so already; the step summary's line. Never throws a GitHub failure. */
export async function confirmReleaseRunning(github: Pick<GitHub, "rest" | "fileText">, run: ReleaseRunningRun): Promise<string> {
  const running = splitWorkflowRef(run.kitRef)?.ref ?? run.kitRef;
  const path = `/repos/${run.repo.owner}/${run.repo.name}`;
  try {
    const move = await newestPinMove(github, run);
    const plan = releaseRunningPlan({ running, move, runUrl: run.runUrl, startedAt: run.startedAt, timeZone: run.timeZone });
    if (plan.comment !== null) await github.rest("POST", `${path}/issues/${plan.comment.pull}/comments`, { body: plan.comment.body });
    return plan.summary;
  } catch (error) {
    return `Couldn't say on the pin move's pull request that Fabrik ${running} is running here: ${whyUnread(error, "A read")}. The next Tick tries again.`;
  }
}

/**
 * The newest commit on main, up to the Tick's own, that changed the release
 * `fabrik.yml` pins: walking back through the commits that touch it, the last
 * before one pinning something else, or the oldest, which brought the file.
 */
async function newestPinMove(github: Pick<GitHub, "rest" | "fileText">, run: ReleaseRunningRun): Promise<PinMove | null> {
  const path = `/repos/${run.repo.owner}/${run.repo.name}`;
  const commits = await allPages<{ sha: string }>(github, `${path}/commits?sha=${encodeURIComponent(run.headSha)}&path=${encodeURIComponent(CALLER_PATH)}`);
  const [newest] = commits;
  if (newest === undefined) return null;
  const release = await releaseAt(github, run.repo, newest.sha);
  let moved = newest.sha;
  for (const { sha } of commits.slice(1)) {
    if ((await releaseAt(github, run.repo, sha)) !== release) break;
    moved = sha;
  }
  return { sha: moved, release, pull: release === null ? null : await pullOf(github, run, moved) };
}

/** The release `fabrik.yml` pins at a commit, by the Kit's caller check, or null when it pins no exact one. */
async function releaseAt(github: Pick<GitHub, "fileText">, repo: Repo, sha: string): Promise<string | null> {
  return releaseIn(await github.fileText(repo, CALLER_PATH, sha));
}

/** The merged pull request a commit came from, preferring the one it merged as, and its comments; null for a direct push. */
async function pullOf(github: Pick<GitHub, "rest">, run: ReleaseRunningRun, sha: string): Promise<PinMove["pull"]> {
  const path = `/repos/${run.repo.owner}/${run.repo.name}`;
  const merged = ((await github.rest("GET", `${path}/commits/${sha}/pulls`)) as AssociatedPull[]).filter((pull) => pull.merged_at !== null);
  const pull = merged.find((candidate) => candidate.merge_commit_sha === sha) ?? merged[0];
  if (pull === undefined) return null;
  const comments = await allPages<IssueComment>(github, `${path}/issues/${pull.number}/comments`);
  return {
    number: pull.number,
    comments: comments.map((comment): PullComment => ({ body: comment.body ?? "", byApp: comment.user?.login === run.appLogin })),
  };
}
