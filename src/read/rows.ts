// The rows (#618): one Product repo's Standings, each with what a reader shows
// beside it, worked out from a gather's facts (./gather.ts), the runs in
// flight from the last runs read and the Required checks, either of which may
// be unread, at a time.
// Every row's Standing is the Standing rule's own (src/kit/standing.ts) for
// those facts, so a reader holds no rule of its own. Pure, no I/O, and plain
// data: written as JSON and read back a row is equal.
import type { RunInFlightFact } from "../github/snapshot.ts";
import { type Standing, type StandingFacts, standingsOf } from "../kit/standing.ts";
import { plainSinceOf } from "../kit/standingPlain.ts";
import type { CommentFacts, GitHubFacts, RequiredChecksFact } from "../kit/weeklySummary.ts";
import { isHeldLine } from "../loop/heldLine.ts";
import type { Facts } from "./gather.ts";
import { followUpsOf, mentionsOf, relatedOf, relatedToOf } from "./related.ts";
import { type RequiredChecksRead, requiredChecksFactOf } from "./requiredChecks.ts";
import { type RunsRead, runsInFlightFactOf } from "./runs.ts";
import { type StoreFacts, storeRowsOf } from "./store.ts";

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
   * it when no report of its checks decides its name. Null on any other row.
   */
  readonly plainPullRequest: { readonly since: string } | null;
}

/** The last runs read (./runs.ts), or null when none is held. */
type RowsRuns = RunsRead | null;
/** The last Required checks read, or null when none was made: every head is then unread. */
type RowsChecks = RequiredChecksRead | null;

/**
 * One Product repo's rows at `now`, ISO 8601: one for each Standing the rule
 * gives for `facts`, with these runs in flight and Required checks, in the
 * rule's order. The store's rows, for the store's facts, are its own rule's
 * (./store.ts), which reads no run and no check.
 */
export function rowsOf(
  facts: Facts | StoreFacts,
  runs: RowsRuns,
  checks: RowsChecks,
  now: string,
): Row[] {
  if (facts.kind === "store") return storeRowsOf(facts, now);
  const standings = standingsOf(ruleFactsOf(facts, runsFactOf(runs), checksFactOf(checks)), now);
  return standings.map((standing) => rowOf(standing, facts));
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
  return { standing, title, lastWord, related: [], mentions: [], relatedTo: null, followUps: [], ticketClosed: null, plainPullRequest: null };
}

/**
 * A Standing's row, with its title and the Fabrik App's last word on the
 * work; on an agent pull request's row what is related to it, what mentions
 * it, its Follow-ups and whether its Ticket is closed, and on an issue's row
 * the pull request it could be rolled in to.
 */
function rowOf(standing: Standing, facts: Facts): Row {
  const { issue, pullRequest } = standing;
  return {
    ...bareRowOf(standing, titleOf(standing, facts.github), lastWordOf(standing, facts)),
    related: pullRequest === null ? [] : relatedOf(facts, pullRequest),
    mentions: pullRequest === null ? [] : mentionsOf(facts, pullRequest),
    followUps: pullRequest === null ? [] : followUpsOf(facts, pullRequest),
    relatedTo: issue === null ? null : relatedToOf(facts, issue),
    ticketClosed: pullRequest === null ? null : ticketClosedOf(facts, pullRequest),
    plainPullRequest: pullRequest === null ? null : plainPullRequestOf(facts, pullRequest),
  };
}

/** What the join with checks needs of open Plain pull request `pullRequest`; null when it is no open Plain pull request. */
function plainPullRequestOf({ github }: Facts, pullRequest: number): Row["plainPullRequest"] {
  const plain = github.plainPullRequests.find(({ number }) => number === pullRequest);
  return plain === undefined ? null : { since: plainSinceOf(plain) };
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

/** What the Standing rule reads of the repo: the gather's facts, with these runs and checks. */
function ruleFactsOf(facts: Facts, runs: readonly RunInFlightFact[] | "unread", checks: Readonly<Record<string, RequiredChecksFact>>): StandingFacts {
  const { github, kit, operator, appLogin } = facts;
  return {
    kind: "product",
    github: appLogin === null ? anyBotAsTheApp(github) : github,
    kit: { ...kit, runsInFlight: runs, headChecks: checks },
    operator,
    appLogin: appLogin ?? ANY_BOT,
    // The gather reads no run that ended: a run's end is followed by the Kit's own write, which the facts hold.
    runsEnded: [],
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

/** The issue's title, or the pull request's when the Standing has no issue the facts hold. */
function titleOf({ issue, pullRequest }: Standing, github: GitHubFacts): string {
  const issues = [...github.openIssues, ...github.audits, ...github.retros];
  const pullRequests = [...github.openPullRequests, ...github.plainPullRequests];
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
