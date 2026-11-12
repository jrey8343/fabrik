// The Standings of the factory's own work (src/kit/standing.ts): what the
// store beside the Run records holds for the Operator. Its open Weekly summary
// to read, and a ready-for-human issue there, such as one filed for a Product
// repo the Fabrik App can no longer reach. Built from a few facts of the
// store's own, which this module shapes; reading them from GitHub is the read
// library's. The Weekly summary never lists these: it does not list itself.
import { RUN_STORE_REPO } from "./runStore.ts";
import { type Standing, STANDING_SCHEMA, type StandingNamed } from "./standing.ts";
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

/** The store's Standings at `now`, oldest first, each carrying the store as its repo. */
export function storeStandingsOf({ summaries }: StoreStandingFacts, _now: string): Standing[] {
  return summaries.filter(({ open }) => open).map((summary) => openSummaryStandingOf(summary));
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
