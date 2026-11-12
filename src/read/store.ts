// The store's rows (#620): the factory's own work, beside the Run records, as
// rows. The Standing rule for the store is Spec: Standing's
// (src/kit/standingStore.ts), which reads a few facts of the store's: its
// Weekly summary issues, its open "Weekly summary failed" issues and its open
// `ready-for-human` issues. This module reads those facts from GitHub and
// works the rows out of them by that rule, each with its title and the Fabrik
// App's last word, as a Product repo's row carries them (./rows.ts). No
// history, no Run record and no transcript is read here.
import type { Standing } from "../kit/standing.ts";
import { storeStandingsOf, type WeeklySummaryIssueFacts } from "../kit/standingStore.ts";
import type { OpenIssueFacts } from "../kit/weeklySummary.ts";
import { isHeldLine } from "../loop/heldLine.ts";
import { bareRowOf, type Row } from "./rows.ts";

/** A comment of the Fabrik App's, as a row's last word gives it. */
export interface StoreCommentFacts {
  readonly body: string;
  /** ISO 8601. */
  readonly at: string;
  readonly url: string;
}

/** A Weekly summary issue in the store, open or closed, with its title and a link to each of the Fabrik App's comments. */
export interface StoreSummaryFacts extends WeeklySummaryIssueFacts {
  readonly title: string;
  /** The Fabrik App's comments on it, oldest first. */
  readonly appComments: readonly StoreCommentFacts[];
}

/** An open "Weekly summary failed" issue: filed by a failed run when there was no summary to comment on. */
export interface StoreFailedSummaryFacts {
  readonly number: number;
  readonly title: string;
  /** ISO 8601. */
  readonly createdAt: string;
  /** The Fabrik App's comments on it, oldest first. */
  readonly appComments: readonly StoreCommentFacts[];
}

/**
 * What a gather reads of the store: the facts the store's Standing rule reads,
 * with the titles and the Fabrik App's comments a row shows beside each.
 * Plain data: written as JSON and read back they are equal.
 */
export interface StoreFacts {
  readonly kind: "store";
  /** The Fabrik App's bot login, or null when the reader gave none: any bot's text is then taken for the App's. */
  readonly appLogin: string | null;
  /** Its Weekly summary issues, open or closed, newest first. */
  readonly summaries: readonly StoreSummaryFacts[];
  /** Its open "Weekly summary failed" issues. */
  readonly failedSummaryIssues: readonly StoreFailedSummaryFacts[];
  /** Its open `ready-for-human` issues, such as the Dead-tick issue filed for a Product repo the Fabrik App can no longer reach. */
  readonly readyForHuman: readonly OpenIssueFacts[];
}

/** The store's rows at `now`, ISO 8601: one for each Standing the store's rule gives, in its order. */
export function storeRowsOf(facts: StoreFacts, now: string): Row[] {
  return storeStandingsOf(facts, now).map((standing) => bareRowOf(standing, titleOf(standing, facts), lastWordOf(standing, facts)));
}

/** The title of the Standing's issue. */
function titleOf({ issue }: Standing, { summaries, failedSummaryIssues, readyForHuman }: StoreFacts): string {
  return [...summaries, ...failedSummaryIssues, ...readyForHuman].find(({ number }) => number === issue)?.title ?? "";
}

/** The Fabrik App's latest comment on the Standing's issue, a held line never; any bot's when the App's login is not known. */
function lastWordOf({ issue }: Standing, { appLogin, summaries, failedSummaryIssues, readyForHuman }: StoreFacts): Row["lastWord"] {
  const own = [...summaries, ...failedSummaryIssues].find(({ number }) => number === issue)?.appComments;
  const comments: readonly StoreCommentFacts[] =
    own ??
    (readyForHuman.find(({ number }) => number === issue)?.comments ?? [])
      .filter(({ author, byBot }) => (appLogin === null ? byBot : author === appLogin))
      .map(({ body, at, url }) => ({ body, at, url }));
  const latest = comments
    .filter(({ body }) => !isHeldLine(body))
    .reduce<StoreCommentFacts | null>((newest, comment) => (newest === null || Date.parse(comment.at) >= Date.parse(newest.at) ? comment : newest), null);
  return latest === null ? null : { text: latest.body, at: latest.at, url: latest.url };
}
