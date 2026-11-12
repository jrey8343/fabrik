// The rows (#618): one Product repo's Standings, each with what a reader shows
// beside it, worked out from a gather's facts (./gather.ts), the runs in
// flight from the last runs read, the Required checks and the Deployments of
// the last day's merges (#634), any of which may be unread, at a time.
// Every row's Standing is the Standing rule's own (src/kit/standing.ts) for
// those facts, so a reader holds no rule of its own. Pure, no I/O, and plain
// data: written as JSON and read back a row is equal.
import type { CaptureFailure } from "../evidence/uiEvidence.ts";
import type { RunInFlightFact } from "../github/snapshot.ts";
import { withRouteOn } from "../kit/config.ts";
import { pairedOwnStandingsOf, type Standing, type StandingFacts, standingsOf } from "../kit/standing.ts";
import { plainSinceOf } from "../kit/standingPlain.ts";
import type { CommentFacts, GitHubFacts, RequiredChecksFact } from "../kit/weeklySummary.ts";
import { isHeldLine } from "../loop/heldLine.ts";
import type { Facts } from "./gather.ts";
import { followUpsOf, mentionsOf, relatedOf, relatedToOf } from "./related.ts";
import { type RequiredChecksRead, requiredChecksFactOf } from "./requiredChecks.ts";
import { type RunsRead, runsInFlightFactOf } from "./runs.ts";
import { type StoreFacts, storeRowsOf } from "./store.ts";
import type { DeploymentsRead } from "./deployments.ts";

/** One Standing, with what a reader shows beside it. */
export interface Row {
  readonly standing: Standing;
  /** The issue's title, or the pull request's for a Plain one with no issue. */
  readonly title: string;
  /** The Fabrik App's latest comment on the issue or its pull request, never a held line: how a finished run's summary reaches a reader. Null when it has said nothing there. */
  readonly lastWord: { readonly text: string; readonly at: string; readonly url: string } | null;
  /** On a pull request's row: the issues that could still be rolled in to it. */
  readonly related: readonly { readonly issue: number; readonly title: string; readonly kind: "candidate" }[];
  /** On a pull request's row: the open issues that only mention it. */
  readonly mentions: readonly { readonly issue: number; readonly title: string }[];
  /** On an issue's row: the pull request it could be rolled in to, or null. */
  readonly relatedTo: number | null;
  /** On a pull request's row: each Follow-up its pass named, and the issue it was filed as, or null. */
  readonly followUps: readonly { readonly title: string; readonly body: string; readonly filedAs: number | null }[];
  /**
   * On an open agent pull request's row, at the Merge gate and in draft
   * alike: whether its Ticket is closed, "unknown" when it names no Ticket or
   * its Ticket could not be read. Null on any other row. Closing a Ticket
   * closes only its draft pull requests, so one at the Merge gate can stand
   * with its Ticket closed.
   */
  readonly ticketClosed: "yes" | "no" | "unknown" | null;
  /**
   * On a row whose name hangs on an open Plain pull request's Required checks,
   * that pull request's own or a Pairing session's joined to its issue's: what
   * the join with checks needs to settle the row as the rule does. `since` is
   * when the pull request came to stand as it is, the latest of its head, its
   * opening and its last draft change (plainSinceOf), the time the rule gives
   * it when no report of its checks decides its name. `own`, on a Pairing
   * session's row, is the issue's own Standing the pull request is joined to,
   * as the rule gives it before the join (pairedOwnStandingsOf): what the row
   * goes back to, carrying the pull request's name, once the pull request
   * that took it over as yours to merge no longer is; null on any other.
   * Null on any other row.
   */
  readonly plainPullRequest: { readonly since: string; readonly own: Standing | null } | null;
  /**
   * On a row whose agent pull request, open or merged in the last 24 hours,
   * carries the evidence marker the Kit writes on a UI pull request: where
   * its UI evidence is kept, how its capture ended, what came of its preview
   * and a page for each captured route. Null on any other row, so a pull
   * request that is not UI has none. An artifact's expiry is not here: it is
   * read from GitHub by whoever fetches it.
   */
  readonly evidence: RowEvidence | null;
}

/** An agent pull request's UI evidence, as its evidence marker records it. */
export interface RowEvidence {
  /** The Actions run whose Implement job captured it. */
  readonly run: number;
  /** The id of that run's artifact holding the screenshots and the capture result, or null when it kept none. */
  readonly artifact: number | null;
  /** Why its capture failed, or null when it captured or the marker does not say. */
  readonly failure: CaptureFailure | null;
  /** What came of the preview deployment: `unknown` from a marker an earlier release wrote, or whose preview doesn't read. */
  readonly preview: "none" | "pending" | "linked" | "never-answered" | "unknown";
  /**
   * One for each captured route, in the marker's order, with the address of
   * its page on the preview when the preview was linked, else null. Null from
   * a marker an earlier release wrote, which records no routes.
   */
  readonly pages: readonly { readonly route: string; readonly preview: string | null }[] | null;
}

/** The last runs read (./runs.ts), or null when none is held. */
type RowsRuns = RunsRead | null;
/** The last Required checks read, or null when none was made: every head is then unread. */
type RowsChecks = RequiredChecksRead | null;
/** The last Deployments read, or null when none was made: every merge's deploys are then unread. */
type RowsDeployments = DeploymentsRead | null;

/**
 * One Product repo's rows at `now`, ISO 8601: one for each Standing the rule
 * gives for `facts`, with these runs in flight, Required checks and
 * Deployments, in the rule's order; an agent pull request merged in the last
 * 24 hours has one in a repo that declares `production`. The store's rows,
 * for the store's facts, are its own rule's (./store.ts), which reads no run,
 * no check and no deploy.
 */
export function rowsOf(
  facts: Facts | StoreFacts,
  runs: RowsRuns,
  checks: RowsChecks,
  deployments: RowsDeployments,
  now: string,
): Row[] {
  if (facts.kind === "store") return storeRowsOf(facts, now);
  const ruleFacts = ruleFactsOf(facts, runsFactOf(runs), checksFactOf(checks), deployments);
  const standings = standingsOf(ruleFacts, now);
  // Worked out only when a Pairing session's pull request was joined to its issue's own Standing.
  const owns = standings.some(({ detail }) => detail.pullRequest !== undefined) ? pairedOwnStandingsOf(ruleFacts, now) : new Map<number, Standing>();
  return standings.map((standing) => rowOf(standing, facts, owns));
}

/** The runs-in-flight fact the rule reads, through the runs read's one converter: unread with no read held. */
function runsFactOf(runs: RowsRuns): readonly RunInFlightFact[] | "unread" {
  return runs === null ? "unread" : runsInFlightFactOf(runs);
}

/** The Required checks fact the rule reads, by head, each through requiredChecksFactOf; a head the read does not hold is unread. */
function checksFactOf(checks: RowsChecks): Readonly<Record<string, RequiredChecksFact>> {
  if (checks === null) return {};
  return Object.fromEntries(Object.keys(checks.heads).map((head) => [head, requiredChecksFactOf(checks, head)]));
}

/**
 * A row with every field but the Standing, its title and its last word at
 * its empty default: nothing related, mentioned or followed up, and no
 * Ticket's state.
 */
export function bareRowOf(standing: Standing, title: string, lastWord: Row["lastWord"]): Row {
  return { standing, title, lastWord, related: [], mentions: [], relatedTo: null, followUps: [], ticketClosed: null, plainPullRequest: null, evidence: null };
}

/**
 * A Standing's row, with its title and the Fabrik App's last word on the
 * work; on an agent pull request's row what is related to it, what mentions
 * it, its Follow-ups and whether its Ticket is closed, and on an issue's row
 * the pull request it could be rolled in to.
 */
function rowOf(standing: Standing, facts: Facts, owns: ReadonlyMap<number, Standing>): Row {
  const { issue, pullRequest } = standing;
  return {
    ...bareRowOf(standing, titleOf(standing, facts), lastWordOf(standing, facts)),
    related: pullRequest === null ? [] : relatedOf(facts, pullRequest),
    mentions: pullRequest === null ? [] : mentionsOf(facts, pullRequest),
    followUps: pullRequest === null ? [] : followUpsOf(facts, pullRequest),
    relatedTo: issue === null ? null : relatedToOf(facts, issue),
    ticketClosed: pullRequest === null ? null : ticketClosedOf(facts, pullRequest),
    plainPullRequest: pullRequest === null ? null : plainPullRequestOf(facts, pullRequest, standing.detail.pullRequest === undefined ? null : (owns.get(pullRequest) ?? null)),
    evidence: pullRequest === null ? null : evidenceOf(facts, pullRequest),
  };
}

/** Agent pull request `pullRequest`'s UI evidence, from its evidence marker; null when the facts hold none for it. */
function evidenceOf({ evidenceMarkers }: Facts, pullRequest: number): RowEvidence | null {
  const marker = evidenceMarkers.find((held) => held.pullRequest === pullRequest)?.marker;
  if (marker === undefined) return null;
  const { run, artifact, failure, routes, preview } = marker;
  const linked = preview?.is === "linked" ? preview.url : null;
  return {
    run,
    artifact,
    failure: failure ?? null,
    preview: preview?.is ?? "unknown",
    pages: routes === undefined ? null : routes.map((route) => ({ route, preview: linked === null ? null : pageOn(linked, route) })),
  };
}

/** The page at `route` on the site at `base`, as the Kit builds every page's address; null when `base` is no address. */
function pageOn(base: string, route: string): string | null {
  try {
    return withRouteOn(base, route);
  } catch {
    return null;
  }
}

/**
 * A row's `plainPullRequest` with the issue's own Standing it carries settled
 * as a join settles the row's own Standing, so the two stay as the rule gives
 * them; the same value when that leaves it as it was.
 */
export function withOwnSettled(plainPullRequest: Row["plainPullRequest"], settle: (own: Standing) => Standing): Row["plainPullRequest"] {
  if (plainPullRequest === null || plainPullRequest.own === null) return plainPullRequest;
  const own = settle(plainPullRequest.own);
  return own === plainPullRequest.own ? plainPullRequest : { ...plainPullRequest, own };
}

/** What the join with checks needs of open Plain pull request `pullRequest`, with the issue's own Standing it is joined to; null when it is no open Plain pull request. */
function plainPullRequestOf({ github }: Facts, pullRequest: number, own: Standing | null): Row["plainPullRequest"] {
  const plain = github.plainPullRequests.find(({ number }) => number === pullRequest);
  return plain === undefined ? null : { since: plainSinceOf(plain), own };
}

/** Whether open agent pull request `pullRequest`'s Ticket is closed; null when it is no open agent pull request. */
function ticketClosedOf({ github, ticketStates }: Facts, pullRequest: number): Row["ticketClosed"] {
  const open = github.openPullRequests.find(({ number }) => number === pullRequest);
  if (open === undefined) return null;
  const state = ticketStates.find(({ ticket }) => ticket === open.ticket);
  return state === undefined ? "unknown" : state.closed ? "yes" : "no";
}

/**
 * The login the rule takes for the Fabrik App's when a reader gave the gather
 * none: every bot's login in the facts reads as it, so any bot's text is
 * taken for the App's, as the Kit job does.
 */
const ANY_BOT = "[bot]";

/** What the Standing rule reads of the repo: the gather's facts, with these runs, checks and Deployments. */
function ruleFactsOf(facts: Facts, runs: readonly RunInFlightFact[] | "unread", checks: Readonly<Record<string, RequiredChecksFact>>, deployments: RowsDeployments): StandingFacts {
  const { github, kit, operator, appLogin, mergedLastDay } = facts;
  return {
    kind: "product",
    github: appLogin === null ? anyBotAsTheApp(github) : github,
    kit: { ...kit, runsInFlight: runs, headChecks: checks },
    operator,
    appLogin: appLogin ?? ANY_BOT,
    // The gather reads no run that ended: a run's end is followed by the Kit's own write, which the facts hold.
    runsEnded: [],
    mergedLastDay,
    deployments,
  };
}

/**
 * The facts with every bot's login, as an author or an actor, read as
 * ANY_BOT. A Plain pull request's author is left as it is: its kind is told
 * from who opened it, Dependabot's apart from the App's.
 */
function anyBotAsTheApp(github: GitHubFacts): GitHubFacts {
  const walk = (value: unknown, key: string): unknown => {
    if ((key === "author" || key === "actor") && typeof value === "string" && value.endsWith("[bot]")) return ANY_BOT;
    if (Array.isArray(value)) return value.map((item) => walk(item, ""));
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).map(([field, inner]) => [field, walk(inner, field)]));
  };
  return { ...(walk(github, "") as GitHubFacts), plainPullRequests: github.plainPullRequests };
}

/** The issue's title, or the pull request's, open or merged in the last day, when the Standing has no issue the facts hold. */
function titleOf({ issue, pullRequest }: Standing, { github, mergedLastDay }: Facts): string {
  const issues = [...github.openIssues, ...github.audits, ...github.retros];
  const pullRequests = [...github.openPullRequests, ...github.plainPullRequests, ...mergedLastDay];
  const titled = issues.find(({ number }) => number === issue) ?? pullRequests.find(({ number }) => number === pullRequest);
  return titled?.title ?? "";
}

/** The Fabrik App's latest comment on the Standing's issue or its pull request, a held line never; any bot's when the App's login is not known. */
function lastWordOf({ issue, pullRequest }: Standing, { github, appLogin }: Facts): Row["lastWord"] {
  const comments: readonly CommentFacts[] = [
    ...(github.openIssues.find(({ number }) => number === issue)?.comments ?? []),
    ...(github.openPullRequests.find(({ number }) => number === pullRequest)?.comments ?? []),
  ];
  const latest = comments
    .filter(({ author, byBot, body }) => (appLogin === null ? byBot : author === appLogin) && !isHeldLine(body))
    .reduce<CommentFacts | null>((newest, comment) => (newest === null || Date.parse(comment.at) >= Date.parse(newest.at) ? comment : newest), null);
  return latest === null ? null : { text: latest.body, at: latest.at, url: latest.url };
}
