// The rows (#618): one Product repo's Standings, each with what a reader shows
// beside it, worked out from a gather's facts (./gather.ts), the runs in
// flight and the Required checks, either of which may be unread, at a time.
// Every row's Standing is the Standing rule's own (src/kit/standing.ts) for
// those facts, so a reader holds no rule of its own. Pure, no I/O, and plain
// data: written as JSON and read back a row is equal.
import type { RunInFlightFact } from "../github/snapshot.ts";
import { type Standing, type StandingFacts, standingsOf } from "../kit/standing.ts";
import type { CommentFacts, GitHubFacts, RequiredChecksFact } from "../kit/weeklySummary.ts";
import { isHeldLine } from "../loop/heldLine.ts";
import type { Facts } from "./gather.ts";
import { type RequiredChecksRead, requiredChecksFactOf } from "./requiredChecks.ts";
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
}

/** The runs in flight, as the Standing rule reads them (Spec: Standing), or unread. */
type RowsRuns = readonly RunInFlightFact[] | "unread";
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

/** The runs-in-flight fact the rule reads. */
function runsFactOf(runs: RowsRuns): readonly RunInFlightFact[] | "unread" {
  return runs;
}

/** The Required checks fact the rule reads, by head, each through requiredChecksFactOf; a head the read does not hold is unread. */
function checksFactOf(checks: RowsChecks): Readonly<Record<string, RequiredChecksFact>> {
  if (checks === null) return {};
  return Object.fromEntries(Object.keys(checks.heads).map((head) => [head, requiredChecksFactOf(checks, head)]));
}

/**
 * A row with every field but the Standing, its title and its last word at
 * its empty default: nothing related, mentioned or followed up.
 */
export function bareRowOf(standing: Standing, title: string, lastWord: Row["lastWord"]): Row {
  return { standing, title, lastWord, related: [], mentions: [], relatedTo: null, followUps: [] };
}

/** A Standing's row, with its title and the Fabrik App's last word on the work. */
function rowOf(standing: Standing, facts: Facts): Row {
  return { ...bareRowOf(standing, titleOf(standing, facts.github), lastWordOf(standing, facts)) };
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
