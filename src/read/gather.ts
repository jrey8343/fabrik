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
// that name them; and, for the Promote list and for Live counted from the
// production Deployment (#857), the Plain pull requests merged to the default
// branch since that start, how many merged since it in all, and the agent
// pull requests a production Deployment took in the last 24 hours. A repo
// that declares none is asked what it ever was.
// The rows are worked out from its facts by ./rows.ts, and the Promote list
// by ./promoteList.ts.
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
import type { PromotedFacts } from "../kit/standingStaging.ts";
import type { TrialFacts, TrialProblemFacts } from "../kit/trialResult.ts";
import type { CommentFacts, GitHubFacts, RepoKitFacts } from "../kit/weeklySummary.ts";
import { sameRepo } from "../loop/blockers.ts";
import { AUDIT_LABEL, MAP_LABEL, REPLAY_LABEL, RETRO_LABEL, TRIAL_LABELS } from "../loop/labels.ts";
import { type FollowUpsOpened, trialProblemIn } from "../loop/markers.ts";
import type { FollowUp } from "../loop/verdict.ts";
import { CALLER_PATH } from "../setup/shims.ts";
import {
  type ClosedIssueCommentsQueryResult,
  closedIssueCommentsQuery,
  deploymentsQuery,
  MERGED_PULL_REQUESTS_QUERY,
  MERGED_SINCE_COUNT_QUERY,
  type MergedCommentsQueryResult,
  mergedCommentsQuery,
  type MergedPullRequestsQueryResult,
  OPEN_ISSUES_QUERY,
  type RawHomeComment,
  OPEN_PULL_REQUESTS_QUERY,
  type RawCountedPullRequest,
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
import { mergedFollowUpsOf } from "./related.ts";
import { gatherStore, type StoreFacts } from "./store.ts";

/** How far back the merged agent pull requests reach: as long as a merged one stands. */
const MERGED_REACH_MS = MERGED_STANDS_HOURS * 60 * 60 * 1000;

/** How long GitHub keeps a Deployment's statuses, all but its current one: 90 days. */
const STATUSES_KEPT_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * How many merged pull requests a gather keeps past the last day, in a repo
 * that declares `staging`: the most recent merges since the Promote list's
 * start, agent and Plain together, and, in the room those leave, of what a
 * production Deployment took in the last 24 hours. The one cap: the
 * Standings of those production has not taken and the Promote list's
 * entries, with its counts (./promoteList.ts), are all of this one set.
 */
export const MERGES_KEPT = 100;

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
 * A Deployment a gather cuts the merged pull requests at, in a repo that
 * declares `staging`: those merged after its commit came after it, and
 * those merged up to it are what it took. As Facts' `staging.since` it is
 * where the reach past the last day starts (#856): the newest successful
 * Deployment in production's environment, or, where none has ever succeeded
 * or Kit config names no such environment, the first successful Deployment
 * in `staging.environment`, which is where the Promote list starts
 * (./promoteList.ts, #857). The gather also cuts at each production
 * Deployment of the last day, and at the one before them (StagingReach).
 */
export interface DeploymentCut {
  /** Which environment's Deployment it is. */
  readonly from: "production" | "staging";
  /** GitHub's id of that Deployment, or null where it gives none. */
  readonly deployment: number | null;
  /** The commit it deployed. */
  readonly commit: string;
  /**
   * The time the merges are cut at, ISO 8601, which is not when it deployed
   * (`deployedAt`): when that commit was committed, as a commit on the
   * default branch holds every merge before it; the Deployment's creation
   * where GitHub gives no commit, or dates it later than that. A cut by
   * time, not by what the commit contains: a Deployments read of production
   * says that of each merge.
   */
  readonly cutAt: string;
  /**
   * When that Deployment succeeded, ISO 8601 (#857); its creation where
   * GitHub no longer says when, having deleted the status that did, as it
   * does after 90 days to all but a Deployment's current one.
   */
  readonly deployedAt: string;
}

/**
 * A Plain pull request merged to the default branch, as the gather keeps one
 * merged since the Promote list's start (#857): what the list names it by,
 * and what its kind is told from (plainKindOf). It has no Standing past its
 * merge, at Staging or anywhere.
 */
export interface MergedPlainFacts {
  readonly number: number;
  readonly title: string;
  /** ISO 8601. */
  readonly mergedAt: string;
  /** Who opened it, a bot's login ending `[bot]`. */
  readonly author: string;
  /** The branch it was merged from. */
  readonly headRef: string;
  /** The issues of its repo GitHub records it as closing. */
  readonly closes: readonly number[];
}

/**
 * What a gather reads past the last day in a repo whose Kit config declares
 * `staging` (#856, ADR-0038): the merged pull requests production has not
 * taken, what a Staging trial's result is read from, and those a production
 * Deployment took in the last 24 hours (#857).
 */
export interface StagingFacts {
  /** Where the reach starts; null when no Deployment it could start at has succeeded, and nothing past the last day is kept. */
  readonly since: DeploymentCut | null;
  /**
   * The agent pull requests merged since then, which that Deployment's
   * commit does not hold, newest first: those among the 100 most recent
   * merges of either kind since the start, so with `plain` 100 at most, and
   * together exactly what the Promote list holds. One merged in the last 24
   * hours is in `mergedLastDay` too.
   */
  readonly unpromoted: readonly MergedLastDayFacts[];
  /**
   * The agent pull requests a production Deployment took in the last 24
   * hours, newest first, each with the first such Deployment whose commit
   * holds it (#857): those merged up to that Deployment's commit and after
   * the commit of the newest production Deployment that succeeded before the
   * last 24 hours, or, where there is none, of the first successful staging
   * Deployment. As many, the most recent, as `unpromoted` and `plain` leave
   * of the 100 a gather keeps. None where production's newest success is
   * older than 24 hours, or nothing says how far back what it took reaches. One merged in the last 24 hours is in
   * `mergedLastDay` too.
   */
  readonly promoted: readonly PromotedFacts[];
  /**
   * The Plain pull requests merged to the default branch since the start,
   * newest first (#857): those among the 100 most recent merges of either
   * kind, as `unpromoted` holds the agent ones among them. Only the Promote
   * list reads them.
   */
  readonly plain: readonly MergedPlainFacts[];
  /**
   * How many pull requests merged since the start, by the same cut (#857):
   * every agent one, and every Plain one merged to the default branch,
   * however many of them the facts keep. 0 with no start.
   */
  readonly mergedSince: number;
  /**
   * What the trial result rule reads (src/kit/trialResult.ts): the label
   * events of every merged pull request the gather read, agent or Plain, and
   * the issues each closes; and each issue of the repo whose body carries
   * the Trial problem's line, that GitHub cross-references to one of them or
   * that one of them closes.
   */
  readonly trials: TrialFacts;
  /** The evidence marker of each of `unpromoted` and `promoted` that has one, as `evidenceMarkers` holds an open or newly merged pull request's. */
  readonly evidenceMarkers: readonly EvidenceMarkerFacts[];
  /** The shots marker of each of `unpromoted` and `promoted` that has one, as `shotsMarkers` holds an open or newly merged pull request's. */
  readonly shotsMarkers: readonly ShotsMarkerFacts[];
}

/**
 * What a merged agent pull request's comments say of its Follow-ups (#885,
 * mergedFollowUpsOf in ./related.ts): in `named`, those its last Verdict
 * named, a pass, each with its kind, then each fault only an earlier pass
 * named that the Kit's comment at the merge records; and in `opened`, each
 * fault the Kit opened as an issue when it merged, with the issue, as that
 * comment records.
 */
export interface MergedFollowUpsFacts {
  readonly pullRequest: number;
  readonly named: readonly FollowUp[];
  readonly opened: FollowUpsOpened["opened"];
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
   * What the comments of each agent pull request merged in the last 24 hours
   * say of its Follow-ups (#885), for each that says of one: empty
   * in a repo with none, which no query is made for. No such key in facts
   * kept from an earlier release.
   */
  readonly mergedFollowUps: readonly MergedFollowUpsFacts[];
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
    gatherMerged(github, repo, kit.config.ok ? kit.config.config : null, kit.branch, now),
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
    mergedFollowUps: await gatherMergedFollowUps(github, repo, mergedLastDay.map(({ number }) => number)),
    ticketStates: agent.flatMap(({ closingIssuesReferences }) => {
      // The Ticket is the first issue an agent pull request closes, as the Weekly summary's mapping takes it.
      const ticket = closingIssuesReferences.nodes[0];
      return ticket?.state === undefined ? [] : [{ ticket: ticket.number, closed: ticket.state === "CLOSED" }];
    }),
    evidenceMarkers: markersIn([...agent, ...mergedLastDay], appLogin, evidenceMarkerIn),
    shotsMarkers: markersIn([...agent, ...mergedLastDay], appLogin, shotsMarkerIn),
    // No such key in a repo that declares no `staging`: its facts are what they were.
    ...(merged.staging === null ? {} : { staging: stagingFactsOf(merged.staging, repo, kit.branch, appLogin) }),
  };
}

/**
 * The marker `read` finds in the body of each of these pull requests that
 * has one, with its pull request: an open one's, a newly merged one's or one
 * kept past the last day alike. A marker counts only in a body the Fabrik
 * App wrote, as the Kit's other readers of it take it.
 */
function markersIn<Marker>(
  pullRequests: readonly Pick<RawMergedPullRequest, "number" | "body" | "author">[],
  appLogin: string | null,
  read: (body: string) => Marker | null,
): { readonly pullRequest: number; readonly marker: Marker }[] {
  return pullRequests.flatMap(({ number, body, author }) => {
    const marker = byAppOf(author, appLogin) ? read(body) : null;
    return marker === null ? [] : [{ pullRequest: number, marker }];
  });
}

/** A merged agent pull request as the facts keep it: its Ticket the first issue it closes. */
function mergedFactsOf({ number, title, closingIssuesReferences, mergeCommit, mergedAt }: Pick<RawMergedPullRequest, "number" | "title" | "mergeCommit"> & { readonly mergedAt: string; readonly closingIssuesReferences: { readonly nodes: readonly { readonly number?: number }[] } }): MergedLastDayFacts {
  return { number, title, ticket: closingIssuesReferences.nodes[0]?.number ?? null, mergeCommit: mergeCommit?.oid ?? null, mergedAt };
}

/**
 * How far a gather reaches past the last day, in a repo that declares
 * `staging`: where the Promote list starts, and, where production was
 * deployed in the last 24 hours, the Deployments that took what merged
 * before that start (#857).
 */
interface StagingReach {
  /** Where the reach starts (DeploymentCut): the Promote list's start. Null when no Deployment it could start at has succeeded. */
  readonly since: DeploymentCut | null;
  /**
   * The production Deployments that succeeded in the last 24 hours, oldest
   * first, `since` the newest of them: each took what had merged up to its
   * commit. None where production's newest success is older than that, or
   * the reach starts at a staging Deployment.
   */
  readonly recent: readonly DeploymentCut[];
  /**
   * Where what those took starts: the newest production Deployment that
   * succeeded before the last 24 hours, or, where there is none, the first
   * successful staging one. Null with none of `recent`, or where nothing
   * says how far back what they took reaches.
   */
  readonly before: DeploymentCut | null;
}

/** The merged pull requests a gather read: every one, for the last day's; and, in a repo that declares `staging`, how far its reach past the last day goes, those read to it, and how many merged since its start. */
interface GatheredMerged {
  readonly pullRequests: readonly (RawMergedPullRequest | RawUnpromotedPullRequest)[];
  readonly staging: { readonly reach: StagingReach; readonly pullRequests: readonly RawUnpromotedPullRequest[]; readonly mergedSince: number } | null;
}

/**
 * The merged pull requests of `repo`, whose default branch is `branch`. With
 * no valid Kit config that declares `staging`, the one page of the
 * newest-updated the gather has ever read, and nothing more. In a repo that
 * declares it (#856), first how far the reach goes (gatherStagingReach),
 * then the merged pull requests newest-updated first, a page at a time,
 * until a page reaches back past that and the last 24 hours: a pull request
 * is updated no earlier than it merged, so none merged since is on a later
 * page. Once it holds the 100 merges it keeps (MERGES_KEPT), agent and
 * Plain together, it stops at the first page whose oldest update is before
 * the hundredth's merge, as no later page can hold one of the 100 most
 * recent.
 *
 * It also counts the pull requests merged since the start (#857): from the
 * pages it read where they reach the start, and, where they stopped at the
 * 100 short of it, from a second read that asks only what the count needs
 * (MERGED_SINCE_COUNT_QUERY), a hundred at a time back to the start.
 */
async function gatherMerged(github: Pick<ReadClient, "graphql">, repo: Repo, config: KitConfig | null, branch: string, now: string): Promise<GatheredMerged> {
  if (config === null || config.staging === null) {
    const { repository } = await github.graphql<MergedPullRequestsQueryResult>(MERGED_PULL_REQUESTS_QUERY, { owner: repo.owner, name: repo.name });
    return { pullRequests: repository.pullRequests.nodes, staging: null };
  }
  const reach = await gatherStagingReach(github, repo, config.production?.environment ?? null, config.staging.environment, now);
  const { since } = reach;
  const dayAgo = Date.parse(now) - MERGED_REACH_MS;
  const back = Math.min(dayAgo, ...[since, reach.before].flatMap((start) => (start === null ? [] : [Date.parse(start.cutAt)])));
  const kept: number[] = [];
  // Where the pages stopped at the 100 they keep: the hundredth's merge.
  const stopped: { at: number | null } = { at: null };
  const pullRequests = await pagesOf<RawUnpromotedPullRequest>(github, UNPROMOTED_PULL_REQUESTS_QUERY, repo, {}, (data) => data.repository.pullRequests, (page) => {
    const oldest = Math.min(...page.map(({ updatedAt }) => Date.parse(updatedAt)));
    if (oldest < back) return true;
    kept.push(...page.filter((pullRequest) => isMergedSince(pullRequest, since, branch) || takenBy(pullRequest, reach) !== null).map(({ mergedAt }) => Date.parse(mergedAt ?? "")));
    const hundredth = kept.toSorted((a, b) => b - a)[MERGES_KEPT - 1];
    if (hundredth === undefined || oldest >= Math.min(hundredth, dayAgo)) return false;
    stopped.at = hundredth;
    return true;
  });
  // A pull request not read was last updated, so merged, before the hundredth merged: the pages fall short of the start only where that is after it.
  const mergedSince =
    since !== null && stopped.at !== null && stopped.at > Date.parse(since.cutAt)
      ? await countMergedSince(github, repo, since, branch)
      : pullRequests.filter((pullRequest) => isMergedSince(pullRequest, since, branch)).length;
  return { pullRequests, staging: { reach, pullRequests, mergedSince } };
}

/** What the gather reads of a merged pull request to say whether it merged since a start. */
type MergedSinceRead = Pick<RawUnpromotedPullRequest, "mergedAt" | "headRefName" | "baseRefName" | "author" | "mergeCommit">;

/** Whether a pull request merged after the commit `start` deployed, and not as that commit: by time, as a commit on the default branch holds every merge before it. */
function mergedAfter({ mergedAt, mergeCommit }: Pick<MergedSinceRead, "mergedAt" | "mergeCommit">, start: DeploymentCut): boolean {
  return mergedAt !== null && Date.parse(mergedAt) > Date.parse(start.cutAt) && mergeCommit?.oid !== start.commit;
}

/** Whether a merged pull request is an agent one production has not taken: merged after the commit the reach starts at, and not as that commit. */
function isUnpromoted(pullRequest: MergedSinceRead, since: DeploymentCut | null): boolean {
  return since !== null && isAgent(pullRequest) && mergedAfter(pullRequest, since);
}

/**
 * Whether a pull request merged since the Promote list's start, to count
 * (#857): an agent one production has not taken, or a Plain one merged to
 * the default branch after the start's commit. A Plain one merged into
 * another branch reaches production only through that branch's own merge.
 */
function isMergedSince(pullRequest: MergedSinceRead, since: DeploymentCut | null, branch: string): boolean {
  return since !== null && mergedAfter(pullRequest, since) && (isAgent(pullRequest) || pullRequest.baseRefName === branch);
}

/**
 * The production Deployment that took an agent pull request in the last 24
 * hours (#857): the first of those that succeeded then whose commit holds
 * its merge, by the same cut by time. Null for one production has not
 * taken, one that merged before those Deployments' reach starts, and
 * wherever no production Deployment succeeded in the last 24 hours.
 */
function takenBy(pullRequest: MergedSinceRead, { since, recent, before }: StagingReach): DeploymentCut | null {
  if (before === null || !isAgent(pullRequest) || isUnpromoted(pullRequest, since) || !mergedAfter(pullRequest, before)) return null;
  return recent.find((deployment) => !mergedAfter(pullRequest, deployment)) ?? null;
}

/**
 * How many pull requests merged since `since` (isMergedSince), read
 * newest-updated first, a hundred at a time, until a page reaches back past
 * the start: none merged since is on a later page.
 */
async function countMergedSince(github: Pick<ReadClient, "graphql">, repo: Repo, since: DeploymentCut, branch: string): Promise<number> {
  const start = Date.parse(since.cutAt);
  const read = await pagesOf<RawCountedPullRequest>(github, MERGED_SINCE_COUNT_QUERY, repo, {}, (data) => data.repository.pullRequests, (page) =>
    page.some(({ updatedAt }) => Date.parse(updatedAt) < start),
  );
  return read.filter((pullRequest) => isMergedSince(pullRequest, since, branch)).length;
}

/**
 * How far the reach past the last day goes (StagingReach). It starts at the
 * newest Deployment in `production` that succeeded, read newest first; or,
 * where Kit config names no such environment or none there has succeeded, at
 * the first in `staging` that did, read oldest first; null with neither.
 *
 * Where production's newest success is of the last 24 hours before `now`
 * (#857), its Deployments are read on to the newest that succeeded before
 * then, which is where what the last day's took starts; with none, that is
 * the first successful staging Deployment. Each is read a page at a time, no
 * further than it needs: where production's newest success is older than 24
 * hours, no further than that one.
 *
 * GitHub deletes a Deployment's statuses after 90 days, all but its current
 * one, and makes a success `inactive` when a later deploy succeeds. So the
 * newest success keeps its `success` whatever its age, and one that old and
 * superseded reads as `inactive` alone. A Deployment that shows `inactive`
 * and no `success` is therefore read by its age (succeededLongAgo): created
 * more than 90 days ago, it is taken for a success whose status GitHub
 * deleted; younger, it would still show a success it had, so it never
 * succeeded and is passed over, as the Deployments read passes it over
 * (stateOf, ./deployments.ts). The first staging Deployment that succeeded
 * is the first that shows `success` or is taken for one, where the start at
 * production must still say `success`. A production Deployment taken for
 * one, older than the start, succeeded before the last 24 hours, so nothing
 * it took is given to a later Deployment.
 */
async function gatherStagingReach(github: Pick<ReadClient, "graphql">, repo: Repo, production: string | null, staging: string, now: string): Promise<StagingReach> {
  const has = ({ statuses }: RawGatheredDeployment, state: string) => (statuses?.nodes ?? []).some((status) => status.state === state);
  /** When it succeeded: its earliest `success`, or null where it shows none. */
  const succeededAt = ({ statuses }: RawGatheredDeployment): string | null => {
    const times = (statuses?.nodes ?? []).flatMap(({ state, createdAt }) => (state === "SUCCESS" ? [createdAt] : []));
    return times.toSorted((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  };
  /** Whether it shows `inactive` and no `success`, and is old enough for GitHub to have deleted its `success`. */
  const succeededLongAgo = (deployment: RawGatheredDeployment) =>
    has(deployment, "INACTIVE") && !has(deployment, "SUCCESS") && Date.parse(deployment.createdAt) < Date.parse(now) - STATUSES_KEPT_MS;
  const startOf = (from: DeploymentCut["from"], deployment: RawGatheredDeployment): DeploymentCut => {
    // A commit dated after its own Deployment has a wrong date: the creation is then the later bound.
    const committed = deployment.commit?.committedDate ?? deployment.createdAt;
    const cutAt = Date.parse(committed) <= Date.parse(deployment.createdAt) ? committed : deployment.createdAt;
    return { from, deployment: deployment.databaseId, commit: deployment.commitOid, cutAt, deployedAt: succeededAt(deployment) ?? deployment.createdAt };
  };
  const firstOnStaging = async (): Promise<DeploymentCut | null> => {
    const succeeded = (deployment: RawGatheredDeployment) => has(deployment, "SUCCESS") || succeededLongAgo(deployment);
    const read = await pagesOf<RawGatheredDeployment>(github, deploymentsQuery("ASC"), repo, { environment: staging }, (data) => data.repository.deployments, (page) => page.some(succeeded));
    const first = read.find(succeeded);
    return first === undefined ? null : startOf("staging", first);
  };
  if (production !== null) {
    const dayAgo = Date.parse(now) - MERGED_REACH_MS;
    const settled = (deployment: RawGatheredDeployment) => {
      const at = succeededAt(deployment);
      return at === null ? succeededLongAgo(deployment) : Date.parse(at) < dayAgo;
    };
    // Read on from the newest success to the first that succeeded before the last 24 hours, which may be the same one.
    let found = false;
    const read = await pagesOf<RawGatheredDeployment>(github, deploymentsQuery("DESC"), repo, { environment: production }, (data) => data.repository.deployments, (page) =>
      page.some((deployment) => {
        found ||= has(deployment, "SUCCESS");
        return found && settled(deployment);
      }),
    );
    const newest = read.find((deployment) => has(deployment, "SUCCESS"));
    if (newest !== undefined) {
      const since = startOf("production", newest);
      const recent: DeploymentCut[] = [];
      for (const deployment of read.slice(read.indexOf(newest))) {
        if (settled(deployment)) return { since, recent, before: recent.length === 0 ? null : startOf("production", deployment) };
        if (has(deployment, "SUCCESS")) recent.unshift(startOf("production", deployment));
      }
      return { since, recent, before: recent.length === 0 ? null : await firstOnStaging() };
    }
  }
  return { since: await firstOnStaging(), recent: [], before: null };
}

/**
 * What the gather keeps past the last day (StagingFacts), from the merged
 * pull requests it read: the 100 most recent merges of either kind since the
 * start (MERGES_KEPT), newest first, the agent ones, which production has
 * not taken, apart from the Plain ones; in the room those leave of the 100,
 * the agent ones a production Deployment took in the last 24 hours, newest
 * first; the markers of each agent one kept; of every one read, agent or
 * Plain, its label events on the two trial labels and the issues of the repo
 * it closes, where it has either; and each Trial problem among the issues
 * cross-referenced to one whose line names it, or closed by one, lowest
 * first.
 */
function stagingFactsOf({ reach, pullRequests, mergedSince }: NonNullable<GatheredMerged["staging"]>, repo: Repo, branch: string, appLogin: string | null): StagingFacts {
  const { since } = reach;
  const here = `${repo.owner}/${repo.name}`;
  const ofThisRepo = ({ repository }: RawTrialIssue) => repository === undefined || sameRepo(repository.nameWithOwner, here);
  const closedBy = ({ closingIssuesReferences }: RawUnpromotedPullRequest) => closingIssuesReferences.nodes.flatMap((issue) => (issue.number !== undefined && ofThisRepo(issue) ? [issue.number] : []));
  const merged = pullRequests
    .flatMap((pullRequest) => (pullRequest.mergedAt === null ? [] : [{ ...pullRequest, mergedAt: pullRequest.mergedAt }]))
    .toSorted((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt) || b.number - a.number);
  const sinceStart = merged.filter((pullRequest) => isMergedSince(pullRequest, since, branch)).slice(0, MERGES_KEPT);
  const unpromoted = sinceStart.filter((pullRequest) => isAgent(pullRequest));
  const plain = sinceStart.filter((pullRequest) => !isAgent(pullRequest));
  const promoted = merged.flatMap((pullRequest) => {
    const by = takenBy(pullRequest, reach);
    return by === null ? [] : [{ pullRequest, by: { deployment: by.deployment, commit: by.commit, at: by.deployedAt } }];
  }).slice(0, MERGES_KEPT - sinceStart.length);
  const kept = [...unpromoted, ...promoted.map(({ pullRequest }) => pullRequest)];
  const problems = new Map<number, TrialProblemFacts>();
  for (const { number, crossReferences, closingIssuesReferences } of pullRequests) {
    const named = crossReferences.nodes.flatMap(({ source }) => (source?.__typename === "Issue" && ofThisRepo(source) ? trialProblemOf(source, number) : []));
    const closed = closingIssuesReferences.nodes.flatMap((issue) => (ofThisRepo(issue) ? trialProblemOf(issue, null) : []));
    for (const problem of [...named, ...closed]) if (!problems.has(problem.issue)) problems.set(problem.issue, problem);
  }
  return {
    since,
    unpromoted: unpromoted.map(mergedFactsOf),
    promoted: promoted.map(({ pullRequest, by }) => ({ ...mergedFactsOf(pullRequest), by })),
    plain: plain.map((pullRequest) => ({ number: pullRequest.number, title: pullRequest.title, mergedAt: pullRequest.mergedAt, author: loginOf(pullRequest.author), headRef: pullRequest.headRefName, closes: closedBy(pullRequest) })),
    mergedSince,
    trials: {
      pullRequests: pullRequests.flatMap((pullRequest) => {
        const labelEvents = labelEventsOf(pullRequest.timelineItems.nodes).filter(({ label }) => (TRIAL_LABELS as readonly string[]).includes(label));
        const closes = closedBy(pullRequest);
        return labelEvents.length === 0 && closes.length === 0 ? [] : [{ pullRequest: pullRequest.number, labelEvents, closes }];
      }),
      problems: [...problems.values()].toSorted((a, b) => a.issue - b.issue),
    },
    evidenceMarkers: markersIn(kept, appLogin, evidenceMarkerIn),
    shotsMarkers: markersIn(kept, appLogin, shotsMarkerIn),
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
 * What the comments of each of these merged agent pull requests say of its
 * Follow-ups (#885), lowest number first, for each that says of
 * one: one query for them all, by number, each one's latest comments, and
 * none at all with no such pull request, so a repo where nothing merged in
 * the last day pays nothing. One GitHub no longer has is left out.
 */
async function gatherMergedFollowUps(github: ReadClient, repo: Repo, pullRequests: readonly number[]): Promise<MergedFollowUpsFacts[]> {
  const numbers = [...new Set(pullRequests)].sort((a, b) => a - b);
  if (numbers.length === 0) return [];
  const { repository } = await github.graphql<MergedCommentsQueryResult>(mergedCommentsQuery(numbers), { owner: repo.owner, name: repo.name });
  return numbers.flatMap((number) => {
    const pullRequest = repository[`pullRequest${number}`];
    if (pullRequest === null || pullRequest === undefined) return [];
    const read = mergedFollowUpsOf(number, pullRequest.comments.nodes.map(({ body, author }) => ({ body, byBot: author?.__typename === "Bot" })));
    return read === null ? [] : [read];
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
