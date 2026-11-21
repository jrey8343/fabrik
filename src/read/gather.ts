// The gather shaped for Home (#618): one Product repo read with the client a
// reader hands in, for what a reader needs to know of the repo and the facts
// the Standing rule reads of it, and nothing else. It sits beside the Weekly
// summary's gather (src/github/facts.ts), which it leaves as it is, and shares
// its queries' parts and its mapping into facts. It leaves out the Weekly
// summary's four history queries (pull requests merged or closed in 97 days,
// issues that moved in 37 days, default-branch commits, the issues the
// Operator opened in 97 days), review line comments and blockers' labels. It
// adds the bodies of the Operator's open issues, the agent pull requests
// merged in the last 24 hours, each open agent pull request's
// cross-references, the evidence marker of each agent pull request, open or
// merged in the last 24 hours, each comment's id (#639), GitHub's record of
// an edit to each of an open pull request's comments (#655), and, with each
// cross-reference, how its issue was closed, with the comments of those
// closed as not planned, where an owed Roll-in's closing comment is (#664).
// In a repo whose Kit config declares `staging` it reads past the last day
// (#856, ADR-0038): the agent pull requests merged since the newest
// successful production Deployment, the 100 most recent at most, with the
// label events a Staging trial's result is read from and the Trial problems
// that name them. A repo that declares none is asked what it ever was.
// The rows are worked out from its facts by ./rows.ts.
import { gatherWeeklyRunIssues, isAgent, labelEventsOf, openIssueOf, openKitIssueOf, openPullRequestOf, plainPullRequestOf } from "../github/facts.ts";
import { pagesOf, type ReadClient, type Repo, whyUnread } from "../github/client.ts";
import { leavingOutHeldLines } from "../github/heldLines.ts";
import { byAppOf, gatherClosedCheckIssues, gatherDesignQueueSlice, gatherDispatchCandidates, gatherKitIssues, loginOf, readKitConfigSources } from "../github/snapshot.ts";
import { type EvidenceMarker, evidenceMarkerIn } from "../evidence/uiEvidence.ts";
import { type ShotsMarker, shotsMarkerIn } from "../evidence/shotsEvidence.ts";
import { checkCallerWorkflow, fabrikRefsIn } from "../kit/caller.ts";
import { KIT_CONFIG_PATH, type KitConfig, type KitConfigResult, resolveKitConfig } from "../kit/config.ts";
import { RUN_STORE_REPO } from "../kit/runStore.ts";
import { MERGED_STANDS_HOURS, type MergedLastDayFacts } from "../kit/standingProduction.ts";
import type { TrialFacts, TrialProblemFacts } from "../kit/trialResult.ts";
import type { CommentFacts, GitHubFacts, RepoKitFacts } from "../kit/weeklySummary.ts";
import { sameRepo } from "../loop/blockers.ts";
import { AUDIT_LABEL, MAP_LABEL, REPLAY_LABEL, RETRO_LABEL, TRIAL_LABELS } from "../loop/labels.ts";
import { trialProblemIn } from "../loop/markers.ts";
import { CALLER_PATH } from "../setup/shims.ts";
import {
  type ClosedIssueCommentsQueryResult,
  closedIssueCommentsQuery,
  deploymentsQuery,
  MERGED_PULL_REQUESTS_QUERY,
  type MergedPullRequestsQueryResult,
  OPEN_ISSUES_QUERY,
  type RawHomeComment,
  OPEN_PULL_REQUESTS_QUERY,
  type RawCrossReference,
  type RawGatheredDeployment,
  type RawHomeIssue,
  type RawHomePullRequest,
  type RawMergedPullRequest,
  type RawTrialIssue,
  type RawUnpromotedPullRequest,
  REPO_QUERY,
  type RepoQueryResult,
  UNPROMOTED_PULL_REQUESTS_QUERY,
} from "./homeQueries.ts";
import { gatherStore, type StoreFacts } from "./store.ts";

/** How far back the merged agent pull requests reach: as long as a merged one stands. */
const MERGED_REACH_MS = MERGED_STANDS_HOURS * 60 * 60 * 1000;

/** How many of the pull requests production has not taken a gather keeps, in a repo that declares `staging`: the most recent. */
const UNPROMOTED_KEPT = 100;

/** A repo with no caller workflow that pins the Kit at its default branch's head: nothing more is read of it. */
export interface RepoReadNotProduct {
  /** `owner/name`. */
  readonly repo: string;
  readonly product: false;
  readonly store: false;
}

/** The store beside the Run records (RUN_STORE): the release its caller pins, and the few facts the store's Standing rule reads (./store.ts). */
export interface RepoReadStore {
  /** `owner/name`. */
  readonly repo: string;
  readonly product: false;
  readonly store: true;
  /** The release the store's caller workflow pins, or null when it pins none exactly. */
  readonly release: string | null;
  /** Null when they could not be read. */
  readonly facts: StoreFacts | null;
  /** Why the facts could not be read, or null when they were. */
  readonly unread: string | null;
}

/** A Product repo: what the Kit works out at its default branch's head, and its facts. */
export interface RepoReadProduct {
  /** `owner/name`. */
  readonly repo: string;
  readonly product: true;
  /** The release its caller workflow pins, or null when it pins none exactly. Comparing it with the reader's own is the reader's. */
  readonly release: string | null;
  /** The Operator: the Kit config's `operator`, else the repo's owner. */
  readonly operator: string;
  /** The Kit's own answer: the resolved Kit config, or its errors, one of which says so when it could not be read. */
  readonly kitConfig: KitConfigResult;
  /**
   * Whether its Kit config has a `ui` block: "no" for `ui: null` or none, so
   * that nothing is captured and no Prototype is offered there; "unknown"
   * when the Kit config is invalid or could not be read.
   */
  readonly uiBlock: "yes" | "no" | "unknown";
  /** Null when they could not be read. */
  readonly facts: Facts | null;
  /** Why the facts could not be read, or null when they were. */
  readonly unread: string | null;
}

/** What a gather gives of one repo. */
export type RepoRead = RepoReadNotProduct | RepoReadProduct | RepoReadStore;

/** The repo's Kit config and what Dispatch weighs there: the Weekly summary's Kit facts but for the runs and the checks, which their own reads give. */
export type KitFacts = Omit<RepoKitFacts, "runsInFlight" | "headChecks">;

/** The body of an open issue the Operator opened. */
export interface IssueBodyFacts {
  readonly issue: number;
  readonly body: string;
}

/** An issue GitHub cross-references to an open agent pull request. */
export interface CrossReferenceFacts {
  /** The open agent pull request it is cross-referenced to. */
  readonly pullRequest: number;
  readonly issue: number;
  readonly title: string;
  readonly open: boolean;
  /** How the issue was closed, as GitHub names the reason; null while it is open, or closed with no reason given. */
  readonly closedAs: "completed" | "not_planned" | "duplicate" | null;
  /** The repo the issue is in, `owner/name`. */
  readonly repo: string;
}

/**
 * The comments of an issue of this repo, closed as not planned, that GitHub
 * cross-references to an open agent pull request: where a Roll-in's closing
 * comment is (#664). Its latest hundred, oldest first.
 */
export interface ClosedIssueCommentsFacts {
  readonly issue: number;
  readonly comments: readonly CommentFacts[];
}

/** Whether an open agent pull request's Ticket is closed, as GitHub gives it with the pull request. */
export interface TicketStateFacts {
  readonly ticket: number;
  readonly closed: boolean;
}

/** The evidence marker in the body of an agent pull request the Fabrik App opened, open or merged in the last 24 hours (#639). */
export interface EvidenceMarkerFacts {
  readonly pullRequest: number;
  readonly marker: EvidenceMarker;
}

/** The shots marker in the body of an agent pull request the Fabrik App opened, open or merged in the last 24 hours (#822): a UI pull request's whose evidence is Evidence shots. */
export interface ShotsMarkerFacts {
  readonly pullRequest: number;
  readonly marker: ShotsMarker;
}

/**
 * Where a gather's reach past the last day starts, in a repo that declares
 * `staging` (#856): the newest successful Deployment in production's
 * environment, or, where none has ever succeeded or Kit config names no such
 * environment, the first successful Deployment in `staging.environment`.
 */
export interface StagingSince {
  /** Which environment's Deployment it is. */
  readonly from: "production" | "staging";
  /** GitHub's id of that Deployment, or null where it gives none. */
  readonly deployment: number | null;
  /** The commit it deployed. */
  readonly commit: string;
  /**
   * The time the merges are kept since, ISO 8601: when that commit was
   * committed, as a commit on the default branch holds every merge before
   * it; the Deployment's creation where GitHub gives no commit, or dates it
   * later than that. A cut by time, not by what the commit contains: a
   * Deployments read of production says that of each merge.
   */
  readonly at: string;
}

/**
 * What a gather reads past the last day in a repo whose Kit config declares
 * `staging` (#856, ADR-0038): the merged pull requests production has not
 * taken, and what a Staging trial's result is read from.
 */
export interface StagingFacts {
  /** Where the reach starts; null when no Deployment it could start at has succeeded, and nothing past the last day is kept. */
  readonly since: StagingSince | null;
  /**
   * The agent pull requests merged since then, which that Deployment's
   * commit does not hold, newest first: the 100 most recent at most. One
   * merged in the last 24 hours is in `mergedLastDay` too.
   */
  readonly unpromoted: readonly MergedLastDayFacts[];
  /**
   * What the trial result rule reads (src/kit/trialResult.ts): the label
   * events of every merged pull request the gather read, agent or Plain, and
   * the issues each closes; and each issue of the repo whose body carries
   * the Trial problem's line, that GitHub cross-references to one of them or
   * that one of them closes.
   */
  readonly trials: TrialFacts;
  /** The evidence marker of each of `unpromoted` that has one, as `evidenceMarkers` holds an open or newly merged pull request's. */
  readonly evidenceMarkers: readonly EvidenceMarkerFacts[];
  /** The shots marker of each of `unpromoted` that has one, as `shotsMarkers` holds an open or newly merged pull request's. */
  readonly shotsMarkers: readonly ShotsMarkerFacts[];
}

/**
 * What a gather reads of one Product repo: the facts the Standing rule reads,
 * and what a reader shows beside a Standing. Plain data: written as JSON and
 * read back they are equal.
 */
export interface Facts {
  readonly kind: "product";
  /** The Weekly summary's facts, with only what the Standing rule reads: its history is left empty. */
  readonly github: GitHubFacts;
  readonly kit: KitFacts;
  /** The Operator's GitHub login. */
  readonly operator: string;
  /** The Fabrik App's bot login, or null when the reader gave none: any bot's text is then taken for the App's. */
  readonly appLogin: string | null;
  /** The body of each open issue the Operator opened. */
  readonly issueBodies: readonly IssueBodyFacts[];
  /** The agent pull requests merged in the last 24 hours, from one page: a fact for the rows after a merge, and made into no row here. */
  readonly mergedLastDay: readonly MergedLastDayFacts[];
  /** The issues GitHub cross-references to each open agent pull request. */
  readonly crossReferences: readonly CrossReferenceFacts[];
  /**
   * The comments of each of those issues that is in this repo and closed as
   * not planned: the owed rule reads a Roll-in's closing comment among them
   * (./owedRollIn.ts). Empty in a repo with no such issue, which no query
   * is made for.
   */
  readonly closedIssueComments: readonly ClosedIssueCommentsFacts[];
  /** Whether each open agent pull request's Ticket is closed; a Ticket GitHub gave no state of is not here. */
  readonly ticketStates: readonly TicketStateFacts[];
  /**
   * The evidence marker of each agent pull request the Fabrik App opened,
   * open or merged in the last 24 hours, that has one: a UI pull request's.
   */
  readonly evidenceMarkers: readonly EvidenceMarkerFacts[];
  /**
   * The shots marker of each of those pull requests that has one (#822): a
   * UI pull request's whose evidence is Evidence shots, which has no evidence
   * marker of the other shape.
   */
  readonly shotsMarkers: readonly ShotsMarkerFacts[];
  /**
   * In a repo whose Kit config declares `staging` (#856): what the gather
   * reads past the last day. No such key in any other repo, whose facts are
   * as they were, nor in facts kept from an earlier release.
   */
  readonly staging?: StagingFacts;
}

/**
 * One repo, `owner/name`, read at `now`, ISO 8601, with `client`. The store
 * beside the Run records, known by the Kit's own constant for it, is read for
 * its own few facts instead (./store.ts). For any other repo, first its
 * caller workflow at its default branch's head: with none that pins the Kit
 * it is no Product repo, and nothing more is read. Otherwise the release it
 * pins, its Operator, its Kit config and whether that has a `ui` block,
 * whatever happens to the rest; then its facts, null with why when a query of
 * them fails or the Kit config could not be read. `appLogin`, the Fabrik
 * App's bot login, may be left out: any bot's text is then taken for the
 * App's, as the Kit job does.
 */
export async function gatherRepo(client: ReadClient, repo: string, now: string, appLogin: string | null = null): Promise<RepoRead> {
  if (repo === RUN_STORE_REPO) return gatherStore(client, now, appLogin);
  const [owner = "", name = ""] = repo.split("/");
  const at: Repo = { owner, name };
  const { repository } = await client.graphql<RepoQueryResult>(REPO_QUERY, { owner, name });
  const branch = repository.defaultBranchRef;
  const caller = branch === null ? null : await client.fileText(at, CALLER_PATH, branch.target.oid);
  if (branch === null || caller === null || fabrikRefsIn(caller).length === 0) return { repo, product: false, store: false };
  const pins = checkCallerWorkflow(caller);
  const release = pins.ok ? pins.release : null;
  let kitConfig: KitConfigResult;
  try {
    kitConfig = resolveKitConfig(await readKitConfigSources(client, at, branch.target.oid));
  } catch (error) {
    // With no Kit config to read the repo by, none of its facts are read either.
    const why = whyUnread(error, "A read of the Kit config");
    const unreadConfig = { ok: false, errors: [`${KIT_CONFIG_PATH} could not be read: ${why}`] } as const;
    return { repo, product: true, release, operator: repository.owner.login, kitConfig: unreadConfig, uiBlock: "unknown", facts: null, unread: why };
  }
  const operator = (kitConfig.ok ? kitConfig.config.operator : null) ?? repository.owner.login;
  const uiBlock = !kitConfig.ok ? "unknown" : kitConfig.config.ui === null ? "no" : "yes";
  const product = { repo, product: true, release, operator, kitConfig, uiBlock } as const;
  try {
    const kit = { repo, branch: branch.name, config: kitConfig };
    return { ...product, facts: await gatherFacts(client, at, kit, operator, appLogin, now), unread: null };
  } catch (error) {
    return { ...product, facts: null, unread: whyUnread(error, "A read of the repo") };
  }
}

/** The facts of one Product repo, as of `now`. */
async function gatherFacts(
  client: ReadClient,
  repo: Repo,
  kit: Omit<KitFacts, "dispatch">,
  operator: string,
  appLogin: string | null,
  now: string,
): Promise<Facts> {
  // A held line is never activity, nor the last word on the work (#471).
  const github = leavingOutHeldLines(client);
  const [pullRequests, issues, merged, { designQueue }, { kitIssues }, audits, retros, candidates, closedCheckIssues] = await Promise.all([
    pagesOf<RawHomePullRequest>(github, OPEN_PULL_REQUESTS_QUERY, repo, {}, (data) => data.repository.pullRequests),
    pagesOf<RawHomeIssue>(github, OPEN_ISSUES_QUERY, repo, {}, (data) => data.repository.issues),
    gatherMerged(github, repo, kit.config.ok ? kit.config.config : null, now),
    // The Design queue check's own slice: open `needs-design` issues only, so one closed in its session is in none.
    gatherDesignQueueSlice(github, null, repo, appLogin),
    gatherKitIssues(github, repo, appLogin),
    gatherWeeklyRunIssues(github, repo, AUDIT_LABEL),
    gatherWeeklyRunIssues(github, repo, RETRO_LABEL),
    // An invalid Kit config is read with the Kit's defaults, and Dispatch's candidates not at all, as the Loop does.
    kit.config.ok ? gatherDispatchCandidates(github, repo, appLogin) : Promise.resolve(null),
    // The tick's own read of the Check's issues closed in the last week, so a Standing dates a check's fix landing as the tick does (#795).
    gatherClosedCheckIssues(github, repo, appLogin, now),
  ]);
  const agent = pullRequests.filter(isAgent);
  const open = issues.filter(({ state }) => state === "OPEN");
  const labelled = (label: string) => open.filter(({ labels }) => labels.nodes.some(({ name }) => name === label));
  const since = Date.parse(now) - MERGED_REACH_MS;
  const mergedLastDay = merged.pullRequests.flatMap(({ mergedAt, ...pullRequest }) =>
    mergedAt === null || Date.parse(mergedAt) < since || !isAgent(pullRequest) ? [] : [{ ...pullRequest, mergedAt }],
  );
  const crossReferences = agent.flatMap(({ number, crossReferences: references }) => references.nodes.flatMap((reference) => crossReferenceOf(number, reference)));
  return {
    kind: "product",
    github: {
      repo: kit.repo,
      pullRequests: [],
      tickets: [],
      specs: [],
      defaultBranchCommits: [],
      mergedPullRequestTitles: [],
      openIssues: open.map((issue) => {
        const facts = openIssueOf(issue);
        return { ...facts, comments: withIds(facts.comments, issue.comments.nodes) };
      }),
      openPullRequests: agent.map((pullRequest) => {
        const facts = openPullRequestOf(withoutLineComments(pullRequest));
        return { ...facts, comments: withIds(facts.comments, pullRequest.comments.nodes) };
      }),
      plainPullRequests: pullRequests.filter((pullRequest) => !isAgent(pullRequest)).map((pullRequest) => plainPullRequestOf(withoutLineComments(pullRequest))),
      designQueue,
      monitorIssues: [],
      escapeMarkerIssues: [],
      followUpIssues: [],
      openAudits: labelled(AUDIT_LABEL).map(openKitIssueOf),
      openRetros: labelled(RETRO_LABEL).map(openKitIssueOf),
      audits,
      // Only the Weekly summary's Architectural escapes read the first Audit: no Standing does.
      firstAudits: [],
      retros,
      openReplays: labelled(REPLAY_LABEL).map(({ number, title, createdAt, lastEditedAt, body, author }) => ({ number, title, author: loginOf(author), createdAt, lastEditedAt, body })),
      // Oldest first, as the Map cap reads them.
      openMaps: labelled(MAP_LABEL)
        .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number)
        .map(({ number }) => number),
      kitIssues,
      // Only the Weekly summary reads the Carriers closed since (#442): no Standing does.
      weekCarriers: [],
      closedCheckIssues,
    },
    kit: { ...kit, dispatch: candidates === null ? null : { candidates } },
    operator,
    appLogin,
    issueBodies: open.filter(({ author }) => loginOf(author) === operator).map(({ number, body }) => ({ issue: number, body })),
    mergedLastDay: mergedLastDay.map(mergedFactsOf),
    crossReferences,
    closedIssueComments: await gatherClosedIssueComments(github, repo, crossReferences),
    ticketStates: agent.flatMap(({ closingIssuesReferences }) => {
      // The Ticket is the first issue an agent pull request closes, as the Weekly summary's mapping takes it.
      const ticket = closingIssuesReferences.nodes[0];
      return ticket?.state === undefined ? [] : [{ ticket: ticket.number, closed: ticket.state === "CLOSED" }];
    }),
    // A marker counts only in a body the Fabrik App wrote, as the Kit's other readers of it take it.
    evidenceMarkers: [...agent, ...mergedLastDay].flatMap(({ number, body, author }) => {
      const marker = byAppOf(author, appLogin) ? evidenceMarkerIn(body) : null;
      return marker === null ? [] : [{ pullRequest: number, marker }];
    }),
    shotsMarkers: [...agent, ...mergedLastDay].flatMap(({ number, body, author }) => {
      const marker = byAppOf(author, appLogin) ? shotsMarkerIn(body) : null;
      return marker === null ? [] : [{ pullRequest: number, marker }];
    }),
    // No such key in a repo that declares no `staging`: its facts are what they were.
    ...(merged.staging === null ? {} : { staging: stagingFactsOf(merged.staging, repo, appLogin) }),
  };
}

/** A merged agent pull request as the facts keep it: its Ticket the first issue it closes. */
function mergedFactsOf({ number, title, closingIssuesReferences, mergeCommit, mergedAt }: Pick<RawMergedPullRequest, "number" | "title" | "mergeCommit"> & { readonly mergedAt: string; readonly closingIssuesReferences: { readonly nodes: readonly { readonly number?: number }[] } }): MergedLastDayFacts {
  return { number, title, ticket: closingIssuesReferences.nodes[0]?.number ?? null, mergeCommit: mergeCommit?.oid ?? null, mergedAt };
}

/** The merged pull requests a gather read: every one, for the last day's; and, in a repo that declares `staging`, where its reach past the last day starts and those read to it. */
interface GatheredMerged {
  readonly pullRequests: readonly (RawMergedPullRequest | RawUnpromotedPullRequest)[];
  readonly staging: { readonly since: StagingSince | null; readonly pullRequests: readonly RawUnpromotedPullRequest[] } | null;
}

/**
 * The merged pull requests of `repo`. With no valid Kit config that declares
 * `staging`, the one page of the newest-updated the gather has ever read,
 * and nothing more. In a repo that declares it (#856), first where the reach
 * starts (gatherStagingSince), then the merged pull requests newest-updated
 * first, a page at a time, until a page reaches back past both that start
 * and the last 24 hours: a pull request is updated no earlier than it
 * merged, so none merged since is on a later page. Once it holds 100 agent
 * pull requests merged since the start, it stops at the first page whose
 * oldest update is before the hundredth's merge, as no later page can hold
 * one of the 100 most recent.
 */
async function gatherMerged(github: Pick<ReadClient, "graphql">, repo: Repo, config: KitConfig | null, now: string): Promise<GatheredMerged> {
  if (config === null || config.staging === null) {
    const { repository } = await github.graphql<MergedPullRequestsQueryResult>(MERGED_PULL_REQUESTS_QUERY, { owner: repo.owner, name: repo.name });
    return { pullRequests: repository.pullRequests.nodes, staging: null };
  }
  const since = await gatherStagingSince(github, repo, config.production?.environment ?? null, config.staging.environment);
  const dayAgo = Date.parse(now) - MERGED_REACH_MS;
  const reach = since === null ? dayAgo : Math.min(Date.parse(since.at), dayAgo);
  const mergedSince: number[] = [];
  const pullRequests = await pagesOf<RawUnpromotedPullRequest>(github, UNPROMOTED_PULL_REQUESTS_QUERY, repo, {}, (data) => data.repository.pullRequests, (page) => {
    const oldest = Math.min(...page.map(({ updatedAt }) => Date.parse(updatedAt)));
    if (oldest < reach) return true;
    mergedSince.push(...page.filter((pullRequest) => isUnpromoted(pullRequest, since)).map(({ mergedAt }) => Date.parse(mergedAt ?? "")));
    const hundredth = mergedSince.toSorted((a, b) => b - a)[UNPROMOTED_KEPT - 1];
    return hundredth !== undefined && oldest < Math.min(hundredth, dayAgo);
  });
  return { pullRequests, staging: { since, pullRequests } };
}

/** Whether a merged pull request is an agent one production has not taken: merged after the commit the reach starts at, and not as that commit. */
function isUnpromoted(pullRequest: RawUnpromotedPullRequest, since: StagingSince | null): boolean {
  if (since === null || pullRequest.mergedAt === null || !isAgent(pullRequest)) return false;
  return Date.parse(pullRequest.mergedAt) > Date.parse(since.at) && pullRequest.mergeCommit?.oid !== since.commit;
}

/**
 * Where the reach past the last day starts (StagingSince): the newest
 * Deployment in `production` that succeeded, read newest first; or, where
 * Kit config names no such environment or none there has succeeded, the
 * first in `staging` that did, read oldest first; null with neither. Each is
 * read a page at a time, no further than the first that succeeded.
 *
 * GitHub deletes a Deployment's statuses after 90 days, all but its current
 * one, and makes a success `inactive` when a later deploy succeeds. So the
 * newest success keeps its `success` whatever its age, and a staging
 * Deployment that old reads as `inactive` alone: the first that succeeded is
 * taken to be the first with either, where production's must still say
 * `success`. Both lean to the earlier start, which keeps more: a merge kept
 * that production already holds is moved to Production by its Deployments
 * read, where one left out would be lost.
 */
async function gatherStagingSince(github: Pick<ReadClient, "graphql">, repo: Repo, production: string | null, staging: string): Promise<StagingSince | null> {
  const first = async (from: StagingSince["from"], environment: string, direction: "ASC" | "DESC", states: readonly string[]): Promise<StagingSince | null> => {
    const succeeded = ({ statuses }: RawGatheredDeployment) => (statuses?.nodes ?? []).some(({ state }) => states.includes(state));
    const read = await pagesOf<RawGatheredDeployment>(github, deploymentsQuery(direction), repo, { environment }, (data) => data.repository.deployments, (page) => page.some(succeeded));
    const deployment = read.find(succeeded);
    if (deployment === undefined) return null;
    // A commit dated after its own Deployment has a wrong date: the creation is then the later bound.
    const committed = deployment.commit?.committedDate ?? deployment.createdAt;
    const at = Date.parse(committed) <= Date.parse(deployment.createdAt) ? committed : deployment.createdAt;
    return { from, deployment: deployment.databaseId, commit: deployment.commitOid, at };
  };
  return (production === null ? null : await first("production", production, "DESC", ["SUCCESS"])) ?? (await first("staging", staging, "ASC", ["SUCCESS", "INACTIVE"]));
}

/**
 * What the gather keeps past the last day (StagingFacts), from the merged
 * pull requests it read: the 100 agent ones production has not taken that
 * merged most recently, newest first, with their markers; of every one read,
 * agent or Plain, its label events on the two trial labels and the issues of
 * the repo it closes, where it has either; and each Trial problem among the
 * issues cross-referenced to one whose line names it, or closed by one,
 * lowest first.
 */
function stagingFactsOf({ since, pullRequests }: NonNullable<GatheredMerged["staging"]>, repo: Repo, appLogin: string | null): StagingFacts {
  const here = `${repo.owner}/${repo.name}`;
  const ofThisRepo = ({ repository }: RawTrialIssue) => repository === undefined || sameRepo(repository.nameWithOwner, here);
  const unpromoted = pullRequests
    .flatMap((pullRequest) => (pullRequest.mergedAt !== null && isUnpromoted(pullRequest, since) ? [{ ...pullRequest, mergedAt: pullRequest.mergedAt }] : []))
    .toSorted((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt) || b.number - a.number)
    .slice(0, UNPROMOTED_KEPT);
  const problems = new Map<number, TrialProblemFacts>();
  for (const { number, crossReferences, closingIssuesReferences } of pullRequests) {
    const named = crossReferences.nodes.flatMap(({ source }) => (source?.__typename === "Issue" && ofThisRepo(source) ? trialProblemOf(source, number) : []));
    const closed = closingIssuesReferences.nodes.flatMap((issue) => (ofThisRepo(issue) ? trialProblemOf(issue, null) : []));
    for (const problem of [...named, ...closed]) if (!problems.has(problem.issue)) problems.set(problem.issue, problem);
  }
  return {
    since,
    unpromoted: unpromoted.map(mergedFactsOf),
    trials: {
      pullRequests: pullRequests.flatMap(({ number, timelineItems, closingIssuesReferences }) => {
        const labelEvents = labelEventsOf(timelineItems.nodes).filter(({ label }) => (TRIAL_LABELS as readonly string[]).includes(label));
        const closes = closingIssuesReferences.nodes.flatMap((issue) => (issue.number !== undefined && ofThisRepo(issue) ? [issue.number] : []));
        return labelEvents.length === 0 && closes.length === 0 ? [] : [{ pullRequest: number, labelEvents, closes }];
      }),
      problems: [...problems.values()].toSorted((a, b) => a.issue - b.issue),
    },
    // A marker counts only in a body the Fabrik App wrote, as the last day's do.
    evidenceMarkers: unpromoted.flatMap(({ number, body, author }) => {
      const marker = byAppOf(author, appLogin) ? evidenceMarkerIn(body) : null;
      return marker === null ? [] : [{ pullRequest: number, marker }];
    }),
    shotsMarkers: unpromoted.flatMap(({ number, body, author }) => {
      const marker = byAppOf(author, appLogin) ? shotsMarkerIn(body) : null;
      return marker === null ? [] : [{ pullRequest: number, marker }];
    }),
  };
}

/**
 * An issue as a Trial problem, when its body carries the line: the one
 * `pullRequest` names, where one is given, as an issue cross-referenced to a
 * pull request is its Trial problem only when its line names that pull
 * request; whichever its line names with null, as for an issue a pull
 * request closes. None for an issue with no line, or one of another's.
 */
function trialProblemOf({ number, title, state, stateReason, body }: RawTrialIssue, pullRequest: number | null): TrialProblemFacts[] {
  const named = body === undefined ? null : trialProblemIn(body);
  if (number === undefined || named === null || (pullRequest !== null && named !== pullRequest)) return [];
  const closedAs = state !== "CLOSED" || stateReason === undefined || stateReason === null || stateReason === "REOPENED" ? null : CLOSED_AS[stateReason];
  return [{ issue: number, pullRequest: named, title: title ?? "", open: state === "OPEN", closedAs }];
}

/** How the Kit names each reason GitHub closes an issue with. */
const CLOSED_AS = { COMPLETED: "completed", NOT_PLANNED: "not_planned", DUPLICATE: "duplicate" } as const;

/** GitHub's cross-reference to open agent pull request `pullRequest` as a fact, when it is an issue's; none for a pull request's. */
function crossReferenceOf(pullRequest: number, { source }: RawCrossReference): CrossReferenceFacts[] {
  if (source?.__typename !== "Issue" || source.number === undefined) return [];
  const { state, stateReason } = source;
  const closedAs = state !== "CLOSED" || stateReason === undefined || stateReason === null || stateReason === "REOPENED" ? null : CLOSED_AS[stateReason];
  return [{ pullRequest, issue: source.number, title: source.title ?? "", open: state === "OPEN", closedAs, repo: source.repository?.nameWithOwner ?? "" }];
}

/**
 * The comments of each issue among `crossReferences` that is in `repo` and
 * closed as not planned, lowest number first: one query for them all, by
 * number, and none at all when there is no such issue, so a repo where no
 * Roll-in could be owed pays nothing. An issue GitHub no longer has is left
 * out.
 */
async function gatherClosedIssueComments(github: ReadClient, repo: Repo, crossReferences: readonly CrossReferenceFacts[]): Promise<ClosedIssueCommentsFacts[]> {
  // GitHub tells repos apart whatever the case of their names.
  const here = `${repo.owner}/${repo.name}`.toLowerCase();
  const numbers = [...new Set(crossReferences.filter((reference) => reference.closedAs === "not_planned" && reference.repo.toLowerCase() === here).map(({ issue }) => issue))].sort((a, b) => a - b);
  if (numbers.length === 0) return [];
  const { repository } = await github.graphql<ClosedIssueCommentsQueryResult>(closedIssueCommentsQuery(numbers), { owner: repo.owner, name: repo.name });
  return numbers.flatMap((number) => {
    const issue = repository[`issue${number}`];
    if (issue === null || issue === undefined) return [];
    const comments = issue.comments.nodes.map(({ url, author, body, createdAt }) => ({ url, author: loginOf(author), byBot: author?.__typename === "Bot", body, at: createdAt }));
    return [{ issue: number, comments }];
  });
}

/**
 * The comments as the Weekly summary's mapping gives them, each with its id
 * and, when GitHub records one, the last edit of its body (#655), from the
 * same nodes, in the same order.
 */
function withIds(comments: readonly CommentFacts[], nodes: readonly RawHomeComment[]): CommentFacts[] {
  return comments.map((comment, at) => {
    const { databaseId: id, lastEditedAt } = nodes[at] ?? {};
    return { ...comment, ...(typeof id === "number" ? { id } : {}), ...(typeof lastEditedAt === "string" ? { bodyEditedAt: lastEditedAt } : {}) };
  });
}

/** A pull request as the Weekly summary's mapping reads it: its reviews with no line comments, which this gather never asks for. */
function withoutLineComments(pullRequest: RawHomePullRequest) {
  return { ...pullRequest, reviews: { nodes: pullRequest.reviews.nodes.map((review) => ({ ...review, comments: { nodes: [] } })) } };
}
