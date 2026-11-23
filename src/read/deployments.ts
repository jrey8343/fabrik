// The Deployments read (#633): for one Product repo, whether each merge a
// reader asks about has been deployed to the environment its Kit config's
// production block names, read from GitHub's Deployments (ADR-0021). A merge
// is live when GitHub shows a successful Deployment in that environment, of
// the merge commit or a later commit that contains it. It is made with the
// reader's own credential, which needs Deployments read: the environment's
// Deployments and their reports by GraphQL, a hundred to a query (#897), and
// its comparisons of commits by REST. No Kit job makes it, and the Fabrik App
// gains no permission. It never throws: what GitHub refused or failed leaves
// "unread" only the merges that turn on it.
// In a repo that declares `staging`, the same read is made of the environment
// its staging block names (#855, ADR-0038), asked for the newest success too.
import { type Page, pagesOf, type ReadClient } from "../github/client.ts";
import { PAGE_INFO } from "../github/facts.ts";

/** What a Deployments read of one repo says about the merges it was asked about. */
export interface DeploymentsRead {
  /** The repo read, `owner/name`. */
  readonly repo: string;
  /** The environment read, the name Kit config's production block gives, or its staging block's. */
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
  /**
   * On a success, where the read was asked for it (readDeployments'
   * `newest`): the newest successful Deployment whose commit contains the
   * merge, by creation, and when it succeeded: the one above where no later
   * one succeeded. Its commit is the one a merge's Main checks are read on
   * at Staging (ADR-0038). Left out otherwise.
   */
  readonly newest?: { readonly deployment: number; readonly commit: string; readonly at: string };
}

/** One merge a Deployments read is asked about. */
export interface MergeToRead {
  /** The commit the merge made on the default branch. */
  readonly mergeCommit: string;
  /** When it merged, ISO 8601. */
  readonly mergedAt: string;
}

/** A page of the environment's Deployments, or of one Deployment's reports: as many as GitHub gives to one. */
const PAGE = 100;

/** What the queries read of a report on a Deployment. */
const REPORT = "state createdAt logUrl";

/**
 * The environment's Deployments, newest first, a page at a time from the
 * cursor `$after`: each with its node id, GitHub's id for it, the commit it
 * deployed, its environment, when it was made, and its first page of
 * reports, which GitHub gives newest first.
 */
const DEPLOYMENTS_QUERY = `
  query ($owner: String!, $name: String!, $environment: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      deployments(environments: [$environment], first: ${PAGE}, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
        ${PAGE_INFO}
        nodes {
          id databaseId commitOid environment createdAt
          statuses(first: ${PAGE}) { ${PAGE_INFO} nodes { ${REPORT} } }
        }
      }
    }
  }
`;

/** One Deployment's reports past its first page, a page at a time from the cursor `$after`, newest first. */
const REPORTS_QUERY = `
  query ($id: ID!, $after: String) {
    node(id: $id) {
      ... on Deployment {
        statuses(first: ${PAGE}, after: $after) { ${PAGE_INFO} nodes { ${REPORT} } }
      }
    }
  }
`;

/**
 * Whether each of `merges` has been deployed to `environment` in `repo`, read
 * at `now`. A deploy counts for a merge when it is a Deployment in that
 * environment, created at or after the merge, of a commit that contains the
 * merge commit: GitHub's comparison of the two says `ahead` or `identical`.
 *
 * One GraphQL query for each page of the environment's Deployments, a
 * hundred to a page, newest first, each with its first hundred reports, read
 * no further back than the first page that reaches before the earliest
 * merge; one more for each further hundred reports of a Deployment that has
 * more, which few have; and a REST comparison for each pair of merge and
 * deployed commit the answer turns on, asked once, and none where the two are
 * the same commit: a merge its own commit's deploy has settled asks none.
 * Asked about no merges, it makes no request.
 *
 * With `newest`, as a read of `staging.environment` is made (ADR-0038), each
 * success also carries the newest successful Deployment that contains the
 * merge (`DeployOf.newest`), at the cost of a comparison for each later
 * success until one counts. Without it, a read is as it ever was.
 */
export async function readDeployments(
  client: Pick<ReadClient, "rest" | "graphql">,
  repo: string,
  environment: string,
  merges: readonly MergeToRead[],
  now: string,
  options: { readonly newest?: boolean } = {},
): Promise<DeploymentsRead> {
  const asked = mergesOnce(merges);
  if (asked.length === 0) return { repo, environment, readAt: now, merges: {} };
  const answer = (of: (merge: MergeToRead) => DeployOf | "unread") => ({
    repo,
    environment,
    readAt: now,
    merges: Object.fromEntries(asked.map((merge) => [merge.mergeCommit, of(merge)])),
  });
  const earliestMerge = Math.min(...asked.map(({ mergedAt }) => Date.parse(mergedAt)));
  let listed: RawDeployment[];
  try {
    listed = (await listSince(client, repo, environment, earliestMerge)).filter((deployment) => deployment.environment === environment);
  } catch {
    return answer(() => "unread");
  }
  const read = await Promise.all(
    listed.map(async (raw) => {
      const deployment: Deployment = { id: raw.databaseId, sha: raw.commitOid, createdAt: raw.createdAt };
      return { deployment, state: stateOf(await reportsOf(client, raw)) };
    }),
  );
  const kept = read.flatMap(({ deployment, state }) => (state === "passed-over" ? [] : [{ deployment, state }]));
  const contains = containing(client, repo);
  const decided = await Promise.all(
    asked.map(async (merge) => {
      const candidates = kept.filter(({ deployment }) => Date.parse(deployment.createdAt) >= Date.parse(merge.mergedAt));
      return [merge.mergeCommit, await deployOf(candidates, (deployed) => contains(merge.mergeCommit, deployed), options.newest === true)] as const;
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

/** A report on a Deployment, as the queries read it. */
interface RawReport {
  /** GitHub's GraphQL name for its state, such as `IN_PROGRESS`. */
  readonly state: string;
  readonly createdAt: string;
  readonly logUrl: string | null;
}

/** A Deployment as DEPLOYMENTS_QUERY reads it. */
interface RawDeployment {
  /** Its node id, by which the rest of its reports are asked for. */
  readonly id: string;
  /** GitHub's id for it, the one its REST API gives. */
  readonly databaseId: number;
  readonly commitOid: string;
  /** The environment it was last deployed to, as the REST API's `environment` is. */
  readonly environment: string | null;
  readonly createdAt: string;
  /** Its first page of reports, newest first; null when GitHub gave none. */
  readonly statuses: Page<RawReport> | null;
}

/** A Deployment the read keeps: GitHub's id for it, the commit it deployed and when it was made. */
interface Deployment {
  readonly id: number;
  readonly sha: string;
  readonly createdAt: string;
}

/**
 * The environment's Deployments created at or after `since` (epoch ms),
 * newest first as GitHub lists them, stopping at the first page that reaches
 * one older, or the last.
 */
async function listSince(client: Pick<ReadClient, "graphql">, repo: string, environment: string, since: number): Promise<RawDeployment[]> {
  const [owner = "", name = ""] = repo.split("/");
  const isOlder = ({ createdAt }: RawDeployment) => Date.parse(createdAt) < since;
  const listed = await pagesOf<RawDeployment>(client, DEPLOYMENTS_QUERY, { owner, name }, { environment }, (data) => data.repository.deployments, (page) => page.some(isOlder));
  return listed.filter((deployment) => !isOlder(deployment));
}

/**
 * Every report on a Deployment, newest first as GitHub gives them: its first
 * page from the listing, and the rest a page to a query. Unread when a page
 * could not be read.
 */
async function reportsOf(client: Pick<ReadClient, "graphql">, deployment: RawDeployment): Promise<RawReport[] | "unread"> {
  const reports: RawReport[] = [];
  let page = deployment.statuses;
  try {
    for (;;) {
      // No page where GitHub gave one, as for a Deployment gone since it was listed, leaves them untold.
      if (page === null) return "unread";
      reports.push(...page.nodes);
      const { hasNextPage, endCursor } = page.pageInfo;
      if (!hasNextPage) return reports;
      if (endCursor === null) return "unread";
      const { node } = await client.graphql<{ node: { statuses?: Page<RawReport> | null } | null }>(REPORTS_QUERY, { id: deployment.id, after: endCursor });
      page = node?.statuses ?? null;
    }
  } catch {
    return "unread";
  }
}

/** What one Deployment is, from its reports; unread when they could not be read. */
type DeploymentState =
  | { readonly is: "succeeded"; readonly at: string }
  | { readonly is: "failed"; readonly at: string; readonly log: string | null }
  | { readonly is: "running" }
  | "passed-over"
  | "unread";

/**
 * What a Deployment is, from its reports (newest first, as GitHub gives
 * them): succeeded when any is `success` (GitHub turns an earlier success
 * `inactive` when a later deploy succeeds), at the earliest; failed when its
 * latest is `failure` or `error`; passed over when its latest is `inactive`
 * and none succeeded; running for anything else, a Deployment with no report
 * yet included. GraphQL names a report's state as REST does, in capitals, so
 * `IN_PROGRESS` is the rule's `in_progress`. A failure's log is its
 * `logUrl`, the one address REST gives as both `log_url` and the older
 * `target_url`, so a reporter that sets only `target_url` has it there too.
 * Of two reports made in the same second, the later is given first.
 */
function stateOf(reports: readonly RawReport[] | "unread"): DeploymentState {
  if (reports === "unread") return "unread";
  // Reversed, they are oldest first where two share a time.
  const oldestFirst = reports
    .map((report) => ({ state: report.state.toLowerCase(), at: report.createdAt, log: report.logUrl }))
    .toReversed()
    .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const success = oldestFirst.find(({ state }) => state === "success");
  if (success !== undefined) return { is: "succeeded", at: success.at };
  const latest = oldestFirst.at(-1);
  if (latest?.state === "failure" || latest?.state === "error") return { is: "failed", at: latest.at, log: httpsOrNull(latest.log) };
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

/** A Deployment created at or after a merge, and what it is. */
interface Candidate {
  readonly deployment: Deployment;
  readonly state: Exclude<DeploymentState, "passed-over">;
}

/**
 * The answer for one merge, from the Deployments created since it, of which
 * those whose commit contains the merge commit count (`counts`), first match
 * wins: succeeded at the earliest success of any that counts; running, at
 * the newest running one's creation; failed by the newest that counts; else
 * none. It asks whether one counts only as far as the answer turns on it, so
 * a merge its own commit's deploy has settled asks nothing. Unread when one
 * the answer turns on could not be read: its comparison, or its reports where
 * it might have succeeded sooner or be the one that decides. Asked for the
 * `newest`, a success also carries the newest successful Deployment that
 * counts, and is unread when one that might be it could not be read.
 */
async function deployOf(candidates: readonly Candidate[], counts: (deployed: string) => Promise<boolean | "unread">, newest: boolean): Promise<DeployOf | "unread"> {
  // Newest first, by creation, then by GitHub's numbering where that ties.
  const newestFirst = candidates.toSorted((a, b) => Date.parse(b.deployment.createdAt) - Date.parse(a.deployment.createdAt) || b.deployment.id - a.deployment.id);
  const unreadable = newestFirst.filter(({ state }) => state === "unread");
  /** Whether one whose reports could not be read, created at or before `by` (epoch ms), counts or might: it could have succeeded sooner. */
  const unreadableCounts = async (by: number) => {
    for (const { deployment } of unreadable) {
      if (Date.parse(deployment.createdAt) <= by && (await counts(deployment.sha)) !== false) return true;
    }
    return false;
  };
  const successes = newestFirst
    .flatMap(({ deployment, state }) => (state !== "unread" && state.is === "succeeded" ? [{ deployment, at: state.at }] : []))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.deployment.id - b.deployment.id);
  for (const { deployment, at } of successes) {
    if (await unreadableCounts(Date.parse(at))) return "unread";
    const counted = await counts(deployment.sha);
    if (counted === "unread") return "unread";
    if (!counted) continue;
    const succeeded = { is: "succeeded", deployment: deployment.id, commit: deployment.sha, at, log: null } as const;
    if (!newest) return succeeded;
    // The newest success that counts, by creation: this one, unless a later one counts too.
    for (const later of newestFirst) {
      if (later.deployment === deployment) return { ...succeeded, newest: { deployment: deployment.id, commit: deployment.sha, at } };
      // One whose reports could not be read might be a newer success.
      if (later.state === "unread") {
        if ((await counts(later.deployment.sha)) !== false) return "unread";
        continue;
      }
      if (later.state.is !== "succeeded") continue;
      const laterCounted = await counts(later.deployment.sha);
      if (laterCounted === "unread") return "unread";
      if (laterCounted) return { ...succeeded, newest: { deployment: later.deployment.id, commit: later.deployment.sha, at: later.state.at } };
    }
    return succeeded;
  }
  if (await unreadableCounts(Infinity)) return "unread";
  for (const { deployment, state } of newestFirst) {
    if (state === "unread" || state.is !== "running") continue;
    const counted = await counts(deployment.sha);
    if (counted === "unread") return "unread";
    if (counted) return { is: "running", deployment: deployment.id, commit: deployment.sha, at: deployment.createdAt, log: null };
  }
  for (const { deployment, state } of newestFirst) {
    if (state === "unread" || state.is !== "failed") continue;
    const counted = await counts(deployment.sha);
    if (counted === "unread") return "unread";
    if (counted) return { is: "failed", deployment: deployment.id, commit: deployment.sha, at: state.at, log: state.log };
  }
  return { is: "none", deployment: null, commit: null, at: null, log: null };
}
