// The promote list (#857, ADR-0038): what a production deployment would
// take, in a Product repo whose Kit config declares `staging`, and which of
// it the Operator has not accepted. It is worked out from a gather's facts
// (./gather.ts) and a staging read, as the rows are (./rows.ts): every pull
// request merged to the default branch since the list's start, which is the
// newest successful production Deployment, or the first successful staging
// one where production has none. An agent pull request's entry says where
// it is at Staging through the Standing rule's own Standing for the same
// facts (stagingStandingsOf), so the list and a row can't disagree, and a
// Plain one's says only what kind it is. It is advisory: nothing here
// deploys, dispatches or refuses anything, and its dispatch page is an
// address and no more. Pure, no I/O, and plain data: written as JSON and
// read back a list is equal.
import { productionDispatchPage } from "../kit/config.ts";
import { type PlainKind, standingAt } from "../kit/standing.ts";
import { plainKindOf } from "../kit/standingPlain.ts";
import { type StagingStanding, stagingStandingsOf, type StagingTrial } from "../kit/standingStaging.ts";
import type { TrialProblemFacts } from "../kit/trialResult.ts";
import { type Facts, type MergedPlainFacts, MERGES_KEPT } from "./gather.ts";
import { ANY_BOT, evidenceOf, type RowEvidence, type RowShots, type RowStaging, ruleFactsOf, shotsOf, type StagingRead, stagingOf } from "./rows.ts";
import type { StoreFacts } from "./store.ts";

/** What a production deployment of one Product repo would take, and which of it the Operator has not accepted. */
export interface PromoteList {
  /** The repo, `owner/name`. */
  readonly repo: string;
  /**
   * Which start the list used: the newest successful production Deployment,
   * or, where no production Deployment has ever succeeded or Kit config
   * names no production environment, the first successful Deployment in
   * `staging.environment`. Null where neither has one, when the list is
   * empty. It is the start the gather found: a production Deployment that
   * succeeds later is seen at the next gather.
   */
  readonly start: PromoteStart | null;
  /**
   * Every pull request merged to the default branch that the start's
   * Deployment does not contain, agent or Plain, newest first: the 100 most
   * recent at most, which is what the gather keeps of them, by the one cap
   * both hold to (MERGES_KEPT, ./gather.ts): so its entries, the rows of
   * those production has not taken and both counts below are of one set.
   */
  readonly entries: readonly PromoteEntry[];
  /**
   * How many of `entries` are not yet accepted: each that needs a Staging
   * trial and is not accepted, whether it is untried, a problem was found on
   * it, or it is not yet on staging. A Plain pull request and one that
   * changes no screen are never counted.
   */
  readonly notAccepted: number;
  /** How many pull requests merged since the start are not in `entries`, being older than the 100 the gather keeps. */
  readonly leftOut: number;
  /**
   * GitHub's page for dispatching the workflow `production.workflow` names
   * in the repo, or null when Kit config declares none. Only an address: the
   * Kit dispatches nothing.
   */
  readonly dispatchPage: string | null;
}

/** The Deployment a promote list starts at. */
export interface PromoteStart {
  /** Which environment's Deployment it is: production's newest that succeeded, or staging's first. */
  readonly from: "production" | "staging";
  /** GitHub's id of that Deployment, or null where it gives none. */
  readonly deployment: number | null;
  /** The commit it deployed. */
  readonly commit: string;
  /** When it succeeded, ISO 8601; its creation where GitHub no longer says when, as for a staging Deployment older than 90 days. */
  readonly deployedAt: string;
}

/** One pull request a production deployment would take. */
export type PromoteEntry = PromoteAgentEntry | PromotePlainEntry;

/** An agent pull request a production deployment would take. */
export interface PromoteAgentEntry {
  readonly is: "agent";
  readonly pullRequest: number;
  readonly title: string;
  /** The Ticket it closes, or null. */
  readonly ticket: number | null;
  /** ISO 8601. */
  readonly mergedAt: string;
  /** Its UI evidence, as its row gives it (Row's `evidence`); null for one with none. */
  readonly evidence: RowEvidence | null;
  /** Its Evidence shots, as a merged pull request's row gives them (Row's `shots`); null for one with none. */
  readonly shots: RowShots | null;
  /** Where the Operator tries its change on staging, and what to try, as its row gives them (Row's `staging`). */
  readonly staging: RowStaging;
  /** Whether it needs a Staging trial, and why, as its Standing at Staging says. */
  readonly trial: StagingTrial;
  /** Its Staging trial's result, as its Standing at Staging says for the same facts. */
  readonly result: PromoteResult;
}

/**
 * A Plain pull request a production deployment would take: its kind, as the
 * Standing names an open one's, and nothing more. It has no evidence, no
 * staging pages and no claim about screens, asks for no Staging trial, and
 * has no Standing at Staging; whatever label the Operator put on it, its
 * entry has no result.
 */
export interface PromotePlainEntry {
  readonly is: "plain";
  readonly pullRequest: number;
  readonly title: string;
  /** ISO 8601. */
  readonly mergedAt: string;
  /** A Kit bump, Setup's, a Skills bump's, a Pairing session's, or any other, the Operator's own among them. */
  readonly kind: PlainKind;
}

/** One of a pull request's Trial problems, as a promote list names it. */
export interface PromoteProblem {
  readonly issue: number;
  readonly title: string;
  readonly open: boolean;
}

/** The names a merged agent pull request's Standing at Staging has before it is on staging. */
const NOT_ON_STAGING = ["merged", "deploying", "deploy-failed", "no-deploy-seen"] as const;

/**
 * An agent pull request's Staging trial result, as a promote list says it,
 * read from its Standing at Staging, the first of these that holds:
 *
 * - `accepted`, since `at`: by the Operator's own label, or, with `fix` not
 *   null, through the merged pull requests that closed its Trial problems.
 * - `problem`, since `at`, with its Trial problems; none is a problem with no
 *   issue named.
 * - `no-screen`: it changes no screen, so it needs no Staging trial and waits
 *   on nobody, on staging or not.
 * - `not-on-staging`: it needs a Staging trial and can't have one yet, with
 *   the Standing's name that says why: `merged`, `deploying`,
 *   `deploy-failed` or `no-deploy-seen`. `unread` is whether that is for
 *   want of a read: its staging Deployments, or the Main checks of the
 *   commit on staging, could not be read, or the staging read given holds
 *   nothing of its merge.
 * - `untried`: on staging, needing a Staging trial, with no result.
 */
export type PromoteResult =
  | { readonly is: "untried" }
  | { readonly is: "accepted"; readonly at: string; readonly fix: readonly number[] | null; readonly problems: readonly PromoteProblem[] }
  | { readonly is: "problem"; readonly at: string; readonly problems: readonly PromoteProblem[] }
  | { readonly is: "no-screen" }
  | { readonly is: "not-on-staging"; readonly name: (typeof NOT_ON_STAGING)[number]; readonly unread: boolean };

/**
 * One Product repo's promote list at `now`, ISO 8601, from a gather's
 * `facts` and what a reader read of staging (`staging`, as rowsOf takes it;
 * null, every staging deploy is unread). Null for a repo whose Kit config
 * declares no `staging`, for one whose Kit config is invalid, and for the
 * store's facts.
 *
 * It holds what the gather kept since its start (Facts' `staging`): the
 * agent pull requests production has not taken and the Plain ones merged to
 * the default branch, newest first, which are the 100 most recent of either
 * kind by the gather's own cap (MERGES_KEPT), with the number left out. An agent entry's trial result is its Standing at Staging's, for
 * these facts and this read, read at `now`: the one the rule gives a row,
 * whether or not that Standing still stands and whether or not a production
 * Deployment has started on it.
 *
 * Only an entry that needs a Staging trial and has no result turns on the
 * staging read, and such a pull request has a row at Staging until
 * production takes it, so the read a reader makes for its rows
 * (stagingMergesToRead, commitsToCheck) is the read this wants. Once a
 * production Deployment has started on one, its row is at Production and
 * those ask no more about it: where the read given then holds nothing of its
 * merge, its entry says not yet on staging, unread.
 */
export function promoteListOf(facts: Facts | StoreFacts, staging: StagingRead | null, now: string): PromoteList | null {
  if (facts.kind === "store" || !facts.kit.config.ok || facts.kit.config.config.staging === null) return null;
  const { repo } = facts.kit;
  const since = facts.staging?.since ?? null;
  const problems = facts.staging?.trials.problems ?? [];
  const standings = new Map(stagingStandingsOf(ruleFactsOf(facts, "unread", {}, null, staging)).map((standing) => [standing.pullRequest, standing]));
  const agent = (facts.staging?.unpromoted ?? []).flatMap((merge): PromoteAgentEntry[] => {
    const standing = standings.get(merge.number);
    const tryIt = stagingOf(facts, merge.number);
    if (standing === undefined || tryIt === null) return [];
    return [
      {
        is: "agent",
        pullRequest: merge.number,
        title: merge.title,
        ticket: merge.ticket,
        mergedAt: merge.mergedAt,
        evidence: evidenceOf(facts, merge.number),
        shots: shotsOf(facts, merge.number, true),
        staging: tryIt,
        trial: standing.detail.staging.trial,
        result: resultOf(standing, problems, now),
      },
    ];
  });
  const plain = (facts.staging?.plain ?? []).map((merge) => plainEntryOf(merge, facts));
  // The gather's own cap: all of what a gather kept, and no more of facts built any other way.
  const entries = [...agent, ...plain].toSorted((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt) || b.pullRequest - a.pullRequest).slice(0, MERGES_KEPT);
  return {
    repo,
    start: since === null ? null : { from: since.from, deployment: since.deployment, commit: since.commit, deployedAt: since.deployedAt },
    entries,
    notAccepted: entries.filter((entry) => entry.is === "agent" && entry.trial.needed && entry.result.is !== "accepted").length,
    leftOut: Math.max(0, (facts.staging?.mergedSince ?? 0) - entries.length),
    dispatchPage: productionDispatchPage(repo, facts.kit.config.config.production),
  };
}

/** A Plain pull request's entry: its kind told as the Standing tells an open one's, any bot's login taken for the Fabrik App's where the reader gave the gather none. */
function plainEntryOf({ number, title, mergedAt, author, headRef, closes }: MergedPlainFacts, { operator, appLogin }: Facts): PromotePlainEntry {
  return { is: "plain", pullRequest: number, title, mergedAt, kind: plainKindOf({ author, headRef, closes }, operator, appLogin ?? ANY_BOT) };
}

/**
 * What a Standing at Staging says of its pull request's Staging trial, read
 * at `now`: its result where it has one, which names it whatever its deploys
 * say; else that it changes no screen, which its Standing says under every
 * name and no deploy changes; else its name where it is not on staging yet;
 * else, on staging, that it is untried. `problems` gives each Trial problem
 * its title.
 */
function resultOf(standing: StagingStanding, problems: readonly TrialProblemFacts[], now: string): PromoteResult {
  const { trial, result, checksUnread } = standing.detail.staging;
  if (result !== null) {
    const named = result.problems.map(({ issue, open }) => ({ issue, title: problems.find((problem) => problem.issue === issue)?.title ?? "", open }));
    return result.is === "accepted" ? { is: "accepted", at: result.at, fix: result.fix, problems: named } : { is: "problem", at: result.at, problems: named };
  }
  if (!trial.needed) return { is: "no-screen" };
  // A merge no staging deploy has started for turns no deploy seen with the time alone.
  const { name } = standingAt(standing, now);
  const waiting = NOT_ON_STAGING.find((notYet) => notYet === name);
  return waiting === undefined ? { is: "untried" } : { is: "not-on-staging", name: waiting, unread: standing.detail.deploysUnread || checksUnread };
}
