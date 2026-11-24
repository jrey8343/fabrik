// The untried queue (#966, Spec #962): which merged agent pull requests of a
// Product repo are on staging with no Staging trial's result, each with where
// to try it and its Trial steps, for the Operator at their own machine and
// the Trial session run there. It is a reader of the Kit and nothing more: it
// imports the read library's entry alone (README.md, "Reading the Kit from
// another program"), gathers, makes the staging reads in the order the README
// gives a reader, and takes each pull request and its result from the Promote
// list. It holds no rule of its own, and it only reads.
import {
  commitsToCheck,
  gatherRepo,
  GitHubError,
  gitHubMessageOf,
  type PromoteEntry,
  promoteListOf,
  type ReadClient,
  readDeployments,
  readMainChecks,
  type RepoRead,
  rowsOf,
  stagingMergesToRead,
  wordStanding,
} from "../read/index.ts";

/** An agent pull request's entry on the Promote list. */
type AgentEntry = Extract<PromoteEntry, { readonly is: "agent" }>;

/** One merged agent pull request, as the command prints it. */
export interface PrintedPullRequest {
  readonly number: number;
  readonly title: string;
  /** Its address on GitHub. */
  readonly url: string;
  /** ISO 8601. */
  readonly mergedAt: string;
  /** The staging site's address, as its entry's `staging.site` is. */
  readonly site: AgentEntry["staging"]["site"];
  /** The staging page of each route it captured, as its entry's `staging.pages` are. */
  readonly pages: AgentEntry["staging"]["pages"];
  /** Its named Evidence shots, as its entry's `staging.shots` are. */
  readonly shots: AgentEntry["staging"]["shots"];
  /** What to try, as its entry's `staging.toTry` is. */
  readonly toTry: AgentEntry["staging"]["toTry"];
  /**
   * Its Trial steps, the entry's `staging.trial`: the summary and each step
   * with its page on staging; null for a pull request that keeps none. Not
   * the entry's own `trial`, whether it needs a Staging trial, which `result`
   * says where it needs none.
   */
  readonly trialSteps: AgentEntry["staging"]["trial"];
  /** Its Staging trial's result, as its entry on the Promote list says it. */
  readonly result: AgentEntry["result"];
}

/** Where the Operator tries a change and where they never do, beside what the command read. */
interface PrintedSites {
  /** The repo, `owner/name`. */
  readonly repo: string;
  /** The staging site, `staging.url` as Kit config gives it. */
  readonly staging: { readonly url: string };
  /** The production site, `production.url` as Kit config gives it; null where Kit config declares no `production`. */
  readonly production: { readonly url: string } | null;
}

/** What the command prints with no pull request named. */
export interface PrintedQueue extends PrintedSites {
  /** Every agent pull request on the Promote list whose result is `untried`, oldest merge first. */
  readonly untried: readonly PrintedPullRequest[];
  /**
   * The number of each agent pull request on the list that may be on staging
   * for all the read can tell, oldest merge first: its entry says not yet on
   * staging, for want of a read of its staging deploys or of their Main
   * checks. None is in `untried`.
   */
  readonly unread: readonly number[];
}

/** What the command prints for one pull request, whatever its result. */
export interface PrintedOne extends PrintedSites {
  readonly pullRequest: PrintedPullRequest & {
    /** Its Standing at Staging, as its entry carries it: the Standing's name, and the Kit's sentence for it (wordStanding). */
    readonly standing: { readonly name: AgentEntry["standing"]["name"]; readonly sentence: string };
  };
}

/** What the command read, to print as JSON, or the one line that says why it read nothing to print. */
export type UntriedQueueRead = { readonly ok: true; readonly printed: PrintedQueue | PrintedOne } | { readonly ok: false; readonly problem: string };

/**
 * The untried queue of `repo`, `owner/name`, read at `now`, ISO 8601, with
 * `client`, or, with `pullRequest`, that one agent pull request on the
 * Promote list. It makes a gather, then the staging reads the gather's rows
 * ask for, the Deployments read of `staging.environment` asked for the
 * newest success and the Main checks read of the commits it deployed, then
 * the Promote list of the two. No production Deployments read is made: an
 * entry of the Promote list is read at Staging whether or not a production
 * deployment has started on it, and with none every pull request that still
 * waits on its Staging trial is asked about.
 *
 * What it could not read to print is one line: a repo that is no Product
 * repo, one whose Kit config is invalid or declares no `staging`, one GitHub
 * would not let it read, and, with `pullRequest`, a number that is no agent
 * pull request on the Promote list.
 */
export async function readUntriedQueue(client: ReadClient, repo: string, pullRequest: number | null, now: string): Promise<UntriedQueueRead> {
  const refused = (problem: string) => ({ ok: false, problem }) as const;
  let read: RepoRead;
  try {
    read = await gatherRepo(client, repo, now);
  } catch (error) {
    return refused(`${repo} could not be read: ${error instanceof GitHubError ? gitHubMessageOf(error) : error instanceof Error ? error.message : String(error)}`);
  }
  if (!read.product) return refused(`${repo} is not a Product repo: no caller workflow at its default branch's head pins a Fabrik release.`);
  if (!read.kitConfig.ok) return refused(`${repo}'s Kit config is invalid: ${read.kitConfig.errors.join("; ")}`);
  const { staging, production, timeZone } = read.kitConfig.config;
  if (staging === null) return refused(`${repo}'s Kit config declares no staging, so it has no Staging trials.`);
  if (read.facts === null) return refused(`${repo} could not be read: ${read.unread}`);
  const rows = rowsOf(read.facts, null, null, null, now);
  const deployments = await readDeployments(client, repo, staging.environment, stagingMergesToRead(rows), now, { newest: true });
  const mainChecks = await readMainChecks(client, repo, commitsToCheck(rows, deployments), now);
  const list = promoteListOf(read.facts, { deployments, mainChecks }, now);
  const agent = (list?.entries ?? []).filter((entry) => entry.is === "agent");
  const sites = { repo, staging: { url: staging.url }, production: production === null ? null : { url: production.url } };
  if (pullRequest === null) {
    // The list is newest first.
    const untried = agent.filter(({ result }) => result.is === "untried").toReversed();
    const unread = agent.filter(({ result }) => result.is === "not-on-staging" && result.unread).toReversed();
    return { ok: true, printed: { ...sites, untried: untried.map((entry) => printedOf(repo, entry)), unread: unread.map((entry) => entry.pullRequest) } };
  }
  const named = agent.find((entry) => entry.pullRequest === pullRequest);
  if (named === undefined) return refused(`#${pullRequest} is not a merged agent pull request on the Promote list of ${repo}, which holds only what production has not taken.`);
  const { sentence } = wordStanding(named.standing, now, timeZone ?? "UTC");
  return { ok: true, printed: { ...sites, pullRequest: { ...printedOf(repo, named), standing: { name: named.standing.name, sentence } } } };
}

/** An agent entry of the Promote list as the command prints it. */
function printedOf(repo: string, { pullRequest, title, mergedAt, staging, result }: AgentEntry): PrintedPullRequest {
  const { site, pages, shots, toTry, trial } = staging;
  return { number: pullRequest, title, url: `https://github.com/${repo}/pull/${pullRequest}`, mergedAt, site, pages, shots, toTry, trialSteps: trial, result };
}
