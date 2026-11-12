// The Deployments read (#633): for one Product repo, whether each merge a
// reader asks about has been deployed to the environment its Kit config's
// production block names, read from GitHub's Deployments (ADR-0021). A merge
// is live when GitHub shows a successful Deployment in that environment, of
// the merge commit or a later commit that contains it. It is made over REST
// with the reader's own credential, which needs Deployments read; no Kit job
// makes it, and the Fabrik App gains no permission. It never throws: what
// GitHub refused or failed leaves "unread" only the merges that turn on it.
import { allPages, type ReadClient } from "../github/client.ts";

/** What a Deployments read of one repo says about the merges it was asked about. */
export interface DeploymentsRead {
  /** The repo read, `owner/name`. */
  readonly repo: string;
  /** The environment read, the name Kit config's production block gives. */
  readonly environment: string;
  /** When it was read, ISO 8601. */
  readonly readAt: string;
  /** Each merge asked about, by its merge commit: how its deploy stands, or unread. */
  readonly merges: Readonly<Record<string, DeployOf | "unread">>;
}

/** How one merge's deploy stands. */
export interface DeployOf {
  readonly is: "none" | "running" | "succeeded" | "failed";
  /** GitHub's id of the Deployment that decided it; null for none. */
  readonly deployment: number | null;
  /** The commit that Deployment deployed; null for none. */
  readonly commit: string | null;
  /**
   * When it came to be so, ISO 8601: the earliest success, a running
   * Deployment's creation, or the failed report's time; null for none.
   */
  readonly at: string | null;
  /** A failed deploy's log, when it is an `https` address; else null. */
  readonly log: string | null;
}

/** One merge a Deployments read is asked about. */
export interface MergeToRead {
  /** The commit the merge made on the default branch. */
  readonly mergeCommit: string;
  /** When it merged, ISO 8601. */
  readonly mergedAt: string;
}

/** A page of the environment's Deployments, as many as GitHub gives to one. */
const PAGE = 100;

/**
 * Whether each of `merges` has been deployed to `environment` in `repo`, read
 * at `now`. A deploy counts for a merge when it is a Deployment in that
 * environment, created at or after the merge, of a commit that contains the
 * merge commit: GitHub's comparison of the two says `ahead` or `identical`.
 *
 * One request for each page of the environment's Deployments, newest first,
 * read no further back than the earliest merge; one for each Deployment's
 * reports; and one comparison for each pair of merge and deployed commit that
 * could count, asked once, and none where the two are the same commit. Asked
 * about no merges, it makes no request.
 */
export async function readDeployments(
  client: Pick<ReadClient, "rest">,
  repo: string,
  environment: string,
  merges: readonly MergeToRead[],
  now: string,
): Promise<DeploymentsRead> {
  const asked = mergesOnce(merges);
  if (asked.length === 0) return { repo, environment, readAt: now, merges: {} };
  const answer = (of: (merge: MergeToRead) => DeployOf | "unread") => ({
    repo,
    environment,
    readAt: now,
    merges: Object.fromEntries(asked.map((merge) => [merge.mergeCommit, of(merge)])),
  });
  const since = Math.min(...asked.map(({ mergedAt }) => Date.parse(mergedAt)));
  let deployments: RawDeployment[];
  try {
    deployments = (await listSince(client, repo, environment, since)).filter((deployment) => deployment.environment === environment);
  } catch {
    return answer(() => "unread");
  }
  const read = await Promise.all(deployments.map(async (deployment) => ({ deployment, state: await stateOf(client, repo, deployment) })));
  const kept = read.flatMap(({ deployment, state }) => (state === "passed-over" ? [] : [{ deployment, state }]));
  const contains = containing(client, repo);
  const decided = await Promise.all(
    asked.map(async (merge) => {
      const since = kept.filter(({ deployment }) => Date.parse(deployment.created_at) >= Date.parse(merge.mergedAt));
      const candidates = await Promise.all(since.map(async (candidate) => ({ ...candidate, contains: await contains(merge.mergeCommit, candidate.deployment.sha) })));
      return [merge.mergeCommit, deployOf(candidates)] as const;
    }),
  );
  const byMerge = new Map(decided);
  return answer(({ mergeCommit }) => byMerge.get(mergeCommit) ?? "unread");
}

/** The merges asked about, each merge commit once, at its earliest merge. */
function mergesOnce(merges: readonly MergeToRead[]): MergeToRead[] {
  const once = new Map<string, MergeToRead>();
  for (const merge of merges) {
    const kept = once.get(merge.mergeCommit);
    if (kept === undefined || Date.parse(merge.mergedAt) < Date.parse(kept.mergedAt)) once.set(merge.mergeCommit, merge);
  }
  return [...once.values()];
}

interface RawDeployment {
  readonly id: number;
  readonly sha: string;
  readonly environment: string;
  readonly created_at: string;
}

/**
 * The environment's Deployments created at or after `since` (epoch ms),
 * newest first as GitHub lists them, stopping at the first page that reaches
 * one older or is not full.
 */
async function listSince(client: Pick<ReadClient, "rest">, repo: string, environment: string, since: number): Promise<RawDeployment[]> {
  const kept: RawDeployment[] = [];
  for (let page = 1; ; page++) {
    const batch = (await client.rest("GET", `/repos/${repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=${PAGE}&page=${page}`)) as RawDeployment[];
    const recent = batch.filter((deployment) => Date.parse(deployment.created_at) >= since);
    kept.push(...recent);
    if (batch.length < PAGE || recent.length < batch.length) return kept;
  }
}

interface RawReport {
  readonly id: number;
  readonly state: string;
  readonly created_at: string;
  readonly log_url?: string | null;
  readonly target_url?: string | null;
}

/** What one Deployment is, from its reports; unread when they could not be read. */
type DeploymentState =
  | { readonly is: "succeeded"; readonly at: string }
  | { readonly is: "failed"; readonly at: string; readonly log: string | null }
  | { readonly is: "running" }
  | "passed-over"
  | "unread";

/**
 * What a Deployment is, from its reports: succeeded when any is `success`
 * (GitHub turns an earlier success `inactive` when a later deploy succeeds),
 * at the earliest; failed when its latest is `failure` or `error`; passed
 * over when its latest is `inactive` and none succeeded; running for anything
 * else, a Deployment with no report yet included.
 */
async function stateOf(client: Pick<ReadClient, "rest">, repo: string, deployment: RawDeployment): Promise<DeploymentState> {
  let reports: RawReport[];
  try {
    reports = await allPages<RawReport>(client, `/repos/${repo}/deployments/${deployment.id}/statuses`);
  } catch {
    return "unread";
  }
  const oldestFirst = reports.toSorted((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
  const success = oldestFirst.find(({ state }) => state === "success");
  if (success !== undefined) return { is: "succeeded", at: success.created_at };
  const latest = oldestFirst.at(-1);
  if (latest?.state === "failure" || latest?.state === "error") return { is: "failed", at: latest.created_at, log: httpsOrNull(latest.log_url || latest.target_url) };
  return latest?.state === "inactive" ? "passed-over" : { is: "running" };
}

/** `address` when it is an `https` address, else null: it comes from whoever reported the deploy. */
function httpsOrNull(address: string | null | undefined): string | null {
  if (address === null || address === undefined) return null;
  try {
    return new URL(address).protocol === "https:" ? address : null;
  } catch {
    return null;
  }
}

/**
 * Whether a deployed commit contains a merge commit, asked of GitHub once per
 * pair in one read: its comparison of the two says `ahead` or `identical`.
 * The same commit needs no question. Unread when the comparison failed.
 */
function containing(client: Pick<ReadClient, "rest">, repo: string): (merge: string, deployed: string) => Promise<boolean | "unread"> {
  const asked = new Map<string, Promise<boolean | "unread">>();
  return (merge, deployed) => {
    if (merge === deployed) return Promise.resolve(true);
    const pair = `${merge}...${deployed}`;
    let answer = asked.get(pair);
    if (answer === undefined) {
      answer = client.rest("GET", `/repos/${repo}/compare/${pair}?per_page=1`).then(
        (comparison) => {
          const { status } = comparison as { status?: unknown };
          return status === "ahead" || status === "identical";
        },
        () => "unread" as const,
      );
      asked.set(pair, answer);
    }
    return answer;
  };
}

/** A Deployment created at or after a merge, what it is, and whether its commit contains the merge commit. */
interface Candidate {
  readonly deployment: RawDeployment;
  readonly state: Exclude<DeploymentState, "passed-over">;
  readonly contains: boolean | "unread";
}

/**
 * The answer for one merge, from the Deployments created since it, first
 * match wins: succeeded at the earliest success of any that counts; running,
 * at the newest running one's creation; failed by the newest that counts;
 * else none. Unread when one that could count could not be read: its
 * comparison or its reports.
 */
function deployOf(candidates: readonly Candidate[]): DeployOf | "unread" {
  const counting: { readonly deployment: RawDeployment; readonly state: Exclude<Candidate["state"], "unread"> }[] = [];
  for (const { deployment, state, contains } of candidates) {
    if (contains === "unread") return "unread";
    if (!contains) continue;
    if (state === "unread") return "unread";
    counting.push({ deployment, state });
  }
  // Newest first, by creation, then by GitHub's numbering where that ties.
  counting.sort((a, b) => Date.parse(b.deployment.created_at) - Date.parse(a.deployment.created_at) || b.deployment.id - a.deployment.id);
  const succeeded = counting
    .flatMap(({ deployment, state }) => (state.is === "succeeded" ? [{ deployment, at: state.at }] : []))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.deployment.id - b.deployment.id)[0];
  if (succeeded !== undefined) return { is: "succeeded", deployment: succeeded.deployment.id, commit: succeeded.deployment.sha, at: succeeded.at, log: null };
  const running = counting.find(({ state }) => state.is === "running");
  if (running !== undefined) return { is: "running", deployment: running.deployment.id, commit: running.deployment.sha, at: running.deployment.created_at, log: null };
  const [newest] = counting;
  if (newest !== undefined && newest.state.is === "failed") {
    return { is: "failed", deployment: newest.deployment.id, commit: newest.deployment.sha, at: newest.state.at, log: newest.state.log };
  }
  return { is: "none", deployment: null, commit: null, at: null, log: null };
}
