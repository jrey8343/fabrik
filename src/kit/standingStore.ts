// The Standings of the factory's own work (src/kit/standing.ts): what the
// store beside the Run records holds for the Operator. Its open Weekly summary
// to read, a failed Weekly summary run to re-run, and a ready-for-human issue
// there, such as one filed for a Product repo the Fabrik App can no longer
// reach. Built from a few facts of the
// store's own, which this module shapes; reading them from GitHub is the read
// library's. The Weekly summary never lists these: it does not list itself.
import { RUN_STORE_REPO } from "./runStore.ts";
import { type Standing, STANDING_SCHEMA, type StandingNamed } from "./standing.ts";
import { readyForHumanStandingOf } from "./standingOperator.ts";
import { isWeeklyFailureNotice } from "./weeklyMarks.ts";
import type { OpenIssueFacts } from "./weeklySummary.ts";

/** A Weekly summary issue in the store, open or closed. */
export interface WeeklySummaryIssueFacts {
  readonly number: number;
  readonly open: boolean;
  /** When its body was last written, by its filing or a re-run that updated it, ISO 8601. */
  readonly bodyWrittenAt: string;
  /** The Fabrik App's comments on it, oldest first. */
  readonly appComments: readonly { readonly body: string; readonly at: string }[];
}

/** What the Standing rule reads of the store. */
export interface StoreStandingFacts {
  readonly kind: "store";
  /** Its Weekly summary issues, open or closed, newest first. */
  readonly summaries: readonly WeeklySummaryIssueFacts[];
  /** Its open "Weekly summary failed" issues, filed by a failed run when there was no summary to comment on. */
  readonly failedSummaryIssues: readonly { readonly number: number; readonly createdAt: string }[];
  /** Its open `ready-for-human` issues. */
  readonly readyForHuman: readonly OpenIssueFacts[];
}

/** The store's Standings at `now`, oldest first, each carrying the store as its repo: one per issue, a failed run before what is to read. */
export function storeStandingsOf({ summaries, failedSummaryIssues, readyForHuman }: StoreStandingFacts, now: string): Standing[] {
  const candidates: Standing[] = [
    ...failedOnSummaryOf(summaries),
    // Filed when there was no summary to comment on, it stands until it is closed.
    ...failedSummaryIssues.map(({ number, createdAt }) => failedRunStandingOf(number, createdAt)),
    // As one stands in a Product repo.
    ...readyForHuman.map((issue) => readyForHumanStandingOf(issue, RUN_STORE_REPO, now)),
    ...summaries.filter(({ open }) => open).map(openSummaryStandingOf),
  ];
  return candidates
    .filter((standing, at) => candidates.findIndex(({ issue }) => issue === standing.issue) === at)
    .toSorted((a, b) => Date.parse(a.since) - Date.parse(b.since) || (a.issue ?? 0) - (b.issue ?? 0));
}

/**
 * A failed Weekly summary run that commented on the newest summary, open or
 * closed: the Operator's to do, not stopping work since nothing waits on it,
 * while its notice is the Fabrik App's last comment there and the summary's
 * body has not been written since, as a re-run that succeeded writes it.
 */
function failedOnSummaryOf([newest]: readonly WeeklySummaryIssueFacts[]): StandingNamed<"yours-to-do">[] {
  const last = newest?.appComments.at(-1);
  if (newest === undefined || last === undefined || !isWeeklyFailureNotice(last.body) || Date.parse(newest.bodyWrittenAt) > Date.parse(last.at)) return [];
  return [failedRunStandingOf(newest.number, last.at)];
}

/** A failed Weekly summary run, on the issue its notice is on, since the notice. */
function failedRunStandingOf(issue: number, since: string): StandingNamed<"yours-to-do"> {
  return {
    ...theOperators(issue, since),
    stopsWork: false,
    work: "weekly-summary",
    name: "yours-to-do",
    detail: { handBack: "weekly-summary-failed", role: null, failure: null, label: null },
  };
}

/** The open Weekly summary: the Operator's to read, never stopping work, since its body was written. */
function openSummaryStandingOf({ number, bodyWrittenAt }: WeeklySummaryIssueFacts): StandingNamed<"yours-to-read"> {
  return { ...theOperators(number, bodyWrittenAt), stopsWork: false, work: "weekly-summary", name: "yours-to-read", detail: { map: null, decisions: [] } };
}

/** The fields of a store Standing whose move is the Operator's and stops work, with no place on the Loop. */
function theOperators(issue: number, since: string) {
  return {
    schema: STANDING_SCHEMA,
    repo: RUN_STORE_REPO,
    issue,
    pullRequest: null,
    place: null,
    move: "operator",
    yours: true,
    stopsWork: true,
    since,
    stuckAt: null,
    awaits: null,
    subscription: null,
  } as const;
}
