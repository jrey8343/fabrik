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
// merged in the last 24 hours, each comment's id (#639), and GitHub's record
// of an edit to each of an open pull request's comments (#655). The rows are
// worked out from its facts by ./rows.ts.
import { gatherWeeklyRunIssues, isAgent, openIssueOf, openKitIssueOf, openPullRequestOf, plainPullRequestOf } from "../github/facts.ts";
import { pagesOf, type ReadClient, type Repo, whyUnread } from "../github/client.ts";
import { leavingOutHeldLines } from "../github/heldLines.ts";
import { byAppOf, gatherDesignQueueSlice, gatherDispatchCandidates, gatherKitIssues, loginOf, readKitConfigSources } from "../github/snapshot.ts";
import { type EvidenceMarker, evidenceMarkerIn } from "../evidence/uiEvidence.ts";
import { checkCallerWorkflow, fabrikRefsIn } from "../kit/caller.ts";
import { KIT_CONFIG_PATH, type KitConfigResult, resolveKitConfig } from "../kit/config.ts";
import { RUN_STORE_REPO } from "../kit/runStore.ts";
import { MERGED_STANDS_HOURS, type MergedLastDayFacts } from "../kit/standingProduction.ts";
import type { CommentFacts, GitHubFacts, RepoKitFacts } from "../kit/weeklySummary.ts";
import { AUDIT_LABEL, MAP_LABEL, REPLAY_LABEL, RETRO_LABEL } from "../loop/labels.ts";
import { CALLER_PATH } from "../setup/shims.ts";
import {
  MERGED_PULL_REQUESTS_QUERY,
  type MergedPullRequestsQueryResult,
  OPEN_ISSUES_QUERY,
  type RawHomeComment,
  OPEN_PULL_REQUESTS_QUERY,
  type RawHomeIssue,
  type RawHomePullRequest,
  REPO_QUERY,
  type RepoQueryResult,
} from "./homeQueries.ts";
import { gatherStore, type StoreFacts } from "./store.ts";

/** How far back the merged agent pull requests reach: as long as a merged one stands. */
const MERGED_REACH_MS = MERGED_STANDS_HOURS * 60 * 60 * 1000;

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
  /** The repo the issue is in, `owner/name`. */
  readonly repo: string;
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
  /** Whether each open agent pull request's Ticket is closed; a Ticket GitHub gave no state of is not here. */
  readonly ticketStates: readonly TicketStateFacts[];
  /**
   * The evidence marker of each agent pull request the Fabrik App opened,
   * open or merged in the last 24 hours, that has one: a UI pull request's.
   */
  readonly evidenceMarkers: readonly EvidenceMarkerFacts[];
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
  const [pullRequests, issues, merged, { designQueue }, { kitIssues }, audits, retros, candidates] = await Promise.all([
    pagesOf<RawHomePullRequest>(github, OPEN_PULL_REQUESTS_QUERY, repo, {}, (data) => data.repository.pullRequests),
    pagesOf<RawHomeIssue>(github, OPEN_ISSUES_QUERY, repo, {}, (data) => data.repository.issues),
    github.graphql<MergedPullRequestsQueryResult>(MERGED_PULL_REQUESTS_QUERY, { owner: repo.owner, name: repo.name }),
    // The Design queue check's own slice: open `needs-design` issues only, so one closed in its session is in none.
    gatherDesignQueueSlice(github, null, repo, appLogin),
    gatherKitIssues(github, repo, appLogin),
    gatherWeeklyRunIssues(github, repo, AUDIT_LABEL),
    gatherWeeklyRunIssues(github, repo, RETRO_LABEL),
    // An invalid Kit config is read with the Kit's defaults, and Dispatch's candidates not at all, as the Loop does.
    kit.config.ok ? gatherDispatchCandidates(github, repo, appLogin) : Promise.resolve(null),
  ]);
  const agent = pullRequests.filter(isAgent);
  const open = issues.filter(({ state }) => state === "OPEN");
  const labelled = (label: string) => open.filter(({ labels }) => labels.nodes.some(({ name }) => name === label));
  const since = Date.parse(now) - MERGED_REACH_MS;
  const mergedLastDay = merged.repository.pullRequests.nodes.flatMap(({ mergedAt, ...pullRequest }) =>
    mergedAt === null || Date.parse(mergedAt) < since || !isAgent(pullRequest) ? [] : [{ ...pullRequest, mergedAt }],
  );
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
        const facts = openIssueOf({ ...issue, blockedBy: { nodes: [] } });
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
      retros,
      openReplays: labelled(REPLAY_LABEL).map(({ number, title, createdAt, lastEditedAt, body, author }) => ({ number, title, author: loginOf(author), createdAt, lastEditedAt, body })),
      // Oldest first, as the Map cap reads them.
      openMaps: labelled(MAP_LABEL)
        .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number)
        .map(({ number }) => number),
      kitIssues,
    },
    kit: { ...kit, dispatch: candidates === null ? null : { candidates } },
    operator,
    appLogin,
    issueBodies: open.filter(({ author }) => loginOf(author) === operator).map(({ number, body }) => ({ issue: number, body })),
    mergedLastDay: mergedLastDay.map(({ number, title, closingIssuesReferences, mergeCommit, mergedAt }) => ({
      number,
      title,
      ticket: closingIssuesReferences.nodes[0]?.number ?? null,
      mergeCommit: mergeCommit?.oid ?? null,
      mergedAt,
    })),
    crossReferences: agent.flatMap(({ number, crossReferences }) =>
      crossReferences.nodes.flatMap(({ source }) =>
        source?.__typename !== "Issue" || source.number === undefined
          ? []
          : [{ pullRequest: number, issue: source.number, title: source.title ?? "", open: source.state === "OPEN", repo: source.repository?.nameWithOwner ?? "" }],
      ),
    ),
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
  };
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
